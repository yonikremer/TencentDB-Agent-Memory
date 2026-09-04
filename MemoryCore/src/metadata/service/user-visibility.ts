/**
 * system_admin external visibility: hidden by default in list/query APIs, visible only via bootstrap key or self.
 */
import type { UserEntity, UserPublic } from "../types.js";
import type { V3AuthContext } from "../router/auth.js";

export interface UserVisibilityOptions {
  /** When team-level list restricts member set, team admin can see normal users within it. */
  allowTeamPeers?: boolean;
}

export function isSystemAdminUser(user: Pick<UserEntity, "user_type">): boolean {
  return user.user_type === "system_admin";
}

export function canManageUsers(ctx: V3AuthContext): boolean {
  return ctx.isSystemAdmin;
}

/** admin/system_admin can read all; normal users can only read themselves; system_admin account is hidden from others by default. */
export function canViewUser(
  user: UserEntity,
  ctx: V3AuthContext,
  options?: UserVisibilityOptions,
): boolean {
  if (isSystemAdminUser(user)) {
    // Only one system_admin per instance (design invariant); ctx.isSystemAdmin branch unreachable in prod, kept for defense.
    return ctx.isAdmin || ctx.isSystemAdmin || ctx.userId === user.user_id;
  }
  if (ctx.isSystemAdmin) return true;
  if (options?.allowTeamPeers) return true;
  if (ctx.isAdmin) return true;
  return ctx.userId === user.user_id;
}

/** v3.1 public response: user_id / user_type / username / created_at. */
export function toPublicUser(user: UserEntity, ctx: V3AuthContext): UserPublic {
  const pub: UserPublic = {
    user_id: user.user_id,
    user_type: user.user_type,
    username: user.username,
    created_at: user.created_at,
  };
  if (isSystemAdminUser(user) && !ctx.isAdmin && ctx.userId !== user.user_id) {
    const { user_type: _ut, ...safe } = pub;
    return safe as UserPublic;
  }
  return pub;
}

export function filterVisibleUsers(
  users: UserEntity[],
  ctx: V3AuthContext,
  options?: UserVisibilityOptions,
): UserPublic[] {
  return users.filter((u) => canViewUser(u, ctx, options)).map((u) => toPublicUser(u, ctx));
}
