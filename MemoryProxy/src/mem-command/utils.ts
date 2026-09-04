/**
 * Internal utility functions for mem-command.
 *
 * Currently only extractSimpleMessages — normalizes body.messages (protocol native format) from the handler layer
 * down to the minimal { role, content } format consumed by task-draft-generator.
 *
 * Supports three protocol formats (compatible with the same function input):
 *   - OpenAI (CC/CB):        body.messages = [{ role, content: string }]
 *   - Anthropic (CC native): body.messages = [{ role, content: string | Array<{type:"text",text}|...> }]
 *   - Responses (Codex/WB):  body.input    = [{ type:"message", role,
 *                              content: [{type:"input_text"|"output_text", text}] }, ...]
 *
 * Main differences of Responses API from the first two:
 *   1. content block uses `type:"input_text"` / `type:"output_text"` instead of `type:"text"`
 *   2. Each message has an outer `type:"message"` wrapper
 *   3. input[] is mixed with non-message items like function_call / function_call_output — only takes message
 *
 * The function auto-detects all three formats, callers don't need to distinguish.
 */

import type { MemCommandMessage } from "./types.js";

/**
 * Extracts plain text from the content array.
 * Supports three block types:
 *   - {type:"text", text}         (Anthropic)
 *   - {type:"input_text", text}   (Responses API user/system message)
 *   - {type:"output_text", text}  (Responses API assistant message)
 * Unknown type blocks are ignored (e.g. tool_use / function_call / image ...).
 */
function joinContentBlocks(content: unknown[]): string {
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const t = b.type;
    if ((t === "text" || t === "input_text" || t === "output_text") && typeof b.text === "string") {
      texts.push(b.text);
    }
  }
  return texts.join("\n");
}

/**
 * Extracts the minimal { role, content } format from any messages array.
 *
 * Fault tolerance strategy:
 * - Non-array / empty → returns []
 * - role not in ["user","assistant","system"] → ignore that item
 * - Responses API item has a type field and it's not "message" (e.g., "function_call" / "function_call_output") → ignore
 * - content is an array → merge all text/input_text/output_text segments (ignore other types)
 * - content is an empty string → ignore that item
 */
/**
 * Compresses mem command args into a short single-line log snippet, easy for [mem-command] tracking and troubleshooting.
 *
 * - Newline/consecutive whitespace → single space
 * - Exceeds max (default 40) → tail truncated with "..."
 * - Empty/pure whitespace → returns empty string (caller decides whether to append to log)
 *
 * Note: This is strictly for logging, absolutely cannot be reverse-parsed back to original text; args may contain sensitive/multi-line content,
 * must pass through this before display.
 */
export function truncateArgs(args: string | undefined | null, max = 40): string {
  if (!args) return "";
  const oneLine = String(args).replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return "";
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + "...";
}

export function extractSimpleMessages(input: unknown): MemCommandMessage[] {
  if (!Array.isArray(input)) return [];

  const out: MemCommandMessage[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;

    // Responses API: only keeps type=message, skips function_call / function_call_output etc
    // (OpenAI / Anthropic messages don't have a type field, this check doesn't apply, compatible)
    if (typeof m.type === "string" && m.type !== "message") continue;

    const role = typeof m.role === "string" ? m.role : "";
    if (role !== "user" && role !== "assistant" && role !== "system") continue;

    let content = "";
    const c = m.content;
    if (typeof c === "string") {
      content = c;
    } else if (Array.isArray(c)) {
      content = joinContentBlocks(c);
    }

    content = content.trim();
    if (content.length === 0) continue;

    out.push({ role, content });
  }
  return out;
}
