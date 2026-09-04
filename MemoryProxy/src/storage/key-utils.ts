/**
 * key-utils —— utility for ProxyStorage key path generation & validation.
 *
 * See docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.2
 * (The directory layout of the earlier plan, 2026-07-10-cos-ttl-nottl-split-plan.md §4.2, is extended here with a spaceId layer).
 *
 * Directory scheme: <ttl|nottl>/<spaceId>/<userId>/<agentSource>/<sessionId>/<data-type>[/subpath]
 *
 * The spaceId layer was introduced in P4 (kernel-sts) — STS permissions are isolated per spaceId, so the path also carries a
 * spaceId segment, aligning the key layout with the STS resource `proxy_cache/{ttl|nottl}/{spaceId}/*`.
 *
 * The four-segment isolation keys are validated uniformly in this file: each repo builds its prefix through `sessionDirOf`
 * (which always ends in `/`) and then appends its own data-type segment. Before writing, the segments that are easy to
 * inject (spaceId / userId / agentSource / sessionId / hookId / skillId) are checked to prevent
 * `../` path traversal, key collisions from empty segments, and agentSource illegal characters breaking out of the directory layer.
 */

const AGENT_SOURCE_RE = /^[a-z0-9-]+$/;

/**
 * Generic segment validation: non-empty, no `/`, no `..` substring.
 *
 * The `..` check outright rejects every case containing the substring ("..", "foo..bar", "..a" all rejected), which is
 * more conservative than only rejecting a full ".." — production sessionId / userId / hookId should never contain two
 * consecutive dots, so the false-positive cost is negligible while the anti-injection value is high.
 */
export function assertKeySegment(name: string, value: string): void {
  if (!value || value.includes("/") || value.includes("..")) {
    throw new Error(`invalid ${name}: ${value}`);
  }
}

/**
 * agentSource value validation: `^[a-z0-9-]+$`.
 *
 * Allows lowercase + digit + hyphen, matching the format of the first URL path segment
 * (handler.ts / anthropicHandler.ts parse exactly this format from the path).
 * Uppercase, underscore, dot, and slash are all rejected.
 */
export function assertAgentSource(value: string): void {
  if (!AGENT_SOURCE_RE.test(value)) {
    throw new Error(`invalid agentSource: ${value}`);
  }
}

/**
 * Generates the session-level directory prefix: `<bucket>/<spaceId>/<userId>/<agentSource>/<sessionId>/`.
 *
 * Keeps the trailing slash so the caller can just append `${sessionDirOf(...)}<datatype>`;
 * directory-level operations (`listNames` / `delPrefix`) also use the return value directly as a prefix.
 *
 * The spaceId segment is positioned right after the bucket (after ttl/nottl); this is the key constraint
 * for a lifecycle rule to match every space with a single prefix — rules do not support wildcards mid-path.
 */
export function sessionDirOf(
  bucket: "ttl" | "nottl",
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  assertKeySegment("spaceId", spaceId);
  assertKeySegment("userId", userId);
  assertAgentSource(agentSource);
  assertKeySegment("sessionId", sessionId);
  return `${bucket}/${spaceId}/${userId}/${agentSource}/${sessionId}/`;
}

/**
 * 2-segment variant: `<bucket>/<spaceId>/<sessionId>/`.
 *
 * Used by BindingRepo — the bridge must be able to read back the identity using only (spaceId, sessionId),
 * so userId/agentSource move into the JSON internal fields. See docs/design/2026-08-03-binding-flatten.md.
 * The old 4-segment `sessionDirOf` continues to serve SessionRepo (ttl inj-sess.json); left unchanged.
 */
export function sessionBindingDirOf(
  bucket: "ttl" | "nottl",
  spaceId: string,
  sessionId: string,
): string {
  assertKeySegment("spaceId", spaceId);
  assertKeySegment("sessionId", sessionId);
  return `${bucket}/${spaceId}/${sessionId}/`;
}
