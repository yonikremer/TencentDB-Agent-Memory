/**
 * WorkBuddy desktop client adapter.
 *
 * Reconnaissance basis (2026-08-10 reverse engineering workbuddy Mac client 5.3.11 packet capture evidence):
 *
 * # Client architecture
 *   - Electron GUI (Tencent official "Desktop AI Agent", product page www.codebuddy.cn/work/)
 *   - Desktop shell communicates with local `@genie/agent-cli` via ACP over HTTP (local 127.0.0.1 sidecar);
 *     actual remote LLM requests are sent by sidecar (`cli/dist/codebuddy.js`)
 *   - Underlying library: `@openai/agents 0.5.2` (OpenAI official Agents SDK)
 *
 * # Wire protocol
 *   - Protocol = **OpenAI Responses API** (not Chat Completions)
 *   - endpoint suffix: `/responses` (main), `/responses/compact`,
 *     `/realtime/calls`, `/memories/trace_summarize`
 *   - stream uses SSE / WebSocket (`ensureResponsesWebSocketPath` exists, but HTTP is also supported)
 *   - Base URL can be overridden via `OPENAI_BASE_URL` / `OPENAI_ENDPOINT` →
 *     **Proxying only requires environment variable redirection, client binary doesn't need to be modded**
 *   - Authentication: `Authorization: Bearer <token>` (token from env var
 *     `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_API_KEY`) + independent `X-User-Id` header
 *
 * # Exclusive header set (packet capture grep hits)
 *   - `X-Agent-Intent` / `X-Agent-Purpose`
 *   - `X-User-Id` (URL-encoded)
 *   - `X-Codebuddy-Run-Timeout` (Note: header key inherits codebuddy prefix,
 *     is historical legacy of sidecar inherited from codebuddy CLI)
 *
 * # System prompt structure (`resources/templates/workbuddy-prompt.tpl` packet capture evidence)
 *   - nunjucks template rendered by client, **proxy receives rendered final text**
 *   - XML tag sections: `<content_policy>` / `<agent_skills>` / `<expert_management>`
 *     / `<mcp_configuration>` / `<response_language>` / `<binary_context>`
 *   - user message wrapper: `<user_query>...</user_query>`
 *   - 4 segments of memory placeholders (this adapter is not involved in injection, handled at injection profile layer):
 *       * `{{ WorkbuddyMemory_1 }}`
 *       * `{{ WorkingMemoryContent }}`
 *       * `{{ UserLocalMemoryContent }}`
 *       * `{{ UserMemoryContent }}`
 *   - Data directory variable: `{{ dataFolderName }}` → `.workbuddy`
 *   - Product domain: `www.workbuddy.cn/docs/workbuddy/Overview` (**independent of codebuddy**)
 *
 * # Two adaptation points
 *   - `classifyRequest`: **Independent implementation** of same aux 3-layer signal check (endpoint path allowlist +
 *     memgen header + client_metadata.thread_source) — overlaps with codex keywords but zero dependency
 *   - `extractUserText`: Extracted from responses API `body.input[]` taking the last
 *     `type=message && role=user`'s `content[].input_text` — independent implementation,
 *     does not import codex module
 *
 * # Independence constraint (User explicit requirement)
 *   - Zero import codebuddy / codex
 *   - The overlapping keyword set with codex is a natural result of "upstream protocol homology", not considered coupling
 *   - Any future changes on the workbuddy side (new aux path, new headers) evolve within this file
 *
 * See packet capture reports for details: MemoryProxy/docs/workbuddy-recon/*.tpl + workbuddy-cli-product.json.
 */

import { extractUserQueryText } from "../common/user-query-extractor.js";
import type { AgentAdapter, RequestKind } from "./types.js";

// ── Aux detection constants ──────────────────────────────────────────────────

/**
 * Known aux endpoint path suffixes for WorkBuddy client.
 *
 * Source: workbuddy Mac client 5.3.11 reverse engineering `cli/dist/codebuddy.js` grep results:
 *   - `/responses/compact`         Compression/summary request
 *   - `/memories/trace_summarize`  Memory trace induction
 *   - `/realtime/calls`            Real-time session establishment
 *
 * If workbuddy adds new aux endpoints in the future, append here (do not modify codex side).
 */
const WORKBUDDY_AUX_PATH_SUFFIXES: readonly string[] = [
  "/responses/compact",
  "/memories/trace_summarize",
  "/realtime/calls",
];

/**
 * Known aux types body.client_metadata.thread_source values for WorkBuddy client.
 *
 * Packet capture hasn't verified whether workbuddy uses client_metadata; conservatively only placing
 * the two allowlist values known for codex here (if workbuddy's underlying SDK is homologous with codex, logically identical).
 * Unknown values are always treated as main (strict rather than lenient).
 */
const WORKBUDDY_AUX_THREAD_SOURCES:ReadonlySet<string> = new Set([
  "memory_consolidation",
  "system",
]);

/**
 * Memgen request header key collection unique to WorkBuddy.
 *
 * Packet capture evidence shows workbuddy sidecar inherits from codebuddy CLI, still using
 * `x-openai-memgen-request` to mark memory generation requests.
 * Listed independently, does not import codex constants.
 */
const WORKBUDDY_MEMGEN_HEADER_KEYS: readonly string[] = [
  "x-openai-memgen-request",
];

/**
 * Determines whether a workbuddy request is aux (auxiliary request).
 *
 * Three layers of signals by priority:
 *   1. endpoint path suffix allowlist (strongest)
 *   2. memgen request header (memory consolidation exclusive)
 *   3. body.client_metadata.thread_source allowlist
 */
function isWorkbuddyAuxiliary(
  path: string | undefined,
  headers: Record<string, string> | undefined,
  body: Record<string, unknown>,
): boolean {
  // Signal 1: aux endpoint (path allowlist)
  if (path) {
    for (const suffix of WORKBUDDY_AUX_PATH_SUFFIXES) {
      if (path.endsWith(suffix)) return true;
    }
  }

  // Signal 2: memgen request header
  if (headers) {
    for (const key of WORKBUDDY_MEMGEN_HEADER_KEYS) {
      if (headers[key] === "true") return true;
    }
  }

  // Signal 3: body.client_metadata.thread_source hits allowlist
  const meta = body.client_metadata as { thread_source?: string } | undefined;
  const ts = meta?.thread_source;
  if (typeof ts === "string" && WORKBUDDY_AUX_THREAD_SOURCES.has(ts)) return true;

  return false;
}

// ── User text extraction ─────────────────────────────────────────────────────

/**
 * Extracts the concatenated text of the last `type=message && role=user`'s `content[].input_text`
 * from workbuddy responses API `body.input[]`.
 *
 * Packet capture evidence: workbuddy underlying uses @openai/agents SDK, wire body structure is completely identical
 * to OpenAI Responses API. input[] item known types:
 *   - {type:"message", role:"user"|"assistant"|"developer"|"system",
 *      content:[{type:"input_text"|"output_text"|"input_image",...}]}
 *   - {type:"function_call", name, arguments}
 *   - {type:"function_call_output", output}
 *   - {type:"reasoning", encrypted_content, ...}
 *
 * Only concerned with type=input_text segment in content of type=message && role=user.
 *
 * Note: independent of codex implementation (duplicate algorithm but zero coupling); if workbuddy input[]
 * structure diverges in the future (e.g. adding workbuddy specific content type), evolve within this file.
 */
function extractWorkbuddyUserText(input: unknown): string | null {
  if (!Array.isArray(input)) return null;

  // Search backwards for the last message with role=user
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as Record<string, unknown> | null | undefined;
    if (!item || typeof item !== "object") continue;
    if (item.type !== "message" || item.role !== "user") continue;

    const content = item.content;
    if (!Array.isArray(content)) continue;

    const texts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown> | null | undefined;
      if (!b || typeof b !== "object") continue;
      if (b.type === "input_text" && typeof b.text === "string") {
        texts.push(b.text);
      }
    }
    return texts.length > 0 ? texts.join("\n") : null;
  }

  return null;
}

// ── Adapter export ───────────────────────────────────────────────────────────

/**
 * Extracts actual user input - dual form compatible:
 *
 * 1) **Responses API (`/v1/responses`)**: Desktop client exclusive, content is `input[]`
 *    array (`{type:"message", role:"user", content:[{type:"input_text", text}]}`),
 *    uses `extractWorkbuddyUserText` independent algorithm.
 *
 * 2) **Chat Completions (`/v1/chat/completions`)**: workbuddy web version underlying uses
 *    OpenAI ChatCompletions (`claude-opus-4.7-1m` + OpenAI compatible upstream),
 *    uses universal main handler path. `message.content` is string, and carries CC/CB style
 *    `<system-reminder>` / `<user_query>` wrapper (2026-08-12 log evidence).
 *    Directly reuse CB's `extractUserQueryText` — keeps the same strip semantics
 *    with tdai L0 / mem-command.
 *
 * Fix background: 2026-08-12 User sends `mem:help` in workbuddy web version, request enters proxy and goes to
 * `/chat/completions` (handler.ts::handleChatCompletions), parseMemCommand calls
 * `workbuddyAdapter.extractUserText(content)`, but original implementation only handled Array, string
 * content returned null -> command recognition failed -> passed through to LLM fallback. See develop_timestone/.
 */
export const workbuddyAdapter: AgentAdapter = {
  agentKind: "workbuddy",

  classifyRequest(
    body: Record<string, unknown>,
    path?: string,
    headers?: Record<string, string>,
  ): RequestKind {
    return isWorkbuddyAuxiliary(path, headers, body) ? "auxiliary" : "main";
  },

  extractUserText(content: unknown): string | null {
    // Web version chat/completions: content is string (may carry <user_query> / wrapper)
    if (typeof content === "string") {
      const extracted = extractUserQueryText(content);
      return extracted.length > 0 ? extracted : null;
    }
    // Desktop client /v1/responses: content is input[] array
    return extractWorkbuddyUserText(content);
  },
};
