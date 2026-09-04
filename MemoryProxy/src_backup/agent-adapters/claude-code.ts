/**
 * Claude Code CLI client adapter.
 *
 * Specialized implementation:
 *   - classifyRequest: cache_control marker position + tools/thinking 3-way split
 *     (Source: reverse engineered CC source code forkedAgent.ts / sideQuery.ts + packet capture evidence)
 *   - extractUserText: takes the last text block
 *     (CC user content often prepends multiple segments of <system-reminder> metadata, the last segment is the user input)
 *
 * See docs/design/2026-07-30-cc-request-routing-plan.md for details.
 */

import { classifyCcRequest } from "../common/cc-request-classifier.js";
import { extractLastUserText } from "../common/user-text-extractor.js";
import type { AgentAdapter } from "./types.js";

export const claudeCodeAdapter: AgentAdapter = {
  agentKind: "claude-code",
  classifyRequest(body, _path?, _headers?) {
    return classifyCcRequest(body);
  },
  extractUserText(content) {
    return extractLastUserText(content);
  },
};
