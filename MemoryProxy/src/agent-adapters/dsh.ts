/**
 * deepseek-harness (dsh) client adapter.
 *
 * Packet capture evidence (2026-08-14, 6 real packets from mitmproxy, see
 * `docs/dsh-recon/2026-08-14-dsh-capture-analysis.md`):
 *
 *   - Protocol: **Standard OpenAI Chat Completions** (`POST /chat/completions` + SSE),
 *     same family as codebuddy; body/messages shape is 100% compatible (role:system/user/assistant/tool,
 *     tool_calls[] on assistant, separate role=tool message with tool_call_id)
 *   - Client fingerprint (strong): `user-agent: deepseek-harness/*` (dsh attribution cannot be disabled)
 *     + `x-deepseek-harness-user-id` (anonymous constant UUID) + `x-deepseek-harness-session-id`
 *     (session-<uuid>) + `x-deepseek-harness-compact:1` (only on compaction requests)
 *   - session_id is **only in header**, body has no fallback field (unlike codex's client_metadata);
 *     proxy side sid extraction is 100% dependent on header
 *   - assistant returns `reasoning_content` (dsh feature, only on tool_calls),
 *     proxy can just pass through, doesn't affect messages parser
 *
 * # Differentiating three types of requests (main / title / compaction)
 *
 * dsh main conversation / compaction / session-title all share the same `x-deepseek-harness-session-id`,
 * **only compaction has an independent header** (compact:1), title doesn't — relies on body features:
 *
 * | Category | Header Signal | Body Feature |
 * |---|---|---|
 * | compaction | `x-deepseek-harness-compact: 1` | — |
 * | title-gen | None | missing tools + thinking.disabled + max_tokens<=128 + system starts with "Create a concise title..." |
 * | main | None | Others |
 *
 * classifyRequest priority: **compact header > title body-shape > main**;
 * title criterion must **satisfy all three** to be considered aux (single feature is prone to false positives).
 *
 * # Two adaptation points
 *   - `classifyRequest`: 3-layer signal check (compact / title / main)
 *   - `extractUserText`: content is str, return directly (dsh messages.content never uses blocks)
 *
 * # Differences from CB
 *   - dsh main conversation packs 4 role=user into body.messages: actual user input +
 *     `<system-reminder>` workspace instruction + `runtime context` snapshot + `<available_skills>` list
 *     — on the proxy side, to extract the str content of the last user, just taking "the first from the end" is enough;
 *     actual user input is usually in messages[1] (the first user)
 *   - dsh user input itself **doesn't have CB/workbuddy's `<user_query>` wrapper**, pass through directly
 */

import type { AgentAdapter, RequestKind } from "./types.js";

// ── Title-gen body-shape detection ───────────────────────────────────────────

/**
 * Fixed prefix for dsh session-title-llm request system prompt.
 * Source: `packages/session/session-title-llm/src/index.ts:252-260` +
 * packet capture `fixtures/121918-*-9d056d.req.json` evidence.
 *
 * Full start of dsh side prompt:
 *   "Create a concise title for an AI coding-assistant session from the supplied human messages."
 *
 * Only matching the prefix to avoid breaking if upstream prompt is tweaked (punctuation / line breaks).
 */
const DSH_TITLE_SYSTEM_PROMPT_PREFIX =
  "Create a concise title for an AI coding-assistant session";

/**
 * max_tokens ceiling for dsh title-gen request. Packet capture shows `max_tokens=64`;
 * leaving 128 as a buffer to avoid drifting if upstream is tweaked.
 */
const DSH_TITLE_MAX_TOKENS_CEIL = 128;

/**
 * Determines whether a dsh request is title-gen (body feature 3-in-1).
 *
 * All conditions must be met to be considered aux. Any unmet condition returns false (to avoid false positive for main).
 */
function isDshTitleGen(body: Record<string, unknown>): boolean {
  // Condition 1: tools missing or empty array (main conversation always 25+ tools)
  const tools = body.tools;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (hasTools) return false;

  // Condition 2: thinking.type === "disabled"
  const thinking = body.thinking as { type?: string } | undefined;
  if (thinking?.type !== "disabled") return false;

  // Condition 3: max_tokens <= 128
  const maxTokens = body.max_tokens;
  if (typeof maxTokens !== "number" || maxTokens > DSH_TITLE_MAX_TOKENS_CEIL) return false;

  // Condition 4: First system message content starts with title prompt prefix
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const first = messages[0] as { role?: string; content?: unknown } | undefined;
  if (!first || first.role !== "system" || typeof first.content !== "string") return false;
  if (!first.content.startsWith(DSH_TITLE_SYSTEM_PROMPT_PREFIX)) return false;

  return true;
}

// ── User text extraction ─────────────────────────────────────────────────────

/**
 * dsh messages.content is str, return directly.
 *
 * Packet capture evidence (multiple messages in fixtures/*.req.json all role=user + content:str):
 * dsh never uses Anthropic-style content-blocks arrays, even tool_result is an independent
 * role=tool message (rather than embedded in user).
 *
 * No CB style `<user_query>` wrapper stripping — dsh main conversation is just pure user input +
 * independent `<system-reminder>` user message, no wrapper nesting.
 */
function extractDshUserText(content: unknown): string | null {
  if (typeof content !== "string") return null;
  return content.length > 0 ? content : null;
}

// ── Adapter export ───────────────────────────────────────────────────────────

export const dshAdapter: AgentAdapter = {
  agentKind: "dsh",

  classifyRequest(
    body: Record<string, unknown>,
    _path?: string,
    headers?: Record<string, string>,
  ): RequestKind {
    // Signal 1 (strongest): compact header - dsh source hardcoded in
    // `packages/llm/llm-deepseek/src/adapter.ts:290-293`, only injected
    // when `purpose:'compaction'`, unambiguous
    if (headers?.["x-deepseek-harness-compact"] === "1") return "auxiliary";

    // Signal 2: title-gen body features 3-in-1 (see isDshTitleGen)
    if (isDshTitleGen(body)) return "auxiliary";

    // Others always main
    return "main";
  },

  extractUserText(content: unknown): string | null {
    return extractDshUserText(content);
  },
};
