/**
 * mem-command module type definitions
 */

import type { ProxyConfig, MemCommandConfig } from "../types.js";

/**
 * Recent conversation message snippet. Consumed by task-draft-generator.
 * Currently only needs role + content, without tool_calls / attachment, kept minimal.
 */
export interface MemCommandMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface MemCommandContext {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  userId: string;
  apiKey: string;
  sessionInfo: Record<string, unknown>;
  protocol: "anthropic" | "openai" | "responses";
  stream: boolean;
  /** Command parameters (e.g., prompt words for create-skill / create-task) */
  args: string;
  /** Whether the request enabled extended thinking (Anthropic only) */
  thinking?: boolean;
  /**
   * Recent conversation messages of the current request (used by task-draft-generator to generate drafts).
   *
   * - CC/CB goes through chat/completions: directly body.messages[]
   * - Codex/WorkBuddy goes through Responses API: currently passes an empty array (will add body.input parsing during phase 5 joint debugging)
   *
   * Treated as an empty array if not provided, task command family will return "no recent messages" error.
   */
  bodyMessages?: MemCommandMessage[];
}

/**
 * Supported mem: command names — strongly typed union, for dispatch in index.ts / narrowing in commands/*.
 * Strings not listed will fall back to "unknown command" in executeMemCommand.
 */
export type MemCommandName =
  | "help"
  | "sync"
  | "create-skill"
  | "create-task"
  | "update-task";

export interface MemCommandResult {
  success: boolean;
  /** User readable result text (written to L0 / displayed to user) */
  messageText: string;
  /** Structured data (optional) */
  data?: Record<string, unknown>;
  /** Constructed HTTP Response (faked according to protocol format) */
  response: Response;
}

export type { MemCommandConfig };
