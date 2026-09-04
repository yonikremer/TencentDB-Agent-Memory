/**
 * Codex CLI client adapter.
 *
 * Specialized implementation:
 *   - classifyRequest: Strict allowlist for aux (endpoint path + memgen header +
 *     known thread_source value), unknown always main (strict rather than lenient)
 *   - extractUserText: Extracts from codex body.input[], taking the last type=message &&
 *     role=user content[].input_text and concatenating
 *
 * See docs/2026-08-07-codex-integration-plan.md §1 / §9.
 */

import type { AgentAdapter, RequestKind } from "./types.js";

// ── Aux detection constants ──────────────────────────────────────────────────

/** Known aux endpoint path suffixes. codex-rs/core/src/client.rs constants in source code. */
const CODEX_AUX_PATH_SUFFIXES = new Set([
  "/responses/compact",
  "/memories/trace_summarize",
  "/realtime/calls",
]);

/**
 * Known aux values for codex client body.client_metadata.thread_source.
 *
 * - "memory_consolidation": Source code ThreadSource::MemoryConsolidation
 * - "system": Packet capture §7.4 title-generation aux actual test
 *
 * Unknown values are always treated as main conversation (strict).
 */
const CODEX_AUX_THREAD_SOURCES = new Set([
  "memory_consolidation",
  "system",
]);

/**
 * Determines whether a codex request is aux (auxiliary request).
 *
 * Three layers of signals by priority:
 *   1. endpoint path suffix allowlist (strongest, hardcoded in codex source)
 *   2. x-openai-memgen-request header (memory consolidation exclusive)
 *   3. body.client_metadata.thread_source allowlist
 */
function isCodexAuxiliary(
  path: string | undefined,
  headers: Record<string, string> | undefined,
  body: Record<string, unknown>,
): boolean {
  // Signal 1: aux endpoint (path allowlist)
  if (path) {
    for (const suffix of CODEX_AUX_PATH_SUFFIXES) {
      if (path.endsWith(suffix)) return true;
    }
  }

  // Signal 2: x-openai-memgen-request: true
  if (headers?.["x-openai-memgen-request"] === "true") return true;

  // Signal 3: body.client_metadata.thread_source hits allowlist
  const meta = body.client_metadata as { thread_source?: string } | undefined;
  const ts = meta?.thread_source;
  if (typeof ts === "string" && CODEX_AUX_THREAD_SOURCES.has(ts)) return true;

  return false;
}

// ── User text extraction ─────────────────────────────────────────────────────

/**
 * Extracts the last type=message && role=user content[].input_text from codex input[].
 *
 * codex input[] item type list (packet capture draft §7.2):
 *   - {type:"message", role, content:[{type:"input_text",text}]}
 *   - {type:"function_call", name, arguments}
 *   - {type:"function_call_output", output}
 *   - {type:"reasoning", encrypted_content}
 *
 * Only concerned with type=input_text segment in content of type=message && role=user.
 */
function extractCodexUserText(input: unknown): string | null {
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

export const codexAdapter: AgentAdapter = {
  agentKind: "codex",

  classifyRequest(
    body: Record<string, unknown>,
    path?: string,
    headers?: Record<string, string>,
  ): RequestKind {
    return isCodexAuxiliary(path, headers, body) ? "auxiliary" : "main";
  },

  extractUserText(content: unknown): string | null {
    return extractCodexUserText(content);
  },
};
