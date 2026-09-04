/**
 * Claude Code Session Init Form — `AskUserQuestion` tool_use.
 *
 * Claude Code native interactive form:
 *   - Tool name: `AskUserQuestion`
 *   - Options: `{ label, description }` structure, 2-4 hard limit
 *   - Protocol: Anthropic SSE only
 *   - ID prefix: `toolu_cc_session_init_`
 *   - Pagination: 3 agents per page + 1 "More →"/SKIP slot
 *
 * Contains no CodeBuddy logic.
 */

import type { TeamOption } from "../types.js";
import { computePagination, CC_MAX_OPTIONS as CC_MAX_OPTIONS_SHARED } from "./pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const TOOL_NAME = "AskUserQuestion";
export const TOOLCALL_PREFIX = "toolu_cc_session_init_";

export const TEAM_FORM_TITLE = "Session Initialization — Select Team";
export const AGENT_TASK_FORM_TITLE = "Session Initialization — Select Agent and Task";
export const RETRY_FORM_TITLE = "Selection unrecognized, please select again";

export const SKIP_LABEL = "Do not associate this time (skip injection, proceed directly)";
export const MORE_LABEL = "More →";

export const ASSET_CONFIRM_YES = "Yes, associate team assets";
export const ASSET_CONFIRM_NO = "No, do not associate this time";
export const ASSET_CONFIRM_FORM_TITLE = "Session Initialization — Associate Team Assets?";

/**
 * General note appended to the end of each question step: informs the user that "Selecting skip = skip session init this time, inject no team assets".
 * Claude Code's AskUserQuestion provides the user with an "Other" input box, replying "skip / skip /
 * do not associate" will take the SKIP_RE bypass; unrecognized free text will be unrecognized → also bypass.
 * The copy is unified with the five endpoints of workbuddy/codex/codebuddy/dsh to avoid presentation drift across clients.
 */
const SKIP_HINT = ' (Selecting "skip" will bypass session init and inject no team assets)';

// Pagination layout is centralized in pagination.ts; only its constants are used here.
const CC_MAX_OPTIONS = CC_MAX_OPTIONS_SHARED;

/** Returns true if the given string contains any CC form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_use id belongs to a CC session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return id.startsWith(TOOLCALL_PREFIX);
}

// ── Form Data ──────────────────────────────────────────────────────────────────

export type FormStage = "asset_confirm" | "team" | "agent_select" | "agent_task" | "task_select";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  /** Claude Code Pagination: current agent page index (0-based) */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// ── Claude Code AskUserQuestion input schema ───────────────────────────────────

interface CCAskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

function buildAskUserQuestionArgs(data: FormData): { questions: CCAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: CCAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      question: titlePrefix + "Would you like to associate team assets for this conversation?" + SKIP_HINT,
      header: "Associate Assets",
      options: [
        { label: ASSET_CONFIRM_YES, description: "Select Team / Agent / Task, inject team context" },
        { label: ASSET_CONFIRM_NO, description: "Do not inject anything this time, proceed directly" },
      ],
      multiSelect: false,
    });
    return { questions };
  }

  if (stage === "team") {
    // Team options: Only lists real teams. The active "skip" entry is only in the asset_confirm stage, subsequent
    // stages "abnormal/unrecognized" are bypassed by the init.ts fallback.
    //
    // The caller (init.ts) guarantees teams.length ≥ 2 — a single team will be auto-selected and skipped,
    // and will never reach the team form. The form builder no longer provides a fallback placeholder.
    // description is left empty —— label already contains the team name + id suffix, repeating "Team: name"
    // is just noise.
    // The Team stage is currently not paginated —— renders up to CC_MAX_OPTIONS teams (silently truncates the rest,
    // which is a pre-existing limit, not addressed this time).
    const teamOpts = teams.slice(0, CC_MAX_OPTIONS).map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: "",
    }));
    if (teamOpts.length < 2) {
      throw new Error(
        `[cc form] team stage requires ≥2 teams (got ${teamOpts.length}). ` +
          `Caller must auto-select when teams.length === 1.`,
      );
    }
    questions.push({
      question: titlePrefix + "Please select the Team for this session:" + SKIP_HINT,
      header: "Team",
      options: teamOpts.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });
    return { questions };
  }

  // stage === "agent_select" or "agent_task" (agent_task = no SKIP on last page)
  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.agents.length, pageIndex);
    const slice = team.agents.slice(page.start, page.end);

    // Only retain the agent's own description (which contains information), remove the "(After selecting an agent, N tasks are optional)" /
    // "(No tasks)" tail —— the user is currently selecting an agent, the task count prompt neither affects the decision
    // nor does it occupy the screen. If the agent has no custom description, the description is left empty, instead of falling back to "Agent: name"
    // (label already has the name).
    const combinedOptions: Array<{ label: string; description: string }> = slice.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: a.description ?? "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      combinedOptions.push({ label: MORE_LABEL, description: `View next batch (${remaining} Agent(s) remaining)` });
    }
    // Do not append SKIP on the last page: active skip is only provided in asset_confirm; subsequent stages "abnormal/unrecognized"
    // are bypassed by the init.ts fallback.
    //
    // pagination.ts guarantees real item count ≥ 2 per page (when total > 4; when total ≤ 4, a single page contains all
    // 4 slots filled, no MORE); combinedOptions < 2 should no longer be received here.
    if (combinedOptions.length < 2) {
      throw new Error(
        `[cc form] agent page ${pageIndex} has ${combinedOptions.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const pageSuffix = page.totalPages > 1 ? ` (Page ${pageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Please select the Agent to use under "${team.team_name}"${pageSuffix}:` + SKIP_HINT,
      header: page.totalPages > 1 ? `Agent ${pageIndex + 1}/${page.totalPages}`.slice(0, 12) : "Agent",
      options: combinedOptions.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });
    return { questions };
  }

  // stage === "task_select"
  if (!team) return { questions };

  if (stage === "task_select") {
    const taskPageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.tasks.length, taskPageIndex);
    const taskSlice = team.tasks.slice(page.start, page.end);

    // description is left empty —— label already contains the task name + id suffix, "Task: name" is just noise.
    // The virtual fallback entry (isDefault) does not append the id suffix, there is only one anyway so no naming ambiguity.
    const taskOpts: Array<{ label: string; description: string }> = taskSlice.map((t) => ({
      label: t.isDefault
        ? t.task_name
        : `${t.task_name} (${t.task_id.slice(-8)})`,
      description: "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      taskOpts.push({
        label: MORE_LABEL,
        description: `View next batch (${remaining} task(s) remaining)`,
      });
    }

    // Same as agent stage: pagination.ts guarantees count ≥ 2, if <2 here it indicates a paginator bug.
    if (taskOpts.length < 2) {
      throw new Error(
        `[cc form] task page ${taskPageIndex} has ${taskOpts.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const taskPageSuffix = page.totalPages > 1 ? ` (Page ${taskPageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Please select the Task to associate under "${team.team_name}"${taskPageSuffix}:` + SKIP_HINT,
      header: page.totalPages > 1 ? `Task ${taskPageIndex + 1}/${page.totalPages}`.slice(0, 12) : "Task",
      options: taskOpts.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });

    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build a Claude Code `AskUserQuestion` fake form response.
 * Always Anthropic SSE streaming (Claude Code only speaks Anthropic).
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const msgId = "msg_cc_session_init_" + Date.now();
  const toolUseId = TOOLCALL_PREFIX + Date.now();
  const input = buildAskUserQuestionArgs(data);
  const inputJson = JSON.stringify(input);

  const encoder = new TextEncoder();
  const sse = (event: string, d: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(d)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(sse("message_start", {
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));

      controller.enqueue(sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: toolUseId,
          name: TOOL_NAME,
          input: {},
        },
      }));

      controller.enqueue(sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: inputJson },
      }));

      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));

      controller.enqueue(sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 0 },
      }));

      controller.enqueue(sse("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}
