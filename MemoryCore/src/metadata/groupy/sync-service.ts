/**
 * Org-hierarchy-sync — nightly/manual sync engine.
 *
 * DESIGN.md §5: fetch → closure → diff → apply (teams/members/users) +
 * run persistence. Idempotent and re-runnable: re-running against an
 * unchanged graph produces zero writes (apart from the run row itself).
 *
 * Identity assumption (DESIGN §13 open fact): a groupy user member id doubles
 * as the memory username for first-time reconcile; GroupyUserMap preserves an
 * explicit binding afterwards so later renames do not fork identities.
 */

import type { MetadataService } from "../service/metadata-service.js";
import { DEFAULT_AUTH_PROVIDER } from "../constants.js";
import { GroupyClient, walkGroupyGraph } from "./groupy-client.js";
import { computeMembershipClosure, type GroupyGraphSnapshot } from "./closure.js";
import type { GroupyEdgeEntity } from "../types.js";

/** Owner of mirrored teams; membership row auto-added by createTeam is removed. */
export const GROUPY_SYNC_OWNER_USERNAME = "groupy-sync";
/** Team description marker for groupy-managed teams. */
export const MANAGED_BY_GROUPY_MARKER = "managed by groupy";
/** DESIGN §8: 3 retries, 30 min apart. */
export const DEFAULT_GROUPY_RETRY_DELAYS_MS = [30 * 60 * 1000, 30 * 60 * 1000, 30 * 60 * 1000];

export interface SyncLogger {
  debug?(msg: string): void;
  info?(msg: string): void;
  warn?(msg: string): void;
  error?(msg: string): void;
}

export interface GroupySyncOptions {
  client: GroupyClient;
  roots: string[];
  service: MetadataService;
  logger?: SyncLogger;
  /** Override retry delays (attempts = 1 + delays.length). Test hook. */
  retryDelaysMs?: number[];
  /** Test hook. */
  sleep?: (ms: number) => Promise<void>;
  /** P2 seam: grant recompute after membership apply (see GroupyPostApplyContext). */
  onMembershipApplied?: (ctx: GroupyPostApplyContext) => Promise<GroupyPostApplyResult>;
}

/** P2 seam: after membership apply, recompute groupy-derived grants. */
export interface GroupyPostApplyContext {
  service: MetadataService;
  graph: GroupyGraphSnapshot;
  closure: Map<string, Set<string>>;
  archivedNodes: string[];
}

export interface GroupyPostApplyResult {
  revokedGrants?: string[];
}

export interface GroupySyncSummary {
  run_id: string;
  status: "ok" | "failed";
  started_at: string;
  finished_at: string;
  nodes_seen: number;
  members_seen: number;
  teams_created: number;
  teams_archived: number;
  members_added: number;
  members_removed: number;
  users_created: number;
  archived_nodes: string[];
  /** Node ids whose archived state revoked grant contributions (P2 fills). */
  revoked_grants: string[];
  error?: string;
}

const noopLogger: SyncLogger = {};
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function nowIso(): string {
  return new Date().toISOString();
}

export async function runGroupySync(opts: GroupySyncOptions): Promise<GroupySyncSummary> {
  const logger = opts.logger ?? noopLogger;
  const delays = opts.retryDelaysMs ?? DEFAULT_GROUPY_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const store = opts.service.rawStore;
  const startedAt = nowIso();

  const zeroCounts = {
    teams_created: 0, teams_archived: 0, members_added: 0,
    members_removed: 0, users_created: 0,
  };

  // ── fetch (fail closed: retries, then failed run, last-good retained) ──
  let graph: GroupyGraphSnapshot | undefined;
  let lastError: unknown;
  for (let attempt = 0; ; attempt += 1) {
    try {
      graph = await walkGroupyGraph(opts.client, opts.roots);
      break;
    } catch (err) {
      lastError = err;
      if (attempt >= delays.length) break;
      logger.warn?.(`[groupy-sync] fetch attempt ${attempt + 1} failed, retrying`);
      await sleep(delays[attempt]);
    }
  }
  if (!graph) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    const prev = await store.getLatestGroupyRun();
    const run = await store.recordGroupyRun({
      started_at: startedAt, finished_at: nowIso(), status: "failed",
      nodes_seen: 0, members_seen: 0, error: message,
      snapshot_json: prev?.snapshot_json ?? "{}",
    });
    logger.error?.(`[groupy-sync] run ${run.id} failed: ${message}`);
    return {
      run_id: run.id, status: "failed", started_at: startedAt, finished_at: nowIso(),
      nodes_seen: 0, members_seen: 0, ...zeroCounts, archived_nodes: [], revoked_grants: [], error: message,
    };
  }

  // ── closure ──
  const closure = computeMembershipClosure(graph);
  const personIds = [...closure.keys()];

  // ── users (owner first) ──
  let usersCreated = 0;
  const syncOwner = await ensureGroupyUser(opts.service, GROUPY_SYNC_OWNER_USERNAME);
  usersCreated += syncOwner.created ? 1 : 0;
  const userByPerson = new Map<string, string>();
  for (const personId of personIds) {
    const ensured = await ensureGroupyUser(opts.service, personId);
    userByPerson.set(personId, ensured.userId);
    usersCreated += ensured.created ? 1 : 0;
  }

  // ── teams: diff vs last snapshot ──
  let teamsCreated = 0;
  let teamsArchived = 0;
  const archivedNodes: string[] = [];
  const prevNodes = await store.listGroupyNodes(true);
  const prevById = new Map(prevNodes.map((n) => [n.node_id, n]));
  for (const [nodeId, snapshot] of graph) {
    const displayName = snapshot.display_name || snapshot.name || nodeId;
    const description = `${MANAGED_BY_GROUPY_MARKER}: node ${nodeId}`;
    await store.upsertGroupyNode({
      node_id: nodeId, name: snapshot.name || nodeId,
      display_name: displayName, kind: "org", archived: false,
    });
    const team = await opts.service.getTeamById(nodeId);
    if (!team) {
      await opts.service.createTeam({
        team_id: nodeId, name: displayName,
        description, owner_user_id: syncOwner.userId,
      });
      // createTeam auto-adds the owner as admin member; mirrored teams carry
      // only closure members, so drop that row immediately.
      await store.removeTeamMember(nodeId, syncOwner.userId);
      teamsCreated += 1;
    } else if (team.status === "archived" || team.name !== displayName || team.description !== description) {
      await opts.service.updateTeam(nodeId, { name: displayName, description, status: "active" });
    }
  }
  for (const prev of prevNodes) {
    if (prev.archived || !prevById.has(prev.node_id) || graph.has(prev.node_id)) continue;
    await store.upsertGroupyNode({ node_id: prev.node_id, name: prev.name, archived: true });
    const team = await opts.service.getTeamById(prev.node_id);
    // Content is never deleted: archive keeps the team + its assets, members
    // are flipped to removed by the membership pass below.
    if (team && team.status !== "archived") {
      await opts.service.updateTeam(prev.node_id, { status: "archived" });
    }
    archivedNodes.push(prev.node_id);
    teamsArchived += 1;
  }

  // ── membership: desired state per team ──
  const desiredByTeam = new Map<string, Set<string>>();
  for (const [personId, ancestors] of closure) {
    const userId = userByPerson.get(personId)!;
    for (const teamId of ancestors) {
      let set = desiredByTeam.get(teamId);
      if (!set) {
        set = new Set();
        desiredByTeam.set(teamId, set);
      }
      set.add(userId);
    }
  }
  let membersAdded = 0;
  for (const [teamId, userIds] of desiredByTeam) {
    for (const userId of userIds) {
      const cur = await store.getTeamMember(teamId, userId);
      if (!cur || cur.status !== "active") {
        await store.addTeamMember({ team_id: teamId, user_id: userId, role: "member", status: "active" });
        membersAdded += 1;
      }
    }
  }
  // Groupy owns mirrored-team membership outright: any active member outside
  // the closure (except the team owner row) flips to removed, audit-kept.
  let membersRemoved = 0;
  const managedTeamIds = new Set<string>([...prevById.keys(), ...graph.keys()]);
  for (const teamId of managedTeamIds) {
    const team = await opts.service.getTeamById(teamId);
    if (!team) continue;
    const desired = desiredByTeam.get(teamId) ?? new Set<string>();
    let offset = 0;
    const limit = 200;
    for (;;) {
      const page = await store.listTeamMembers(teamId, { limit, offset });
      for (const m of page.items) {
        if (m.user_id === team.owner_user_id || desired.has(m.user_id)) continue;
        await store.addTeamMember({
          team_id: teamId, user_id: m.user_id, role: m.role, status: "removed",
        });
        membersRemoved += 1;
      }
      if (offset + page.items.length >= page.total) break;
      offset += page.items.length;
    }
  }

  // ── post-apply hook (P2 grant recompute plugs in here) ──
  let revokedGrants: string[] = [];
  if (opts.onMembershipApplied) {
    const result = await opts.onMembershipApplied({
      service: opts.service, graph, closure, archivedNodes,
    });
    revokedGrants = result.revokedGrants ?? [];
  }

  // ── edges snapshot (nodes+edges feed the /tree endpoint) ──
  const edges: GroupyEdgeEntity[] = [];
  for (const snapshot of graph.values()) {
    for (const m of snapshot.members) {
      edges.push({ parent_id: snapshot.id, child_id: m.id, child_kind: m.kind });
    }
  }
  await store.replaceGroupyEdges(edges);

  // ── run row ──
  const snapshotJson = JSON.stringify({ version: 1, nodes: [...graph.values()] });
  const run = await store.recordGroupyRun({
    started_at: startedAt, finished_at: nowIso(), status: "ok",
    nodes_seen: graph.size, members_seen: personIds.length, snapshot_json: snapshotJson,
  });
  logger.info?.(
    `[groupy-sync] run ${run.id} ok: ${graph.size} nodes, ${personIds.length} members, ` +
    `+${teamsCreated}/arch${teamsArchived} teams, +${membersAdded}/-${membersRemoved} members`,
  );
  return {
    run_id: run.id, status: "ok", started_at: startedAt, finished_at: nowIso(),
    nodes_seen: graph.size, members_seen: personIds.length,
    teams_created: teamsCreated, teams_archived: teamsArchived,
    members_added: membersAdded, members_removed: membersRemoved,
    users_created: usersCreated, archived_nodes: archivedNodes, revoked_grants: revokedGrants,
  };
}

/**
 * Reconcile one groupy id to a memory user: explicit map binding wins, then
 * username lookup (covers SSO-created accounts), else auto-create flagged
 * with source=groupy in metadata_json.
 */
export async function ensureGroupyUser(
  service: MetadataService,
  groupyId: string,
): Promise<{ userId: string; created: boolean }> {
  const store = service.rawStore;
  const mapped = await store.getGroupyUserMap(groupyId);
  if (mapped?.memory_user_id) {
    const existing = await service.getUserById(mapped.memory_user_id);
    if (existing) return { userId: existing.user_id, created: false };
  }
  const username = mapped?.username ?? groupyId;
  const listed = await store.listUsers({ limit: 1, offset: 0 }, { username });
  const hit = listed.items.find((u) => u.auth_provider === DEFAULT_AUTH_PROVIDER) ?? listed.items[0];
  if (hit) {
    await store.upsertGroupyUserMap({ groupy_id: groupyId, username: hit.username, memory_user_id: hit.user_id });
    return { userId: hit.user_id, created: false };
  }
  const created = await service.createNormalUser({
    username,
    metadata_json: JSON.stringify({ source: "groupy", groupy_id: groupyId }),
  });
  await store.upsertGroupyUserMap({ groupy_id: groupyId, username, memory_user_id: created.user_id });
  return { userId: created.user_id, created: true };
}
