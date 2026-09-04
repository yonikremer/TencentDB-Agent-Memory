/**
 * Extractor for "text actually typed by the user" in user message content.
 *
 * Background: The `content` of each user message from Claude Code CLI is often a multi-block array,
 * stuffed with CC internal environment metadata like `<system-reminder>` at the front, and only the last `type:"text"` block
 * is the real user input. Other blocks like tool_result / image / thinking are not typed by the user.
 *
 * Usage points (**only** under anthropic protocol, CC client path invocation):
 *   - `mem-command/parser.ts` — Determine if it's a `mem:` command prefix
 *   - `skill/normalize-conversation.ts` (anthropic user branch) — Only push the last paragraph of user speech to skill core
 *
 * CodeBuddy (openai protocol) keeps the existing logic unchanged, and does not reuse this helper.
 */

export function extractLastUserText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  // Scan from back to front, find the first block with type:"text" and text is string
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i];
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (block.type !== "text") continue;
    if (typeof block.text !== "string") continue;
    return block.text;
  }
  return null;
}
