/**
 * Org-hierarchy-sync — grant expansion (PLAN P2).
 *
 * DESIGN.md §6: sharing an asset to a groupy node precomputes access into
 * kernel ACL rows (users + their agents) + flips visibility to restricted.
 * Home-team members are always included; archived nodes auto-revoke on the
 * nightly recompute. Groupy-shared assets are sync-owned: recompute rewrites
 * the derived row set (manual rows added mid-share are not preserved).
 */

import type { MetadataService } from "../service/metadata-service.js";
import { MetadataError } from "../service/metadata-service.js";
import type { V3AuthContext } from "../router/auth.js";
import { ensureGroupyUser, GROUPY_SYNC_OWNER_USERNAME } from "./sync-service.js";
import { computeMembershipClosure, subtreeNodeIds, type GroupyGraphSnapshot } from "./closure.js";
import type { AclEntity, AssetEntity } from "../types.js";

export interface ShareTargets {
  userIds: Set<string>;
  agentIds: Set<string>;
}

export interface AssetShareRequest {
  asset_id: string;
  node_id: string;
  action: "grant" | "revoke";
  ctx: V3AuthContext;
}

export interface AssetShareResult {
  asset_id: string;
  visibility: string;
  nodes: string[];
  /** Subtree teams affected by this action (mirror target for the KS rows). */
  teams: string[];
  users: number;
  agents: number;
}

/** Rebuild the snapshot graph from persisted nodes+edges (instant path input). */
export async function buildGraphFromStore(service: MetadataService): Promise<GroupyGraphSnapshot> {
  const store = service.rawStore;
  const graph: GroupyGraphSnapshot = new Map();
  for (const n of await store.listGroupyNodes(true)) {
    graph.set(n.node_id, { id: n.node_id, name: n.name, display_name: n.display_name, members: [] });
  }
  for (const e of await store.listGroupyEdges()) {
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
        if (m.user_id !== syncOwnerId) userIds.add(m.user_id);
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

function desiredRowKeys(targets: ShareTargets): Set<string> {
  const keys = new Set<string>();
  for (const u of targets.userIds) keys.add(`user:${u}:read`);
  for (const a of targets.agentIds) {
    keys.add(`agent:${a}:read`);
    keys.add(`agent:${a}:use`);
  }
  return keys;
}

function rowKey(r: AclEntity): string {
  return `${r.subject_type}:${r.subject_id}:${r.permission}`;
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
  const desired = desiredRowKeys(targets);
  const existing = await allAssetAcl(service, assetId);
  for (const row of existing) {
    if (row.effect === "allow" && !desired.has(rowKey(row))) {
      await service.rawStore.revokeAcl(row.id);
    }
  }
  const kept = new Set(
    existing.filter((r) => r.effect === "allow" && desired.has(rowKey(r))).map(rowKey),
  );
  for (const key of desired) {
    if (kept.has(key)) continue;
    const [subjectType, subjectId, permission] = key.split(":");
    await service.grantAcl({
      asset_id: assetId,
      subject_type: subjectType as "user" | "agent",
      subject_id: subjectId,
      permission: permission as "read" | "use",
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

/** Instant share/revoke path (PLAN P2 + kernel asset-grant route). */
export async function applyAssetShare(
  service: MetadataService,
  req: AssetShareRequest,
): Promise<AssetShareResult> {
  const asset = await service.getAssetById(req.asset_id);
  if (!asset) throw new MetadataError("asset_not_found", `asset not found: ${req.asset_id}`);
  const caller = await assertCanShare(service, asset, req.ctx);
  const store = service.rawStore;
  const graph = await buildGraphFromStore(service);
  if (!graph.has(req.node_id)) {
    throw new MetadataError("groupy_node_not_found", `groupy node not found: ${req.node_id}`);
  }
  const archived = new Set(
    (await store.listGroupyNodes(true)).filter((n) => n.archived).map((n) => n.node_id),
  );
  const share = await store.getGroupyShare(req.asset_id);
  let nodes: string[];
  if (req.action === "grant") {
    if (archived.has(req.node_id)) {
      throw new MetadataError("groupy_node_archived", `groupy node archived: ${req.node_id}`);
    }
    nodes = [...new Set([...(share?.node_ids ?? []), req.node_id])]
      .filter((n) => graph.has(n) && !archived.has(n));
  } else {
    nodes = (share?.node_ids ?? []).filter((n) => n !== req.node_id);
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
  const subtree = new Set<string>();
  for (const n of nodes) {
    for (const t of subtreeNodeIds(graph, n)) subtree.add(t);
  }
  const targets = await expandShareTargets(service, closure, subtree, asset.team_id);
  await includeAssetOwner(service, targets, asset.owner_user_id);
  await rewriteAcl(service, asset.asset_id, targets, caller);
  let visibility = asset.visibility;
  if (nodes.length > 0) {
    visibility = "restricted";
    await store.upsertGroupyShare({
      asset_id: asset.asset_id,
      node_ids: nodes,
      prev_visibility: share?.prev_visibility ?? asset.visibility,
    });
  } else {
    await store.deleteGroupyShare(asset.asset_id);
    visibility = share?.prev_visibility ?? "team";
  }
  if (visibility !== asset.visibility) {
    await service.updateAsset(asset.asset_id, { visibility });
  }
  return {
    asset_id: asset.asset_id, visibility, nodes, teams: [...affected],
    users: targets.userIds.size, agents: targets.agentIds.size,
  };
}

export interface RecomputeInput {
  service: MetadataService;
  graph: GroupyGraphSnapshot;
  closure: Map<string, Set<string>>;
  archivedNodes: string[];
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
      await store.upsertGroupyShare({
        asset_id: share.asset_id, node_ids: live, prev_visibility: share.prev_visibility,
      });
    }
  }
  return { revokedGrants: revoked };
}
