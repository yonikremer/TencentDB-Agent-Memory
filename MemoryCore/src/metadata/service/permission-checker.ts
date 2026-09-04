/**
 * Permission checking pure functions.
 *
 * Corresponds to design doc §10.3 (checkPermission, three-stage: owner+scope+grant)
 * and §10.4 (canBindAsset, fixed asset binding validation).
 *
 * Design highlights:
 *   - Check sequence optimized as 'resource → owner → member → visibility → role default → ACL → deny',
 *     high-frequency scenarios (admin read-write / member read-only) pass at role default, no ACL table lookup needed.
 *   - Role default permissions are code-level hardcoded constants, no need to pre-configure data for roles.
 *   - Phase one allow-only model.
 */

import type { AssetEntity, TeamMemberEntity, AclEntity, Permission } from "../types.js";

export interface PermCheckLogger {
  debug: (msg: string) => void;
}

export interface PermCheckContext {
  user: { user_id: string };
  asset: AssetEntity | null;
  /** User's membership relationship under asset.team_id. */
  membership: TeamMemberEntity | null;
  action: Permission;
  /** All ACL records related to asset (lazy-loaded: provided by service only when reaching ACL step). */
  aclRecords: AclEntity[];
  /** Optional, passed when action='use' and caller is agent. */
  agentId?: string;
  logger?: PermCheckLogger;
}

export interface PermCheckResult {
  allowed: boolean;
  reason: string;
}

const ADMIN_ACTIONS: Permission[] = ["read", "write", "assign", "share"];
const MEMBER_ACTIONS: Permission[] = ["read"];

const noopLogger: PermCheckLogger = { debug: () => {} };

export function checkPermission(ctx: PermCheckContext): PermCheckResult {
  const { user, asset, membership, action, aclRecords, agentId } = ctx;
  const logger = ctx.logger ?? noopLogger;

  // 1. Resource doesn't exist/archived
  if (!asset || asset.status === "archived") {
    logger.debug(`[META] perm_check DENY: asset not found or archived`);
    return { allowed: false, reason: "asset_not_available" };
  }

  // 2. Owner has full permission
  if (asset.owner_user_id === user.user_id) {
    logger.debug(`[META] perm_check ALLOW: owner`);
    return { allowed: true, reason: "owner" };
  }

  // 3. Not a team member
  if (!membership || membership.status !== "active") {
    logger.debug(`[META] perm_check DENY: not team member`);
    return { allowed: false, reason: "not_team_member" };
  }

  // 4. visibility restriction
  switch (asset.visibility) {
    case "private":
      // Private semantics (2026-07 change): strictly private, only owner_user_id can access.
      // Team admin is not allowed either — because step 2 owner check already returned ALLOW,
      // reaching here means current user is not owner, uniformly denied even if admin.
      //
      // Semantics explanation:
      //   - private = personal private asset, no one in team can see (including admins)
      //   - team    = shared with entire team (team members can read, owner/admin can write)
      //   - restricted = strict ACL whitelist (handled in case below)
      //
      // Impact:
      //   - list-accessible doesn't return others' private assets (effective for admins too)
      //   - permission-checker.check returns DENY for admins accessing others' private assets
      //   - If admin really needs to view, owner must actively switch to team or authorize via acl/grant
      logger.debug(`[META] perm_check DENY: visibility=private, role=${membership.role}`);
      return { allowed: false, reason: "visibility_restricted" };
    case "restricted":
      if (membership.role !== "admin") {
        // Non-admin: skip role defaults, only explicit ACL can grant access
        const matched = aclRecords.find(
          (acl) =>
            acl.permission === action &&
            acl.effect === "allow" &&
            ((acl.subject_type === "user" && acl.subject_id === user.user_id) ||
              (acl.subject_type === "team_role" && acl.subject_id === membership.role) ||
              (acl.subject_type === "agent" && !!agentId && acl.subject_id === agentId)),
        );
        if (matched) {
          logger.debug(`[META] perm_check ALLOW: restricted + acl id=${matched.id}`);
          return { allowed: true, reason: `acl:${matched.id}` };
        }
        logger.debug(`[META] perm_check DENY: visibility=restricted, no ACL match`);
        return { allowed: false, reason: "visibility_restricted" };
      }
      break;
    case "task":
      if (action !== "read" && membership.role !== "admin") {
        logger.debug(`[META] perm_check DENY: visibility=task, non-admin non-read`);
        return { allowed: false, reason: "visibility_restricted" };
      }
      break;
    case "team":
    case "agent":
      break;
    default:
      logger.debug(`[META] perm_check DENY: unknown visibility=${asset.visibility}`);
      return { allowed: false, reason: "visibility_restricted" };
  }

  // 5. Role default permission (allows on match, can skip ACL query)
  const defaults = membership.role === "admin" ? ADMIN_ACTIONS : MEMBER_ACTIONS;
  if (defaults.includes(action)) {
    logger.debug(`[META] perm_check ALLOW: role_default=${membership.role}`);
    return { allowed: true, reason: `role_default:${membership.role}` };
  }

  // 6. Explicit ACL (three subject types: user / team_role / agent)
  const matched = aclRecords.find(
    (acl) =>
      acl.permission === action &&
      acl.effect === "allow" &&
      ((acl.subject_type === "user" && acl.subject_id === user.user_id) ||
        (acl.subject_type === "team_role" && acl.subject_id === membership.role) ||
        (acl.subject_type === "agent" && !!agentId && acl.subject_id === agentId)),
  );
  if (matched) {
    logger.debug(`[META] perm_check ALLOW: acl id=${matched.id}`);
    return { allowed: true, reason: `acl:${matched.id}` };
  }

  logger.debug(`[META] perm_check DENY: no matching rule`);
  return { allowed: false, reason: "no_permission" };
}

/**
 * Whether role default permission covers this action (service uses this to determine if lazy-loading ACL is needed).
 * Returning true means no ACL table lookup needed.
 */
export function roleDefaultCovers(role: TeamMemberEntity["role"], action: Permission): boolean {
  const defaults = role === "admin" ? ADMIN_ACTIONS : MEMBER_ACTIONS;
  return defaults.includes(action);
}

/**
 * Check if Asset's visibility allows binding to specified Agent (§10.4).
 * Complementary to checkPermission: checkPermission manages 'who can operate on resource',
 * canBindAsset manages 'whether resource can be mounted to agent'.
 */
export function canBindAsset(
  agent: Pick<import("../types.js").AgentEntity, "team_id" | "owner_user_id">,
  asset: Pick<AssetEntity, "visibility" | "team_id" | "owner_user_id">,
): boolean {
  switch (asset.visibility) {
    case "team":
      return asset.team_id === agent.team_id;
    case "agent":
      return asset.team_id === agent.team_id;
    case "private":
      return asset.owner_user_id === agent.owner_user_id && asset.team_id === agent.team_id;
    case "task":
    case "restricted":
      return false;
    default:
      return false;
  }
}
