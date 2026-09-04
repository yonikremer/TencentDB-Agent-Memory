/**
 * mem:update-task — Updates the bound Task.
 *
 * Interaction (requires user confirmation every time):
 *
 *   ┌ Session unbound → intercepts, guides to mem:create-task
 *   ├ First call (no confirm/cancel subcommand):
 *   │    With params → description directly replaced (skips LLM) → writes pending → preview
 *   │    No params → LLM diffs to generate new desc + status suggestion → writes pending → preview
 *   │            LLM determines changed=false → returns "no update needed", doesn't write pending
 *   ├ `mem:update-task confirm` → takes from pending → updateTask (passes status through) → clears pending
 *   └ `mem:update-task cancel`  → clears pending
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import {
  cancelPendingTaskAction,
  confirmPendingTaskAction,
  updateTaskFromSession,
} from "../../routes/session-task.js";

const DESC_PREVIEW_LEN = 200;

function trimDesc(desc: string | undefined | null): string {
  const text = desc ?? "";
  if (text.length === 0) return "(Empty)";
  return text.length > DESC_PREVIEW_LEN ? `${text.slice(0, DESC_PREVIEW_LEN)}...` : text;
}

function parseSubcommand(args: string): "confirm" | "cancel" | null {
  const s = args.trim().toLowerCase();
  if (s === "confirm") return "confirm";
  if (s === "cancel") return "cancel";
  return null;
}

export async function executeUpdateTask(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const recentMessages = ctx.bodyMessages ?? [];
  const rawArgs = (ctx.args ?? "").trim();

  const finalize = (
    messageText: string,
    success: boolean,
    data: Record<string, unknown>,
  ): MemCommandResult => {
    const response = buildMemResponse(messageText, {
      protocol: ctx.protocol,
      stream: ctx.stream,
      requestId,
      thinking: ctx.thinking,
    });
    return { success, messageText, data, response };
  };

  const subcommand = parseSubcommand(rawArgs);

  // ── confirm ─────────────────────────────────────────────────────────────
  if (subcommand === "confirm") {
    const result = await confirmPendingTaskAction({
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      config: ctx.config,
      spaceId: ctx.spaceId,
    });

    if (result.noPending) {
      return finalize(
        `⚠️ No pending Task update to confirm (it may have timed out or been cancelled). Please re-run \`mem:update-task [supplement]\`.`,
        false,
        { reason: "no_pending" },
      );
    }
    if (!result.success) {
      return finalize(
        `❌ Task update failed: ${result.error ?? "unknown error"}`,
        false,
        { reason: "update_failed", detail: result.error },
      );
    }

    return finalize(
      `✅ Task updated.\n\n` +
        `- **Title**: ${result.title} (Immutable)\n` +
        `- **Status**: ${result.status ?? "running"}\n` +
        `- **New Description**: ${trimDesc(result.description)}\n` +
        `- **Task ID**: \`${result.taskId}\``,
      true,
      {
        task_id: result.taskId,
        title: result.title,
        description: result.description,
        status: result.status,
      },
    );
  }

  // ── cancel ──────────────────────────────────────────────────────────────
  if (subcommand === "cancel") {
    const result = await cancelPendingTaskAction({
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      config: ctx.config,
      spaceId: ctx.spaceId,
    });
    if (!result.success) {
      return finalize(
        `⚠️ Cancel failed: ${result.error ?? "unknown"}`,
        false,
        { reason: "cancel_failed", detail: result.error },
      );
    }
    const msg = result.cancelled
      ? `✅ Cancelled pending Task update.`
      : `ℹ️ No pending Task update to cancel.`;
    return finalize(msg, true, { cancelled: result.cancelled ?? false });
  }

  // ── First call ────────────────────────────────────────────────────────────

  const directDescription = rawArgs.length > 0 ? rawArgs : undefined;

  if (!directDescription && recentMessages.length === 0) {
    return finalize(
      `⚠️ Current request contains no conversation messages. The parameterless \`mem:update-task\` requires recent conversation as context.` +
        `\n\nYou can directly: \`mem:update-task <your supplemental description>\` manually specifying the new description.`,
      false,
      { reason: "no_recent_messages" },
    );
  }

  const result = await updateTaskFromSession({
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    config: ctx.config,
    spaceId: ctx.spaceId,
    recentMessages,
    ...(directDescription ? { directDescription, hint: rawArgs } : {}),
  });

  // Unbound
  if (!result.success && result.error?.includes("no task bound")) {
    return finalize(
      `⚠️ The current session is not bound to a Task. Please execute \`mem:create-task\` to create a Task before updating.`,
      false,
      { reason: "no_task_bound" },
    );
  }

  // Cross-user update: not supported by kernel, proxy intercepts early and suggests creating new
  if (!result.success && result.error === "not_creator") {
    return finalize(
      `❌ Cannot update: You didn't create this Task, cross-user modification is not supported currently.\n\n` +
        `If you need to create a Task belonging to you based on the current session, please use \`mem:create-task\`.`,
      false,
      { reason: "not_creator" },
    );
  }

  // Other errors
  if (!result.success) {
    const detail = result.error ?? "unknown error";
    const hintLine = directDescription
      ? ""
      : "\n\nYou can:\n1. Retry later\n2. `mem:update-task <your supplement>` manually specifying the new description";
    return finalize(
      `❌ Task update failed: ${detail}${hintLine}`,
      false,
      { reason: "update_failed", detail },
    );
  }

  // LLM determines no update needed
  if (result.noUpdateNeeded) {
    return finalize(
      `ℹ️ Task needs no update — recent conversation produced no new progress or scope changes.\n\n` +
        `Task ID: \`${result.taskId}\`\n` +
        `You can execute \`mem:update-task [supplement]\` later to trigger judgment, or explicitly pass parameters to force update.`,
      true,
      { reason: "no_update_needed", task_id: result.taskId },
    );
  }

  // First call: pending preview
  if (result.pending && result.pending.kind === "update") {
    const p = result.pending;
    const statusLine = p.statusSuggestion
      ? `\n- Status suggestion: ${p.statusSuggestion}`
      : "";
    return finalize(
      `📝 Task "${p.currentTitle ?? p.taskId}" update preview:\n\n` +
        `- New Description: ${trimDesc(p.draftDescription)}${statusLine}\n\n` +
        `Reply \`mem:update-task confirm\` to confirm, or \`mem:update-task cancel\` to cancel.`,
      true,
      {
        reason: "pending",
        pending: {
          kind: "update",
          task_id: p.taskId,
          draft_description: p.draftDescription,
          ...(p.statusSuggestion ? { status_suggestion: p.statusSuggestion } : {}),
          ...(p.currentTitle ? { current_title: p.currentTitle } : {}),
          ...(p.currentStatus ? { current_status: p.currentStatus } : {}),
        },
      },
    );
  }

  // Fallback (theoretically unreachable): return current status
  return finalize(
    `ℹ️ Task unchanged.\n\nTask ID: \`${result.taskId}\``,
    true,
    { task_id: result.taskId },
  );
}
