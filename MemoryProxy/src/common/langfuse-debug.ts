/**
 * Langfuse debug helpers —— gated by `langfuse.debug=true`, used to stuff the native structure
 * of LLM requests + client fingerprints into Langfuse reporting as much as possible, for **troubleshooting / client reverse-engineering**.
 *
 * Current situation breakdown (pitfalls before merge):
 *   1. Anthropic side `anthropicHandler.buildLangfuseInput` already has a debug branch, but
 *      only retains messages+system native structure; output still takes text concatenation
 *      (tool_use / thinking / stop_reason lost); metadata only has stream/retried/upstreamUrl.
 *   2. The 5 langfuse reporting spots in OpenAI protocol handler.ts **completely do not read debug flag**,
 *      hardcoded to go through flattenMessagesForOpik flattening —— CodeBuddy requests take exactly this path,
 *      so enabling debug cannot capture CB native body either.
 *
 * This file adds the **shared** parts —— input builder for OpenAI protocol + generic debug metadata.
 * The input builder on Anthropic side (`buildLangfuseInput`) is already inlined in anthropicHandler.ts,
 * not moved over to avoid circular dependency. Output processing branches off by each handler itself based on debug flag.
 *
 * See appendix of docs/design/2026-07-30-cc-request-routing-plan.md and the commit message of this submission for details.
 */

import type { CcRequestKind } from "./cc-request-classifier.js";
import { findLastCacheControlIndex } from "./cc-request-classifier.js";

// ─── Whitelist and Truncation Limits ────────────────────────────────────────────────────────
// Request header prefixes: consistent with identity.ts:172, to avoid drifting understanding of CB headers across different places.
const HEADER_PREFIX_WHITELIST = ["x-", "cb-", "codebuddy-"];
// Maximum character limit to truncate for a single tool description / string field (to prevent langfuse single report bloat).
const STRING_TRUNC = 200;
// Maximum number of tools to capture (first N is enough to identify client fingerprint).
const TOOLS_MAX = 8;

/**
 * Langfuse input builder for OpenAI protocol messages.
 *
 * - `debug=true`: returns original messages array as-is (retains string/array content CodeBuddy
 *   might stuff, internal tags like `<additional_data>` / `<question_answer>`, cache_control
 *   marker, tool_use native form, thinking block, etc.).
 * - `debug=false`: goes through fallback passed by caller (usually handler.ts:flattenMessagesForOpik),
 *   flattens content array into role+string form, saving langfuse storage cost 2-5x.
 *
 * The reason parameter `fallback` is explicitly passed in instead of imported is to let handler retain
 * its own flatten implementation (which has other callers on opik/opik-fork side reusing it), this file
 * is not responsible for flatten semantics.
 */
export function buildLangfuseInputChat(
  messages: unknown[],
  debug: boolean,
  fallback: (m: unknown[]) => unknown[],
): unknown {
  if (debug) {
    // Directly return original messages array —— retain role/content native structure.
    return messages;
  }
  return fallback(messages);
}

// ─── Debug metadata ─────────────────────────────────────────────────────────

export interface RequestDebugMetadataInput {
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  agentSource?: string;
  requestKind?: CcRequestKind;
  spaceId?: string;
  turnSeq?: number;
  requestPath?: string;
  protocol?: "anthropic" | "openai";
  debug: boolean;
}

/**
 * Extract "client fingerprint + key fields for request classification" from body / headers / routing context,
 * and stuff them into observationMetadata / traceMetadata of Langfuse.
 *
 * When `debug=false` constantly returns **empty object** (does not pollute online metadata).
 *
 * Extracted fields (all flat keys, convenient for Langfuse UI display):
 *   - `model` / `stream` / `max_tokens` / `temperature` / `top_p` / `top_k`
 *   - `thinking_type` / `stop_sequences_len` / `system_len` / `messages_len`
 *   - `tools_len` / `tools_summary` — name + desc of first N tools truncated to 200 chars
 *   - `cache_control_marker_idx` — position of last cache_control marker in messages
 *     (core signal to identify CC fork/main/sidequery; see cc-request-classifier.ts)
 *   - `body_metadata` — Anthropic body.metadata (contains user_id etc.)
 *   - `body_extra_keys` — top-level "non-standard fields" names of body (CB / cursor often secretly stuff extension fields)
 *   - `agent_source` / `request_kind` / `space_id` / `turn_seq` / `request_path`
 *   - `header_<name>` — client header with whitelisted prefix (x-* / cb-* / codebuddy-*)
 *
 * Tools/description are both truncated to prevent single report bloat. If extraction fails, silently return existing fields
 * (missing one or two fields in debug data does not affect troubleshooting, cannot throw exception to affect business).
 */
export function buildRequestDebugMetadata(
  opts: RequestDebugMetadataInput,
): Record<string, unknown> {
  if (!opts.debug) return {};

  const out: Record<string, unknown> = {};
  try {
    const b = opts.body ?? {};

    // ── top-level common body fields ──
    if (typeof b.model === "string") out.model = b.model;
    if (typeof b.stream === "boolean") out.stream = b.stream;
    if (typeof b.max_tokens === "number") out.max_tokens = b.max_tokens;
    if (typeof b.temperature === "number") out.temperature = b.temperature;
    if (typeof b.top_p === "number") out.top_p = b.top_p;
    if (typeof b.top_k === "number") out.top_k = b.top_k;

    // Anthropic thinking block
    const thinking = b.thinking as { type?: unknown } | undefined;
    if (thinking && typeof thinking === "object" && typeof thinking.type === "string") {
      out.thinking_type = thinking.type;
    }

    // stop_sequences (OpenAI: `stop`; Anthropic: `stop_sequences`)
    const stopSeq = Array.isArray(b.stop_sequences)
      ? (b.stop_sequences as unknown[])
      : Array.isArray(b.stop)
      ? (b.stop as unknown[])
      : null;
    if (stopSeq) out.stop_sequences_len = stopSeq.length;

    // system prompt length (Anthropic has body.system; OpenAI stuffed in messages[0].role='system')
    if (typeof b.system === "string") {
      out.system_len = b.system.length;
    } else if (Array.isArray(b.system)) {
      let total = 0;
      for (const blk of b.system as unknown[]) {
        const t = (blk as { text?: unknown })?.text;
        if (typeof t === "string") total += t.length;
      }
      out.system_len = total;
    }

    const msgs = Array.isArray(b.messages) ? (b.messages as unknown[]) : [];
    out.messages_len = msgs.length;

    // Tools array —— name + desc of first N (truncated), enough for fingerprinting
    if (Array.isArray(b.tools)) {
      const tools = b.tools as unknown[];
      out.tools_len = tools.length;
      const summary: Array<{ name?: string; desc?: string }> = [];
      for (let i = 0; i < Math.min(tools.length, TOOLS_MAX); i++) {
        const t = tools[i] as Record<string, unknown> | undefined;
        if (!t) continue;
        // Anthropic: {name, description}；OpenAI: {function: {name, description}}
        const fn = (t.function as Record<string, unknown> | undefined) ?? t;
        const name = typeof fn.name === "string" ? fn.name : undefined;
        const descRaw = typeof fn.description === "string" ? fn.description : undefined;
        const entry: { name?: string; desc?: string } = {};
        if (name) entry.name = truncate(name, STRING_TRUNC);
        if (descRaw) entry.desc = truncate(descRaw, STRING_TRUNC);
        if (entry.name || entry.desc) summary.push(entry);
      }
      if (summary.length) out.tools_summary = summary;
    }

    // Cache control marker position —— core signal for CC request classification
    if (msgs.length > 0) {
      const idx = findLastCacheControlIndex(msgs);
      if (idx >= 0) out.cache_control_marker_idx = idx;
    }

    // Anthropic body.metadata (might contain client context like user_id / session_id)
    if (b.metadata && typeof b.metadata === "object" && !Array.isArray(b.metadata)) {
      out.body_metadata = b.metadata as Record<string, unknown>;
    }

    // Top-level non-standard body fields (extension keys secretly stuffed by client —— to identify client fingerprint)
    const standardKeys = new Set([
      "model", "messages", "system", "tools", "tool_choice",
      "temperature", "top_p", "top_k", "max_tokens",
      "stream", "stream_options", "thinking",
      "stop", "stop_sequences", "metadata",
      "n", "user", "seed", "response_format", "presence_penalty", "frequency_penalty",
    ]);
    const extra = Object.keys(b).filter((k) => !standardKeys.has(k));
    if (extra.length) out.body_extra_keys = extra;

    // ── routing context ──
    if (opts.agentSource) out.agent_source = opts.agentSource;
    if (opts.requestKind) out.request_kind = opts.requestKind;
    if (opts.spaceId) out.space_id = opts.spaceId;
    if (typeof opts.turnSeq === "number") out.turn_seq = opts.turnSeq;
    if (opts.requestPath) out.request_path = opts.requestPath;
    if (opts.protocol) out.protocol = opts.protocol;

    // ── request headers (whitelisted prefixes) ──
    if (opts.headers) {
      for (const [rawK, v] of Object.entries(opts.headers)) {
        const k = rawK.toLowerCase();
        // skip headers containing sensitive information
        if (k === "authorization" || k === "x-api-key" || k === "cookie") continue;
        if (!HEADER_PREFIX_WHITELIST.some((p) => k.startsWith(p))) continue;
        out[`header_${k}`] = truncate(String(v), STRING_TRUNC);
      }
    }
  } catch {
    // debug metadata is just auxiliary, absolutely must not affect business; catch exception and return what's already filled
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
