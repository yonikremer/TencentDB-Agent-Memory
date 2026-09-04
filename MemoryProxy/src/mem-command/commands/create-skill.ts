/**
 * mem:create-skill — Manually force archiving of the current session buffer.
 *
 * Text convention: Only inform the user of concepts like "Archive triggered / Skill extracting", without exposing internal details
 * such as task_id, archive_key, file paths, etc. For troubleshooting, look at the `data` field or backend logs.
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { forceArchiveSkill } from "../../routes/session-force-archive.js";

export async function executeCreateSkill(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  const result = await forceArchiveSkill({
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    config: ctx.config,
    spaceId: ctx.spaceId,
    reason: ctx.args || undefined,
  });

  let messageText: string;

  if (!result.success) {
    messageText = `❌ Archiving of this conversation failed: ${result.error ?? "unknown error"}`;
  } else if (result.status === "empty") {
    messageText = `⚠️ There is currently nothing to archive in this conversation, please try again after continuing the conversation`;
  } else {
    messageText = `✅ This conversation has been successfully archived, extracting Skill...`;
  }

  const response = buildMemResponse(messageText, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });

  return {
    success: result.success,
    messageText,
    // task_id / archive_key are still retained in structured data — readable by panel/logs/e2e,
    // just no longer concatenated into user-visible text.
    data: result.success
      ? { status: result.status, task_id: result.taskId, archive_key: result.archiveKey }
      : undefined,
    response,
  };
}
