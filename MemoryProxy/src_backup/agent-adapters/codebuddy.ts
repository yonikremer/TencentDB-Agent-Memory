/**
 * CodeBuddy client adapter.
 *
 * Packet capture evidence (2026-07-30, langfuse trace `d814929a67a1ca893c7b2b40c65ccd75`
 * session `f817ea40163c4dd89ee4f5a18bba9717`):
 *
 *   - Protocol: **OpenAI** (`/codebuddy/{spaceId}/v1/chat/completions`), always stream
 *   - `message.content` **is entirely string** (common shape for 3P LLM), never uses content-block arrays
 *   - The string embeds CB pseudo-XML wrapper:
 *       * `<user_info>`         First user, OS/shell/workspace metadata
 *       * `<additional_data>`   Every user, auxiliary segments like current_time
 *       * `<user_query>...</user_query>`  **Anchor for actual user input**
 *       * `<question_answer>` / `<title>` / `<questions>` / `<answers>`
 *                              session-init form backfill
 *   - assistant message content is often a placeholder `"-"` (when LLM only calls tools without text output)
 *   - **No `cache_control` marker, no fork/sidequery concept** - CC's 3-way split
 *     is completely inapplicable to CB, all requests are `main`
 *   - Tools stably at 26 (`list_dir` / `search_file` / `read_file` / `execute_command` ...)
 *   - CB specific headers: `x-agent-intent` / `x-conversation-id` /
 *     `x-conversation-message-id` / `x-conversation-request-id`
 *
 * Two adaptation points:
 *   - `classifyRequest`: Constant `"main"` (supported by packet capture evidence, no longer "stub fallback")
 *   - `extractUserText`: Uses shared `extractUserQueryText` (prioritizes `<user_query>`
 *     block; if absent, extracts the remaining part after stripping the wrapper. Uses the same
 *     semantics as tdai L0 / mem-command to avoid drift)
 *
 * See docs/design/2026-07-30-cc-request-routing-plan.md Appendix (CodeBuddy Analysis).
 */

import { extractUserQueryText } from "../common/user-query-extractor.js";
import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

export const codebuddyAdapter: AgentAdapter = {
  agentKind: "codebuddy",

  classifyRequest(_body?, _path?, _headers?) {
    // Packet capture evidence: CB requests lack cache_control marker, tools are stably at 26, no CC
    // fork/sidequery routing characteristics. All requests are main conversations, taking the full path (injection + L0 + skill).
    return "main";
  },

  extractUserText(content) {
    // CB content has always been a string. If CB suddenly changes to an array in the future, fallback to default
    // (concatenate all text blocks) to avoid active crashes.
    if (typeof content !== "string") {
      return defaultAdapter.extractUserText(content);
    }
    const extracted = extractUserQueryText(content);
    return extracted.length > 0 ? extracted : null;
  },
};
