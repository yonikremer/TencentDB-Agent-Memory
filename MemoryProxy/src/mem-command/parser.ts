/**
 * mem: command parser
 *
 * Detects if the last user message in the request body.messages is a mem: command.
 *
 * Rules:
 * 1. Takes the last message with role="user" from the messages array
 * 2. Extracts the real user input based on client rules via agentAdapter.extractUserText:
 *    - claude-code: Takes the last text block (skips <system-reminder> prefix metadata)
 *    - codebuddy / unknown: Uses a conservative "concatenate all text" (pending capture adaptation)
 * 3. After trimming, starts with "mem:" (case-insensitive)
 * 4. The entire message is the command (not embedded in other text)
 */

import { resolveAgentAdapter } from "../agent-adapters/index.js";

export interface ParsedMemCommand {
  /** Command name (lowercase), e.g., "sync", "create-skill", "help" */
  command: string;
  /** Parameter text after the command (e.g., prompt for create-skill) */
  args: string;
  /** Original user message (used for auditing / L0 writing) */
  rawMessage: string;
}

/**
 * Known mem command args constraint table.
 * - `false`: Command **strictly matches** — no non-whitespace content is allowed after the command (e.g., `mem:help hello` is treated
 *   as a normal conversation, passed through to the upstream LLM instead of being intercepted).
 * - `true`: Command **accepts optional args** — `mem:create-skill database migration summary` matches and carries
 *   args; `mem:create-skill` (no args) also matches.
 *
 * Commands not listed (user typos like `mem:helpp` / `mem:foo`) are not affected by this validation — parser
 * still returns ParsedMemCommand, handing it over to the `executeMemCommand` "unknown command" branch to feedback
 * `❌ Unknown command mem:xxx, type mem:help to view`, providing a fallback for user typos.
 */
const MEM_COMMANDS_ARGS: Record<string, boolean> = {
  help: false,
  sync: false,
  "create-skill": true,
  // task command family: args semantics align with create-skill — acts as an additional prompt (reason) for LLM to generate title/description;
  // empty args means purely auto-generating from the last 30 contexts.
  "create-task": true,
  "update-task": true,
  "session-reset": false,
};

/**
 * Detects if it's a mem: command from the request body.
 * Returns null if it's not a mem: command, continuing the normal flow.
 *
 * ⚠️ Only supports body.messages[] format (CC/CB). Codex uses body.input[],
 * so the caller (codexHandler) should first use `codexAdapter.extractUserText(input)` to get
 * the text, then directly call `parseCommandFromText(text)` (skipping the body parsing step).
 *
 * @param body - Request body (including messages array)
 * @param agentSource - Client type (URL prefix), used to select agentAdapter
 * @param options.checkFirst - If true, checks the first user message instead of the last.
 *   Used for scenarios where session init just finished: the last is the init interaction reply, and the first is the user's original command.
 */
export function parseMemCommand(
  body: Record<string, unknown>,
  agentSource: string,
  options?: { checkFirst?: boolean },
): ParsedMemCommand | null {
  const messages = (body as any)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  // Get target message: default is the last one, if checkFirst is true, get the first user message
  let targetMsg: any;
  if (options?.checkFirst) {
    targetMsg = messages.find((m: any) => m && m.role === "user");
  } else {
    targetMsg = messages[messages.length - 1];
  }
  if (!targetMsg || targetMsg.role !== "user") return null;
  const lastMsg = targetMsg;

  // Extract plain text based on client rules via adapter
  const adapter = resolveAgentAdapter(agentSource);
  const text = adapter.extractUserText(lastMsg.content);
  if (text === null) return null;

  return parseCommandFromText(text);
}

/**
 * Determines if it's a mem: command from the extracted user text.
 *
 * This layer is extracted so that the codex handler can reuse the same mem command semantics:
 * codex body uses `input[]` instead of `messages[]`, and the path of parseMemCommand starting from body
 * couldn't recognize codex early on, directly returning null, which caused all mem:xxx to be silently passed to
 * the LLM, and the model fabricated fake replies like "Memory synced" (P0-1 QA report). Now the codex handler
 * gets the text with `codexAdapter.extractUserText(input)` and directly calls this function.
 *
 * The `parseMemCommand(body, agentSource)` for CC/CB also goes through this path internally, and the behavior
 * remains completely unchanged.
 */
export function parseCommandFromText(text: string): ParsedMemCommand | null {
  // Judge after trimming
  const trimmed = text.trim();

  // Must start with mem: (case-insensitive)
  if (!trimmed.toLowerCase().startsWith("mem:")) return null;

  // Extract the command part (content after mem:)
  const afterPrefix = trimmed.slice(4); // Remove "mem:"

  // Compatible with optional space after the colon
  const stripped = afterPrefix.trimStart();

  // Split command name and parameters (split by the first space)
  const spaceIdx = stripped.indexOf(" ");
  let command: string;
  let args: string;

  if (spaceIdx === -1) {
    command = stripped;
    args = "";
  } else {
    command = stripped.slice(0, spaceIdx);
    args = stripped.slice(spaceIdx + 1).trim();
  }

  command = command.toLowerCase();

  // Command name cannot be empty
  if (!command) return null;

  // Strict args validation for known commands: when the command doesn't accept args, non-empty args is treated as a normal conversation.
  // Example: `mem:help hello` → User "entered mem:help and asked a question at the same time", which should go to the upstream
  // LLM for a normal reply, instead of returning the help text. Unknown commands are not bound by this (see MEM_COMMANDS_ARGS explanation).
  if (MEM_COMMANDS_ARGS[command] === false && args.length > 0) {
    return null;
  }

  return { command, args, rawMessage: trimmed };
}
