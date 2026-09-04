/**
 * mem:sync — Refresh all injection caches for the current session
 *
 * Underlying actions covered:
 *   - Re-fetch Agent / Task details and overwrite into SessionStore (description, prompt, goal all update)
 *   - Re-run all hooks declaring session_init / hybrid cache strategies (Skill / Memory /
 *     Knowledge / Fixed assets etc.), putting new blocks to HookCacheRepo (COS)
 *
 * User-facing text only mentions concepts they understand like "assets / description", avoiding internal
 * jargon like injector id, hook name, archive_key etc.
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { refreshSessionCache, type RefreshResult } from "../../routes/session-refresh.js";

function buildSuccessMessage(result: RefreshResult): string {
  const parts: string[] = [];
  parts.push("Skill / Memory / Knowledge assets");
  if (result.agentRefreshed || result.taskRefreshed) {
    parts.push("Task & Agent description");
  }
  const scope = parts.join(", ");
  return `✅ All asset injections refreshed (${scope}), took ${result.tookMs}ms`;
}

export async function executeSync(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  // When not bound, don't run refreshSessionCache (which would expose session key to user)
  if (!ctx.sessionInfo || Object.keys(ctx.sessionInfo).length === 0) {
    const messageText = "⚠️ No team assets bound to the current session, cannot sync. Please use `mem:session-reset` to select a Team/Agent first.";
    return {
      success: false,
      messageText,
      response: buildMemResponse(messageText, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }),
    };
  }

  const result = await refreshSessionCache({
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    config: ctx.config,
    spaceId: ctx.spaceId,
    callerUserKey: ctx.apiKey,
  });

  const messageText = result.success
    ? buildSuccessMessage(result)
    : `❌ Asset refresh failed: ${result.error ?? "unknown error"}`;

  const response = buildMemResponse(messageText, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });

  return {
    success: result.success,
    messageText,
    // Detailed hookId list / duration are kept in structured data for panel/logs use.
    data: result.success
      ? {
          refreshed: result.refreshed,
          skipped: result.skipped,
          agent_refreshed: result.agentRefreshed,
          task_refreshed: result.taskRefreshed,
          took_ms: result.tookMs,
        }
      : undefined,
    response,
  };
}
