/**
 * Claude Code request classification — Based on Anthropic body's `cache_control`
 * marker position + tools/thinking fallback, to classify all CC client requests sent to /v1/messages
 * into three types: main / fork / sidequery.
 *
 * Judgment basis (hard constraints in source code + packet capture verification):
 *   - MAIN conversation: cache_control marker is at messages[n-1] (including msgs=1 boundary)
 *   - FORK reusing cache (SUGGESTION/RECAP/COMPACT/...): marker is at messages[n-2]
 *     Source code forkedAgent.ts + claude.ts:3242-3243 forces skipCacheWrite=true to move
 *     the marker to n-2 position to avoid falsely calculating cache write cost
 *   - SIDEQUERY independent request (TITLE/verify_api_key/...): no marker + tools=[] +
 *     thinking.disabled; source code sessionTitle.ts:434 + queryHaiku force caching off
 *
 * Fallback for 3P provider caching off: when body has no marker, use tools=[] && thinking.disabled
 * two hard constraints to determine sidequery; otherwise fallback to main — downgrades to original one-size-fits-all logic, no worse.
 *
 * See detailed design and packet capture verification in:
 *   docs/design/2026-07-30-cc-request-routing-plan.md
 */

export type CcRequestKind = "main" | "fork" | "sidequery";

/**
 * Determine request type based on Anthropic request body.
 *
 * Input is the parsed body (Record<string, unknown>) by the handler, field accesses all go through
 * defensive narrowing, unknown/malformed body always falls back to "main" — ensuring behavior is
 * equivalent to the original chain when determination fails.
 */
export function classifyCcRequest(body: Record<string, unknown>): CcRequestKind {
  const rawMsgs = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  // Filter out non-conversation messages (e.g. role:"system" injected by some CC
  // versions into the messages array). Only user/assistant participate in the
  // cache_control marker position logic that distinguishes main from fork.
  const msgs = rawMsgs.filter((m) => {
    const role = (m as { role?: string })?.role;
    return role === "user" || role === "assistant";
  });
  const n = msgs.length;
  const markerIdx = findLastCacheControlIndex(msgs);

  // Main judgment: cache_control marker position
  if (markerIdx >= 0) {
    // messages[n-2] → FORK (skipCacheWrite=true forced)
    if (markerIdx === n - 2) return "fork";
    // Other positions (including last=n-1) → MAIN
    return "main";
  }

  // No marker: might be SIDEQUERY, or MAIN with 3P provider caching off
  // Fallback signal: SIDEQUERY hard constraint is tools=[] AND thinking.disabled both hitting
  //          Use && instead of || to avoid mistakenly hurting main conversation where user individually disabled tools or thinking
  const toolsEmpty = !Array.isArray(body.tools) || (body.tools as unknown[]).length === 0;
  const thinking = body.thinking as { type?: string } | undefined;
  const thinkingOff = thinking?.type === "disabled";
  if (toolsEmpty && thinkingOff) return "sidequery";

  return "main";
}

/**
 * Find the index of the **last** message containing the cache_control marker in the messages array.
 *
 * The cache_control in the CC client is stuffed at the content block level (not the top level of the message),
 * so we need to scan if any block in the content array of each message contains the cache_control key.
 * Returns -1 if no match.
 */
export function findLastCacheControlIndex(msgs: unknown[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { content?: unknown };
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content as unknown[]) {
      if (b && typeof b === "object" && "cache_control" in (b as object)) return i;
    }
  }
  return -1;
}
