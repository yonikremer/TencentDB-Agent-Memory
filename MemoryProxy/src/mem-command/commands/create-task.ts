/**
 * mem:create-task — Generates a Task from the current session context and binds it to this session.
 *
 * Interaction (aligned with TAPD requirement "user confirmation" gate):
 *
 *   ┌ Session has no real task bound:
 *   │    No params → LLM generates title+desc → saved to DB + bound directly (no confirm needed)
 *   │    With params → title = user param (≤40 chars), LLM only generates desc → saved to DB + bound directly
 *   │            LLM fails → degrades: desc left empty, task still saved to DB
 *   │
 *   ├ Session already has a real task bound:
 *   │    Generates new draft → writes to pending-store (TTL 5 mins) → returns "Preview + choose one of three":
 *   │      1) mem:create-task confirm — Overwrite binding, create new
 *   │      2) mem:update-task [new_description] — Continue reusing current Task, just update description
 *   │      3) mem:create-task cancel — Abort
 *   │
 *   ├ `mem:create-task confirm`:
 *   │    Retrieves draft from pending → creates new task → overwrites session binding → clears pending
 *   │
 *   └ `mem:create-task cancel`:
 *        Clears pending, does not save to DB
 *
 * Parameter parsing:
 *   - `confirm` / `cancel` (case-insensitive) appearing alone are treated as subcommands
 *   - Any other args are unconditionally treated as lockedTitle (title hint for the first call)
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import {
  cancelPendingTaskAction,
  confirmPendingTaskAction,
  createTaskFromSession,
} from "../../routes/session-task.js";

const DESC_PREVIEW_LEN = 200;
const TITLE_MAX_LEN = 40;

function trimDesc(desc: string | undefined | null): string {
  const text = desc ?? "";
  if (text.length === 0) return "(Empty)";
  return text.length > DESC_PREVIEW_LEN ? `${text.slice(0, DESC_PREVIEW_LEN)}...` : text;
}

function truncateTitle(raw: string): string {
  const s = raw.trim();
  return s.length > TITLE_MAX_LEN ? s.slice(0, TITLE_MAX_LEN) : s;
}

/** Determines if args is a confirm / cancel subcommand. Only matches if strictly equal after trimming. */
function parseSubcommand(args: string): "confirm" | "cancel" | null {
  const s = args.trim().toLowerCase();
  if (s === "confirm") return "confirm";
  if (s === "cancel") return "cancel";
  return null;
}

export async function executeCreateTask(ctx: MemCommandContext): Promise<MemCommandResult> {
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

  // ── confirm branch ────────────────────────────────────────────────────────
  if (subcommand === "confirm") {
    const result = await confirmPendingTaskAction({
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      config: ctx.config,
      spaceId: ctx.spaceId,
    });

    if (result.noPending) {
      return finalize(
        `⚠️ No pending Task action to confirm (it may have timed out or been cancelled). Please re-run \`mem:create-task [title]\`.`,
        false,
        { reason: "no_pending" },
      );
    }
    if (!result.success) {
      return finalize(
        `❌ Task creation failed: ${result.error ?? "unknown error"}`,
        false,
        { reason: "create_failed", detail: result.error },
      );
    }

    const prevLine = result.previousTaskId
      ? `\n\n(Unbound from previous Task \`${result.previousTaskId}\`)`
      : "";
    return finalize(
      `✅ New Task created and bound.\n\n` +
        `- **Title**: ${result.title}\n` +
        `- **Status**: ${result.status ?? "running"}\n` +
        `- **Description**: ${trimDesc(result.description)}\n` +
        `- **Task ID**: \`${result.taskId}\`${prevLine}`,
      true,
      {
        task_id: result.taskId,
        title: result.title,
        description: result.description,
        status: result.status,
        ...(result.previousTaskId ? { previous_task_id: result.previousTaskId } : {}),
        ...(result.error ? { bind_warning: result.error } : {}),
      },
    );
  }

  // ── cancel branch ─────────────────────────────────────────────────────────
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
      ? `✅ Cancelled pending Task action.`
      : `ℹ️ No pending Task action to cancel.`;
    return finalize(msg, true, { cancelled: result.cancelled ?? false });
  }

  // ── First call branch ────────────────────────────────────────────────────────

  const lockedTitle = rawArgs.length > 0 ? truncateTitle(rawArgs) : undefined;

  if (recentMessages.length === 0) {
    return finalize(
      `⚠️ The current request contains no conversation messages. \`mem:create-task\` requires recent conversation as context to generate a Task.` +
        `\n\nTip: Please have a few rounds of conversation with the AI before executing this command.`,
      false,
      { reason: "no_recent_messages" },
    );
  }

  const result = await createTaskFromSession({
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    config: ctx.config,
    spaceId: ctx.spaceId,
    recentMessages,
    ...(lockedTitle ? { lockedTitle, hint: rawArgs } : {}),
  });

  // DB save failed
  if (!result.success) {
    const detail = result.error ?? "unknown error";
    const hintLine = lockedTitle
      ? ""
      : "\n\nYou can:\n1. Retry later\n2. Manually specify the title with `mem:create-task <your title>` (LLM only generates the description, and falls back to an empty description even if it fails)";
    return finalize(
      `❌ Task creation failed: ${detail}${hintLine}`,
      false,
      { reason: "create_failed", detail },
    );
  }

  // Already bound branch: pending preview
  if (result.pending && result.pending.kind === "create") {
    const p = result.pending;
    const currentLine = p.currentTaskTitle
      ? `\`${p.currentTaskId}\`「${p.currentTaskTitle}」`
      : `\`${p.currentTaskId}\``;
    return finalize(
      `⚠️ Current session is already bound to Task ${currentLine}.\n\n` +
        `**New Task Preview**\n` +
        `- Title: ${p.draftTitle}\n` +
        `- Description: ${trimDesc(p.draftDescription)}\n\n` +
        `Please select next step:\n` +
        `1. \`mem:create-task confirm\` — Overwrite current binding, create new Task\n` +
        `2. \`mem:update-task\` or \`mem:update-task <new description>\` — Continue reusing current Task, update description only (no new Task)\n` +
        `3. \`mem:create-task cancel\` — Cancel, make no changes`,
      true,
      {
        reason: "pending",
        pending: {
          kind: "create",
          draft_title: p.draftTitle,
          draft_description: p.draftDescription,
          current_task_id: p.currentTaskId,
          ...(p.currentTaskTitle ? { current_task_title: p.currentTaskTitle } : {}),
        },
      },
    );
  }

  // Unbound branch: DB save successful immediately
  return finalize(
    `✅ Task created and bound to this session.\n\n` +
      `- **Title**: ${result.title}\n` +
      `- **Status**: ${result.status ?? "running"}\n` +
      `- **Description**: ${trimDesc(result.description)}\n` +
      `- **Task ID**: \`${result.taskId}\`\n\n` +
      `You can use \`mem:update-task\` to add progress later.`,
    true,
    {
      task_id: result.taskId,
      title: result.title,
      description: result.description,
      status: result.status,
      ...(result.error ? { bind_warning: result.error } : {}),
    },
  );
}
