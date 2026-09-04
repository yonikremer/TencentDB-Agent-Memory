/**
 * Agent Adapter Factory.
 *
 * Returns the corresponding adapter based on the `agentSource` mapped from the URL prefix;
 * unrecognized clients return the default adapter (equivalent to conservative behavior).
 *
 * See details:
 *   - types.ts - AgentAdapter interface + explanation of the three adaptation points
 *   - claude-code.ts - CC specialized implementation (currently the only client with source/packet capture basis)
 *   - codebuddy.ts - CB stub (retains default behavior, CB specialization to be added after packet capture)
 *   - default.ts - unknown fallback
 */

import type { AgentAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codebuddyAdapter } from "./codebuddy.js";
import { codexAdapter } from "./codex.js";
import { workbuddyAdapter } from "./workbuddy.js";
import { dshAdapter } from "./dsh.js";
import { opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";
import { defaultAdapter } from "./default.js";

export type { AgentAdapter, AgentKind, RequestKind } from "./types.js";

export function resolveAgentAdapter(agentSource: string): AgentAdapter {
  switch (agentSource) {
    case "claude-code":
      return claudeCodeAdapter;
    case "codebuddy":
      return codebuddyAdapter;
    case "codex":
      return codexAdapter;
    case "workbuddy":
      return workbuddyAdapter;
    case "dsh":
      return dshAdapter;
    case "opencode":
      return opencodeAdapter;
    case "pi":
      return piAdapter;
    default:
      return defaultAdapter;
  }
}
