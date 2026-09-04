/**
 * mem-command module unified entry point
 *
 * Provides:
 *  - parseMemCommand()  — Detects if it's a mem: command
 *  - executeMemCommand() — Executes the command and returns the result
 *  - isMemCommandEnabled() — Checks the configuration switch
 */

import type { MemCommandConfig } from "../types.js";
import type { MemCommandContext, MemCommandResult } from "./types.js";
import { parseMemCommand, parseCommandFromText, type ParsedMemCommand } from "./parser.js";
import { buildMemResponse } from "./response-builder.js";
import { executeHelp } from "./commands/help.js";
import { executeSync } from "./commands/sync.js";
import { executeCreateSkill } from "./commands/create-skill.js";
import { executeCreateTask } from "./commands/create-task.js";
import { executeUpdateTask } from "./commands/update-task.js";
import { executeSessionReset } from "./commands/session-reset.js";

export { parseMemCommand, parseCommandFromText, type ParsedMemCommand } from "./parser.js";
export { buildMemResponse } from "./response-builder.js";
export type { MemCommandContext, MemCommandResult, MemCommandName, MemCommandMessage } from "./types.js";
export { getHelpText } from "./commands/help.js";
export { extractSimpleMessages, truncateArgs } from "./utils.js";

/** Known command list */
const KNOWN_COMMANDS = new Set([
  "sync",
  "create-skill",
  "create-task",
  "update-task",
  "session-reset",
  "help",
]);

/**
 * Checks if the memCommand feature is enabled, and if the command is in the allowlist.
 */
export function isMemCommandAllowed(config: MemCommandConfig, command: string): boolean {
  if (!config.enabled) return false;
  // session-reset is exempt from the allowlist (session management command)
  if (command === "session-reset") return true;
  if (config.allowedCommands.length === 0) return true;
  return config.allowedCommands.includes(command);
}

/**
 * Executes a parsed mem: command.
 * The caller has already confirmed that isMemCommandAllowed passes.
 */
export async function executeMemCommand(
  cmd: ParsedMemCommand,
  ctx: MemCommandContext,
): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  // Unknown command
  if (!KNOWN_COMMANDS.has(cmd.command)) {
    const text = `❌ 未知命令：\`mem:${cmd.command}\`。输入 \`mem:help\` 查看可用命令。`;
    return {
      success: false,
      messageText: text,
      response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }),
    };
  }

  switch (cmd.command) {
    case "help":
      return executeHelp(ctx);
    case "sync":
      return executeSync(ctx);
    case "create-skill":
      return executeCreateSkill(ctx);
    case "create-task":
      return executeCreateTask(ctx);
    case "update-task":
      return executeUpdateTask(ctx);
    case "session-reset":
      return executeSessionReset(ctx);
    default: {
      const text = `❌ 未知命令：\`mem:${cmd.command}\``;
      return {
        success: false,
        messageText: text,
        response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }),
      };
    }
  }
}
