/**
 * user_key masking and validity checking (multi-key model).
 */

/** user_key fixed prefix, used to identify ownership and key scanning. */
export const USER_KEY_PREFIX = "sk-mem-";

/**
 * Generic sensitive string masking: first 8 chars + ellipsis, without exposing full secret.
 * Used for api-trace to mask generalized keys like password / token / authorization in logs.
 */
export function maskKeyValue(keyValue: string): string {
  if (!keyValue) return "";
  if (keyValue.length <= 8) return `${keyValue}…`;
  return `${keyValue.slice(0, 8)}…`;
}

/**
 * user_key list/detail display masking: retains `sk-mem-` prefix + `****` + last 4 chars.
 * For example `sk-mem-<32 chars>...e5fG` → `sk-mem-****e5fG`.
 */
export function maskUserKey(keyValue: string): string {
  if (!keyValue) return "";
  const prefix = keyValue.startsWith(USER_KEY_PREFIX) ? USER_KEY_PREFIX : "";
  const body = keyValue.slice(prefix.length);
  const tail = body.length >= 4 ? body.slice(-4) : body;
  return `${prefix}****${tail}`;
}

/** Whether active key has expired (expires_at is ISO string). */
export function isUserKeyExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= now;
}

export const DEFAULT_MAX_ACTIVE_USER_KEYS = 20;
