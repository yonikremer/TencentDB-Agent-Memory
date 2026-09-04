/**
 * v3 metadata API authentication middleware (v3.1).
 *
 * Layer 1 (Gateway): `Authorization: Bearer <KERNEL_AUTH_TOKEN>` - verified in checkAuthForV2 of server.ts.
 * Layer 3 (User Identity): `x-tdai-user-key` - parsed by this module into userId / isSystemAdmin.
 *
 * `/v3/meta/*` requires user-key except for `auth/verify`.
 * For operations API without user-key, see `/v3/internal/meta/*`.
 */

import type { IncomingHttpHeaders } from "node:http";
import type { MetadataService } from "../service/metadata-service.js";

export interface V3AuthContext {
  /** Original user_key (from x-tdai-user-key). */
  token: string;
  /** Parsed user ID (when user_key is valid). */
  userId?: string;
  /** Legacy field: bootstrap isAdmin is no longer granted on /v3/meta/*. */
  isAdmin: boolean;
  /** user_key corresponds to user_type === system_admin. */
  isSystemAdmin: boolean;
}

export interface V3AuthResult {
  ok: boolean;
  status?: number;
  reason?: string;
  ctx?: V3AuthContext;
}

/** Paths in public APIs where x-tdai-user-key can be omitted (still requires Bearer + x-tdai-service-id). */
export const V3_NO_USER_KEY_ROUTES = new Set([
  "/v3/meta/auth/verify",
]);

/** Extract user API key from x-tdai-user-key header. */
export function extractUserKeyHeader(headers: IncomingHttpHeaders): string {
  const raw = headers["x-tdai-user-key"];
  const h = Array.isArray(raw) ? raw[0] : (raw ?? "");
  return h.trim();
}

/**
 * Parse user_key → user context. Empty key should not be passed by caller (bootstrap is handled by the routing layer).
 */
export async function authenticateV3(
  userKey: string,
  service: MetadataService,
): Promise<V3AuthResult> {
  if (!userKey) {
    return { ok: false, status: 401, reason: "missing_user_key" };
  }

  if (service.isConfiguredMemorySystemUserKey(userKey)) {
    return { ok: false, status: 401, reason: "invalid_user_key" };
  }

  const user = await service.verifyAuth(userKey);
  if (!user) {
    return { ok: false, status: 401, reason: "invalid_user_key" };
  }

  const isSystemAdmin = user.user_type === "system_admin";
  return {
    ok: true,
    ctx: { token: userKey, userId: user.user_id, isAdmin: false, isSystemAdmin },
  };
}
