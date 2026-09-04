/**
 * WorkBuddy asset injection — `<tdai_injections>` wrapper generator.
 *
 * **Isomorphic but independent** from codex-injection.ts: WorkBuddy also uses OpenAI Responses API
 * (@openai/agents SDK), body structure is consistent with Codex (`input[]` array, mixed developer/user
 * messages, content array contains input_text). The logic could have been reused, but following the project's
 * "clients decoupled from each other" policy, intentionally copied as an independent file; modifying WorkBuddy does not affect
 * Codex, and vice versa.
 *
 * Two modes (keeping the same dual-mode design as codex-injection):
 *   - **raw** (path taken by current handler): the **complete finished text**
 *     already produced by the pipeline (including multiple sets of internal XML tags like
 *     `<available_skills>` / `<user_memory>` / `<tdai_profile_memory>` /
 *     `<memory-tools-guide>`) is embedded as-is into the inner layer of the wrapper, without further
 *     escaping or adding child tags —— completely **byte-identical** to what CC / CB / Codex clients see in the system message.
 *
 *   - **structured** (5-segment split `{skills, memory, ...}`): reserved for future WorkBuddy-specific
 *     renderer (enabled when needing to split by segment). The current pipeline main chain **cannot use** this
 *     mode (pipeline output is a single text, cannot be split back into 5 segments; misuse will stuff the whole segment into
 *     the single `<available_skills>` tag and get XML escaped, the model won't understand it).
 *
 * See docs/workbuddy-recon/ and the module doc of codex-injection.ts in this directory for details.
 */

// ── XML escape ───────────────────────────────────────────────────────────────

/**
 * XML entity encode: escape < > & " ' five special XML characters.
 * Only used in structured mode; raw mode (current main chain) does not escape.
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── Segments ─────────────────────────────────────────────────────────────────

/** Sub-segment definition for structured mode: tag name + corresponding input field name. Order is rendering order. */
const SEGMENTS: Array<{ tag: string; field: keyof WorkbuddyInjectionInputStructured }> = [
  { tag: "available_skills", field: "skills" },
  { tag: "user_memory", field: "memory" },
  { tag: "agents", field: "agents" },
  { tag: "tasks", field: "tasks" },
  { tag: "knowledge", field: "knowledge" },
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Raw mode input: complete XML text string already produced by the pipeline (no secondary escaping / wrapping).
 * Current WorkBuddy handler takes this path.
 */
export interface WorkbuddyInjectionInputRaw {
  raw: string;
}

/**
 * Structured mode input: 5-segment split (reserved for future WorkBuddy-specific renderer).
 * ⚠️ Do not use for current pipeline main chain.
 */
export interface WorkbuddyInjectionInputStructured {
  skills?: string;
  memory?: string;
  agents?: string;
  tasks?: string;
  knowledge?: string;
}

/**
 * `buildWorkbuddyInjectionBlock` input: raw / structured either one.
 * Passing `{raw}` → raw mode, embedded as-is; otherwise treated as structured, rendered splitting into 5 segments.
 */
export type WorkbuddyInjectionInput =
  | WorkbuddyInjectionInputRaw
  | WorkbuddyInjectionInputStructured;

/**
 * Build `<tdai_injections>` wrapper, returns an input_text object that can be pushed directly
 * to WorkBuddy `body.input[0].content` array.
 *
 * - raw mode: `{raw: "..."}` → embedded as-is into inner wrapper layer, no escape, no child tags added
 * - structured mode: `{skills, memory, ...}` → each segment wrapped with corresponding tag + XML escaped content,
 *   empty segments (empty string / undefined) omitted
 * - still returns empty wrapper `<tdai_injections>\n</tdai_injections>` when no content
 */
export function buildWorkbuddyInjectionBlock(
  input: WorkbuddyInjectionInput,
): { type: "input_text"; text: string } {
  // Raw mode: directly embed, do no processing
  if (isRawInput(input)) {
    const raw = input.raw ?? "";
    const inner = raw.length > 0 ? "\n" + raw + "\n" : "\n";
    return { type: "input_text", text: `<tdai_injections>${inner}</tdai_injections>` };
  }

  // Structured mode: 5-segment split + XML escape content
  const parts: string[] = [];
  for (const seg of SEGMENTS) {
    const raw = input[seg.field];
    if (!raw) continue;
    parts.push(`<${seg.tag}>\n${xmlEscape(raw)}\n</${seg.tag}>`);
  }
  const inner = parts.length > 0 ? "\n" + parts.join("\n\n") + "\n" : "\n";
  return { type: "input_text", text: `<tdai_injections>${inner}</tdai_injections>` };
}

function isRawInput(input: WorkbuddyInjectionInput): input is WorkbuddyInjectionInputRaw {
  return typeof (input as WorkbuddyInjectionInputRaw).raw === "string";
}
