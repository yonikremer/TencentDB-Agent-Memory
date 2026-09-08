/**
 * Org-hierarchy-sync — grant expansion (PLAN P2).
 *
 * DESIGN.md §6: sharing an asset to a groupy node precomputes access into
 * kernel ACL rows (users + their agents) + flips visibility to restricted.
 * Home-team members are always included; archived nodes auto-revoke on the
 * nightly recompute. Groupy-shared assets are sync-owned: recompute rewrites
 * the derived row set (manual rows added mid-share are not preserved).
 *
 * grant_type (viewer|editor|owner, default viewer) is a KS-level concept:
 * the kernel stores it per shared node so the Panel KS mirror (and the
 * nightly mirror-sync) carries the same type end to end. Kernel ACL rows
 * themselves are always read (users) / read+use (agents).
 */

import type { MetadataService } from "../service/metadata-service.js";
import { MetadataError } from "../service/metadata-service.js";
import type { V3AuthContext } from "../router/auth.js";
import { ensureGroupyUser, GROUPY_SYNC_OWNER_USERNAME } from "./sync-service.js";
import { computeMembershipClosure, subtreeNodeIds, type GroupyGraphSnapshot } from "./closure.js";
import type { AclEntity, AssetEntity } from "../types.js";

/** Fail-safe default: shares larger than this are a misconfigured node. */
export const MAX_SHARE_TEAMS = 1000;

export const GRANT_TYPES = ["viewer", "editor", "owner"] as const;
export type ShareGrantType = (typeof GRANT_TYPES)[number];

export interface ShareTargets {
  userIds: Set<string>;
  agentIds: Set<string>;
}

export interface AssetShareRequest {
  asset_id: string;
  node_id: string;
  action: "grant" | "revoke";
  ctx: V3AuthContext;
  /** KS capability carried end to end (default viewer). */
  grant_type?: string;
  /** Test seam; production cap guards org-wide fan-out per share. */
  maxTeams?: number;
}

export interface AssetShareResult {
  asset_id: string;
  visibility: string;
  nodes: string[];
  /** Subtree teams affected by this action (mirror target for the KS rows). */
  teams: string[];
  /** Effective KS capability for the acted node. */
  grant_type: ShareGrantType;
  users: number;
  agents: number;
}

/**
 * Rebuild the snapshot graph from persisted nodes+edges (instant path input).
 * Archived nodes are excluded entirely: granting to a parent must not expand
 * into archived children (ACL rows or mirror teams).
 */
export async function buildGraphFromStore(service: MetadataService): Promise<GroupyGraphSnapshot> {
  const store = service.rawStore;
  const graph: GroupyGraphSnapshot = new Map();
  const live = new Set<string>();
  for (const n of await store.listGroupyNodes(true)) {
    if (n.archived) continue;
    live.add(n.node_id);
    graph.set(n.node_id, { id: n.node_id, name: n.name, display_name: n.display_name, members: [] });
  }
  for (const e of await store.listGroupyEdges()) {
    if (!live.has(e.parent_id)) continue;
    if (e.child_kind === "org" && !live.has(e.child_id)) continue;
    graph.get(e.parent_id)?.members.push({ id: e.child_id, kind: e.child_kind });
  }
  return graph;
}

/** The asset owner always keeps access, even outside the home team. */
async function includeAssetOwner(
  service: MetadataService,
  targets: ShareTargets,
  ownerUserId: string,
): Promise<void> {
  targets.userIds.add(ownerUserId);
  await activeUserAgents(service, ownerUserId, targets.agentIds);
}

async function activeUserAgents(service: MetadataService, userId: string, into: Set<string>): Promise<void> {
  let offset = 0;
  const limit = 100;
  for (;;) {
    const page = await service.listAgentsByOwner(userId, { limit, offset });
    for (const a of page.items) {
      if (a.status === "active") into.add(a.agent_id);
    }
    if (offset + page.items.length >= page.total) break;
    offset += page.items.length;
  }
}

/**
 * Expansion set for a subtree-team set: closure users under it + every such
 * user's active agents, plus the home team (owner + active members + agents).
 */
export async function expandShareTargets(
  service: MetadataService,
  closure: Map<string, Set<string>>,
  subtreeTeams: Set<string>,
  homeTeamId: string,
): Promise<ShareTargets> {
  const userIds = new Set<string>();
  const syncOwnerHit = await service.rawStore.listUsers(
    { limit: 1, offset: 0 }, { username: GROUPY_SYNC_OWNER_USERNAME },
  );
  const syncOwnerId = syncOwnerHit.items[0]?.user_id;
  for (const [personId, ancestors] of closure) {
    for (const t of ancestors) {
      if (subtreeTeams.has(t)) {
        userIds.add((await ensureGroupyUser(service, personId)).userId);
        break;
      }
    }
  }
  const home = await service.getTeamById(homeTeamId);
  if (home) {
    // Mirrored teams are bookkeeping-owned by the sync pseudo-user: it must
    // never gain read rows. (The ASSET owner is added by the caller.)
    if (home.owner_user_id !== syncOwnerId) userIds.add(home.owner_user_id);
    let offset = 0;
    const limit = 200;
    for (;;) {
      const page = await service.rawStore.listTeamMembers(homeTeamId, { limit, offset });
      for (const m of page.items) {
        // Backend-agnostic: only active memberships expand (removed rows stay out).
        if (m.status !== "active" || m.user_id === syncOwnerId) continue;
        userIds.add(m.user_id);
      }
      if (offset + page.items.length >= page.total) break;
      offset += page.items.length;
    }
  }
  const agentIds = new Set<string>();
  for (const userId of userIds) {
    await activeUserAgents(service, userId, agentIds);
  }
  return { userIds, agentIds };
}

interface DesiredAclRow {
  subject_type: "user" | "agent";
  subject_id: string;
  permission: "read" | "use";
}

function desiredRows(targets: ShareTargets): DesiredAclRow[] {
  const rows: DesiredAclRow[] = [];
  for (const u of targets.userIds) rows.push({ subject_type: "user", subject_id: u, permission: "read" });
  for (const a of targets.agentIds) {
    rows.push({ subject_type: "agent", subject_id: a, permission: "read" });
    rows.push({ subject_type: "agent", subject_id: a, permission: "use" });
  }
  return rows;
}

function sameRow(want: DesiredAclRow, r: AclEntity): boolean {
  return (
    r.effect === "allow" &&
    r.subject_type === want.subject_type &&
    r.subject_id === want.subject_id &&
    r.permission === want.permission
  );
}

async function allAssetAcl(service: MetadataService, assetId: string): Promise<AclEntity[]> {
  const out: AclEntity[] = [];
  let offset = 0;
  const limit = 200;
  for (;;) {
    const page = await service.rawStore.listAclByAsset(assetId, { limit, offset });
    out.push(...page.items);
    if (offset + page.items.length >= page.total) break;
    offset += page.items.length;
  }
  return out;
}

/** Diff-write the derived row set (quiet when unchanged). */
async function rewriteAcl(
  service: MetadataService,
  assetId: string,
  targets: ShareTargets,
  grantedBy: string,
): Promise<void> {
  const desired = desiredRows(targets);
  const existing = await allAssetAcl(service, assetId);
  for (const row of existing) {
    // Only sync-owned subject kinds are rewritten; team_role (manual) and any
    // other rows are preserved untouched.
    if (row.subject_type !== "user" && row.subject_type !== "agent") continue;
    if (row.effect === "allow" && !desired.some((w) => sameRow(w, row))) {
      await service.rawStore.revokeAcl(row.id);
    }
  }
  for (const want of desired) {
    if (existing.some((r) => sameRow(want, r))) continue;
    await service.grantAcl({
      asset_id: assetId,
      subject_type: want.subject_type,
      subject_id: want.subject_id,
      permission: want.permission,
      granted_by: grantedBy,
    });
  }
}

async function assertCanShare(service: MetadataService, asset: AssetEntity, ctx: V3AuthContext): Promise<string> {
  const caller = ctx.userId;
  if (!caller) throw new MetadataError("permission_denied", "share requires an authenticated caller");
  if (ctx.isSystemAdmin || asset.owner_user_id === caller) return caller;
  const team = await service.getTeamById(asset.team_id);
  const member = team ? await service.rawStore.getTeamMember(team.team_id, caller) : null;
  if (team && (team.owner_user_id === caller || member?.role === "admin")) return caller;
  throw new MetadataError("permission_denied", `share requires asset owner, home-team admin, or system admin`);
}

function resolveGrantType(raw: string | undefined): ShareGrantType {
  const value = raw ?? "viewer";
  if (!(GRANT_TYPES as readonly string[]).includes(value)) {
    throw new MetadataError("invalid_grant_type", `grant_type must be viewer|editor|owner: ${value}`);
  }
  return value as ShareGrantType;
}

/** Instant share/revoke path (PLAN P2 + kernel asset-grant route). */
export async function applyAssetShare(
  service: MetadataService,
  req: AssetShareRequest,
): Promise<AssetShareResult> {
  const asset = await service.getAssetById(req.asset_id);
  if (!asset) throw new MetadataError("asset_not_found", `asset not found: ${req.asset_id}`);
  const caller = await assertCanShare(service, asset, req.ctx);
  const grantType = resolveGrantType(req.grant_type);
  const store = service.rawStore;
  const archived = new Set(
    (await store.listGroupyNodes(true)).filter((n) => n.archived).map((n) => n.node_id),
  );
  if (req.action === "grant" && archived.has(req.node_id)) {
    throw new MetadataError("groupy_node_archived", `groupy node archived: ${req.node_id}`);
  }
  const graph = await buildGraphFromStore(service);
  if (!graph.has(req.node_id)) {
    throw new MetadataError("groupy_node_not_found", `groupy node not found: ${req.node_id}`);
  }
  const share = await store.getGroupyShare(req.asset_id);
  const storedTypes: Record<string, string> = { ...(share?.grant_types ?? {}) };
  let nodes: string[];
  if (req.action === "grant") {
    nodes = [...new Set([...(share?.node_ids ?? []), req.node_id])]
      .filter((n) => graph.has(n) && !archived.has(n));
    storedTypes[req.node_id] = grantType;
  } else {
    nodes = (share?.node_ids ?? []).filter((n) => n !== req.node_id);
    delete storedTypes[req.node_id];
  }
  const closure = computeMembershipClosure(graph);
  // Affected teams for the KS mirror: granted subtrees on grant, the dropped
  // node's subtree on revoke (nodes is empty after a full revoke).
  const affected = new Set<string>();
  if (req.action === "grant") {
    for (const n of nodes) {
      for (const t of subtreeNodeIds(graph, n)) affected.add(t);
    }
  } else {
    for (const t of subtreeNodeIds(graph, req.node_id)) affected.add(t);
  }
  const maxTeams = req.maxTeams ?? MAX_SHARE_TEAMS;
  if (affected.size > maxTeams) {
    throw new MetadataError(
      "groupy_subtree_too_large",
      `share subtree ${affected.size} teams exceeds limit ${maxTeams} for node ${req.node_id}`,
    );
  }
  const subtree = new Set<string>();
  for (const n of nodes) {
    for (const t of subtreeNodeIds(graph, n)) subtree.add(t);
  }
  const targets = await expandShareTargets(service, closure, subtree, asset.team_id);
  await includeAssetOwner(service, targets, asset.owner_user_id);
  await rewriteAcl(service, asset.asset_id, targets, caller);
  let visibility: AssetEntity["visibility"] = asset.visibility;
  if (nodes.length > 0) {
    visibility = "restricted";
    await store.upsertGroupyShare({
      asset_id: asset.asset_id,
      node_ids: nodes,
      grant_types: storedTypes,
      prev_visibility: share?.prev_visibility ?? asset.visibility,
    });
  } else {
    await store.deleteGroupyShare(asset.asset_id);
    visibility = (share?.prev_visibility ?? "team") as AssetEntity["visibility"];
  }
  if (visibility !== asset.visibility) {
    await service.updateAsset(asset.asset_id, { visibility });
  }
  return {
    asset_id: asset.asset_id, visibility, nodes, teams: [...affected], grant_type: grantType,
    users: targets.userIds.size, agents: targets.agentIds.size,
  };
}

export interface RecomputeInput {
  service: MetadataService;
  graph: GroupyGraphSnapshot;
  closure: Map<string, Set<string>>;
}

async function resolveSyncOwnerId(service: MetadataService, fallback: string): Promise<string> {
  const hit = await service.rawStore.listUsers({ limit: 1, offset: 0 }, { username: GROUPY_SYNC_OWNER_USERNAME });
  return hit.items[0]?.user_id ?? fallback;
}

/**
 * Nightly recompute (scheduler onMembershipApplied hook): heal membership
 * drift for every shared asset; drop archived/gone nodes; delete empty
 * shares restoring previous visibility. Returns revoked node ids.
 */
export async function recomputeGroupyShares(input: RecomputeInput): Promise<{ revokedGrants: string[] }> {
  const { service, graph, closure } = input;
  const store = service.rawStore;
  const archived = new Set(
    (await store.listGroupyNodes(true)).filter((n) => n.archived).map((n) => n.node_id),
  );
  const revoked: string[] = [];
  for (const share of await store.listGroupyShares()) {
    const asset = await service.getAssetById(share.asset_id);
    if (!asset) {
      await store.deleteGroupyShare(share.asset_id);
      continue;
    }
    const live = share.node_ids.filter((n) => graph.has(n) && !archived.has(n));
    for (const d of share.node_ids) {
      if (!live.includes(d) && !revoked.includes(d)) revoked.push(d);
    }
    const grantedBy = await resolveSyncOwnerId(service, asset.owner_user_id);
    const subtree = new Set<string>();
    for (const n of live) {
      for (const t of subtreeNodeIds(graph, n)) subtree.add(t);
    }
    const targets = await expandShareTargets(service, closure, subtree, asset.team_id);
    await includeAssetOwner(service, targets, asset.owner_user_id);
    await rewriteAcl(service, asset.asset_id, targets, grantedBy);
    if (live.length === 0) {
      await store.deleteGroupyShare(share.asset_id);
      if (asset.visibility !== share.prev_visibility) {
        await service.updateAsset(share.asset_id, { visibility: share.prev_visibility as AssetEntity["visibility"] });
      }
    } else if (live.length !== share.node_ids.length) {
      const grantTypes: Record<string, string> = {};
      for (const n of live) {
        if (share.grant_types?.[n]) grantTypes[n] = share.grant_types[n];
      }
      await store.upsertGroupyShare({
        asset_id: share.asset_id, node_ids: live, grant_types: grantTypes,
        prev_visibility: share.prev_visibility,
      });
    }
  }
  return { revokedGrants: revoked };
}
