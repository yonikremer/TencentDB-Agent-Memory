/**
 * Default agent adapter - conservative fallback implementation for unknown/unrecognized clients
 * (cursor / windsurf / user custom SDK, etc.), behavior is equivalent to the old logic before refactoring:
 *   - classifyRequest: Always returns "main" (routing disabled)
 *   - extractUserText: Concatenates all text blocks in the content array
 *
 * When adding support for new clients in the future, write a separate adapter for it (refer to claude-code.ts),
 * and add a branch in the factory in index.ts.
 */

import type { AgentAdapter } from "./types.js";

/**
 * Concatenates all text blocks in the content array into a string, equivalent to existing `contentToString`.
 * - string input -> return directly
 * - array input -> collect text from each block, concatenate with "\n"
 * - other -> null
 */
function joinAllTextBlocks(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

export const defaultAdapter: AgentAdapter = {
  agentKind: "unknown",
  classifyRequest(_body?, _path?, _headers?) {
    return "main";
  },
  extractUserText(content) {
    return joinAllTextBlocks(content);
  },
};
