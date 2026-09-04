/**
 * Agent Adapter - Abstracts a layer of adaptation based on the different behaviors
 * of CC clients / CodeBuddy / other IDE clients.
 *
 * Background: Different clients inject different things into requests:
 *   - Claude Code (anthropic protocol): user content is a multi-text block array, often
 *     prepended with <system-reminder> / <local-command-*> metadata, the last text block
 *     is the actual user input; fork requests (SUGGESTION/RECAP/COMPACT) differ from main
 *     conversations at the cache_control marker position (n-2 vs n-1).
 *   - CodeBuddy (openai protocol): user content is usually a string, potentially mixed with
 *     CB internal tags - structure differs significantly from CC.
 *   - Others (cursor / windsurf / custom SDKs): unresearched.
 *
 * Three places in the proxy require client-based adaptation:
 *   1. Classify request type (main / fork / sidequery) - determines which path subsequent stages take
 *   2. Extract "actual user typed text" from user message content - used by mem command recognition /
 *      skill buffer normalization
 *
 * Universal capabilities (skill_buffer write, L0 memory, mem interception) must be open to all
 * clients, only the **rules for extracting user input** and **classification rules** are adapted per agent.
 */

export type AgentKind = "claude-code" | "codebuddy" | "codex" | "workbuddy" | "dsh" | "opencode" | "pi" | "unknown";

export type RequestKind = "main" | "fork" | "sidequery" | "auxiliary";

export interface AgentAdapter {
  /** Client type identifier, mapped from URL prefix. */
  readonly agentKind: AgentKind;

  /**
   * Classify request type. Used by handler to determine if subsequent stages bypass injection / mem interception /
   * L0 / skill buffer and other business side effects.
   *
   * - claude-code: Based on cache_control marker position + tools/thinking fallback 3-way split
   *   (See docs/design/2026-07-30-cc-request-routing-plan.md)
   * - codebuddy / unknown: Always returns "main" - unresearched classification rules for this client, conservative
   *   fallback to old logic equivalent to current state (routing disabled)
   */
  classifyRequest(
    body: Record<string, unknown>,
    path?: string,
    headers?: Record<string, string>,
  ): RequestKind;

  /**
   * Extract "actual user typed text" from the user message content.
   *
   * - claude-code: Takes the last type:"text" block (skips preceding <system-reminder>
   *   and other CC internal metadata, skips tool_result / image / thinking and other block types)
   * - codebuddy / unknown: Conservatively uses the old "content to string" logic, equivalent to current state
   *
   * Returns null if "no user typed text in content" (e.g. entirely tool_result).
   */
  extractUserText(content: unknown): string | null;
}
