/**
 * opencode client adapter.
 *
 * Background (2026-08-19 official docs https://opencode.ai/docs/providers/):
 *
 *   - Open source terminal AI programming Agent (sst/opencode), supports 75+ providers
 *   - Users select provider in `opencode.json`, most scenarios hit custom baseURL via AI SDK
 *     `@ai-sdk/openai-compatible`, i.e., **standard OpenAI
 *     Chat Completions** (`POST /v1/chat/completions`)
 *   - A few models use Responses API of `@ai-sdk/openai`; scenarios covering anthropic baseURL
 *     use `/v1/messages`. This adapter **only covers the mainstream chat/completions scenarios**
 *   - Same family protocol as codebuddy / dsh
 *
 * # Differences from existing openai-chat clients
 *
 *   - CodeBuddy: content always string, embeds `<user_query>` / `<additional_data>`
 *     / `<user_info>` wrapper — needs stripping via `extractUserQueryText`
 *   - dsh: content always string, **bare text** no wrapper — returns directly
 *   - opencode: No packet capture evidence yet. **Inferred from project positioning (universal CLI) to be closer to dsh**:
 *     Won't embed private wrappers, user input should be bare text
 *
 *   Conservative strategy: Use `extractUserQueryText`.
 *   — This function returns "pure string without wrapper" as is, and can handle if future opencode
 *     actually embeds a wrapper (forward-compatible); zero regression for both shapes.
 *
 * # Two adaptation points
 *   - `classifyRequest`: Constant `"main"` (opencode is a universal CLI, no fork/aux semantics)
 *   - `extractUserText`: String → extractUserQueryText strip; Array → default fallback
 *
 * # Relationship with codebuddy adapter
 *
 *   Implementation is almost identical (same protocol + same fallback strategy). Intentionally kept as a separate file rather than alias/reusing
 *   codebuddyAdapter, reasons:
 *   1. If future opencode reveals private signals (aux endpoint, exclusive header), it needs independent evolution
 *   2. Semantic clarity: agentKind === "opencode" facilitates telemetry attribution
 *
 * TODO(Packet capture evidence): Wait for users to run opencode in production, capture a real request,
 *   verify:
 *     (a) Is content bare text (no wrapper) → If yes, can switch to dsh style
 *         `content.length > 0 ? content : null`, avoiding wrapper stripping overhead
 *     (b) Any aux semantic endpoint or exclusive header (if yes → add to classifyRequest)
 */

import { extractUserQueryText } from "../common/user-query-extractor.js";
import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

export const opencodeAdapter: AgentAdapter = {
  agentKind: "opencode",

  classifyRequest(_body?, _path?, _headers?) {
    // opencode is a universal CLI, no fork/sidequery semantic signals observed; main conversations + possible
    // system summaries are all treated as main, universal capabilities (injection + L0 + mem interception + skill buffer)
    // fully open. Expand here if aux endpoints (like title-gen / summary) are discovered in the future.
    return "main";
  },

  extractUserText(content) {
    // Mainstream scenario: openai-compatible provider -> content is string
    if (typeof content !== "string") {
      // If opencode changes to content-blocks array in the future, fallback to default (concatenate all text)
      return defaultAdapter.extractUserText(content);
    }
    // Conservative strip: returns as is when no wrapper, extracts based on <user_query> if wrapper exists
    const extracted = extractUserQueryText(content);
    return extracted.length > 0 ? extracted : null;
  },
};
