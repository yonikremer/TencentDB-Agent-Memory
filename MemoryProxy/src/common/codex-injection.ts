/**
 * Codex asset injection — `<tdai_injections>` wrapper generator.
 *
 * Appends a `{type:"input_text", text:"<tdai_injections>...\n</tdai_injections>"}` text block
 * to the end of the content[] of the codex body.input[0] (developer message).
 *
 * Two modes:
 *   - **raw** (path taken by current codex handler): the **complete finished text**
 *     already produced by the pipeline (including multiple sets of internal XML tags like
 *     `<available_skills>` / `<user_memory>` / `<tdai_profile_memory>` /
 *     `<memory-tools-guide>`) is embedded as-is into the inner layer of the wrapper, without further
 *     escaping or extra tag wrapping, completely **byte-identical** to what CC / CB clients see in the system message
 *     — the semantics learned by the model are exactly the same, no "codex-specific prompts" needed.
 *
 *   - **structured** (5-segment split `{skills, memory, ...}`): reserved for future codex-specific
 *     renderer (enabled when actually needing to split by segment, e.g., UI layer wants to render
 *     segment by segment). **The current pipeline produces a single text string, cannot be split
 *     back into 5 segments, so this mode cannot be used for the main chain** — if mistakenly used,
 *     it will stuff the complete pipeline output into a single `<available_skills>` tag, and all
 *     internal `<...>` will be XML-escaped to `&lt;...&gt;`, rendering the model unable to read it.
 *     Historical pitfalls are recorded in the P0 fix commit body.
 *
 * Why use a wrapper instead of directly appending a raw text to the pipeline output:
 *   - If issues arise, `grep '<tdai_injections>'` can locate the injected segment in one step
 *   - More convenient to compress context in the client's next round replay
 *   - Provides an anchor point if we want to add metadata inside the wrapper in future P2/P3
 *
 * See docs/2026-08-07-codex-integration-plan.md §4 for details.
 */

// ── XML escape ───────────────────────────────────────────────────────────────

/**
 * XML entity encode: escape < > & " ' five special XML characters.
 * Only used in structured mode; raw mode (current main chain) does not escape, because what is
 * passed in is already valid XML structure, escaping would turn all tags into entity characters,
 * preventing the model from reading tag semantics.
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
const SEGMENTS: Array<{ tag: string; field: keyof CodexInjectionInputStructured }> = [
  { tag: "available_skills", field: "skills" },
  { tag: "user_memory", field: "memory" },
  { tag: "agents", field: "agents" },
  { tag: "tasks", field: "tasks" },
  { tag: "knowledge", field: "knowledge" },
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Raw mode input: complete XML text string already produced by the pipeline (no secondary escaping / wrapping).
 * Current codex handler takes this path, byte-identical to the system message content of CC / CB.
 */
export interface CodexInjectionInputRaw {
  raw: string;
}

/**
 * Structured mode input: 5-segment split (reserved for future codex-specific renderer).
 * ⚠️ Do not use for current pipeline main chain — see explanation in module doc.
 */
export interface CodexInjectionInputStructured {
  skills?: string;
  memory?: string;
  agents?: string;
  tasks?: string;
  knowledge?: string;
}

/**
 * `buildCodexInjectionBlock` input: raw / structured either one.
 * Passing `{raw}` → raw mode, embedded as-is; otherwise treated as structured, rendered splitting into 5 segments.
 */
export type CodexInjectionInput = CodexInjectionInputRaw | CodexInjectionInputStructured;

/**
 * Build `<tdai_injections>` wrapper, returns an input_text object that can be pushed directly
 * to codex `body.input[0].content` array.
 *
 * - raw mode: `{raw: "..."}` → embedded as-is into inner wrapper layer, no escape, no child tags added
 * - structured mode: `{skills, memory, ...}` → each segment wrapped with corresponding tag + XML escaped content,
 *   empty segments (empty string / undefined) omitted
 * - still returns empty wrapper `<tdai_injections>\n</tdai_injections>` when no content
 */
export function buildCodexInjectionBlock(
  input: CodexInjectionInput,
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

function isRawInput(input: CodexInjectionInput): input is CodexInjectionInputRaw {
  return typeof (input as CodexInjectionInputRaw).raw === "string";
}
