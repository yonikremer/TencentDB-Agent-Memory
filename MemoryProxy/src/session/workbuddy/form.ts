/**
 * WorkBuddy Session Init Form — `AskUserQuestion` tool_call.
 *
 * WorkBuddy client reuses CC's `AskUserQuestion` tool (confirmed via packet capture [wb-ask-user-schema]),
 * but the underlying protocol is **OpenAI /v1/chat/completions** (not Anthropic).
 *
 * Therefore this form:
 *   - questions[] shape is identical to CC ({question, header, options:[{label,description}], multiSelect})
 *   - Transport uses the OpenAI chat/completions SSE `tool_calls` chunk stream (the CB skeleton)
 *   - Tool name: `AskUserQuestion` (same as CC)
 *   - ID prefix: `call_wb_session_init_` (distinct from CB's `call_session_init_`)
 *   - Pagination: 3 options per page + 1 "More →" slot (aligned with CC, to stay under the hard limit)
 *
 * Contains no CodeBuddy XML logic, nor does it share CB's form builder (CB uses
 * `ask_followup_question` XML semantics, WB uses CC's AskUserQuestion semantics).
 */

import type { TeamOption } from "../types.js";
import { computePagination, CC_MAX_OPTIONS as CC_MAX_OPTIONS_SHARED } from "../claude-code/pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const TOOL_NAME = "AskUserQuestion";
export const TOOLCALL_PREFIX = "call_wb_session_init_";

export const TEAM_FORM_TITLE = "Session Initialization — Select Team";
export const AGENT_TASK_FORM_TITLE = "Session Initialization — Select Agent and Task";
export const RETRY_FORM_TITLE = "Selection unrecognized, please select again";

export const SKIP_LABEL = "Do not associate this time (skip injection, proceed directly)";
export const MORE_LABEL = "More →";

export const ASSET_CONFIRM_YES = "Yes, associate team assets";
export const ASSET_CONFIRM_NO = "No, do not associate this time";
export const ASSET_CONFIRM_FORM_TITLE = "Session Initialization — Associate Team Assets?";

/**
 * General note appended to the end of each question step: tells the user "selecting skip = bypass session init this time, inject no team assets".
 * AskUserQuestion provides the user with an "Other" input box; replying "skip / do not associate" will
 * take the SKIP_RE bypass. The copy is unified with the claude-code/codex/codebuddy/dsh endpoints.
 */
const SKIP_HINT = ' (Selecting "skip" will bypass session init and inject no team assets)';

const CC_MAX_OPTIONS = CC_MAX_OPTIONS_SHARED;

/** Returns true if the given string contains any WB form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_call id belongs to a WB session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return id.startsWith(TOOLCALL_PREFIX);
}

// ── Form Data ──────────────────────────────────────────────────────────────────

export type FormStage = "asset_confirm" | "team" | "agent_select" | "agent_task" | "task_select";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  selectedAgentId?: string;
  /** Pagination: current page index (0-based); aligned with CC, only a single pageIndex is used (team/agent/task are each one question) */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// ── AskUserQuestion input schema (identical to CC) ────────────────────────────

interface WBAskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

function buildAskUserQuestionArgs(data: FormData): { questions: WBAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: WBAskQuestion[] = [];

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
    const teamOpts = teams.slice(0, CC_MAX_OPTIONS).map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: "",
    }));
    if (teamOpts.length < 2) {
      throw new Error(
        `[wb form] team stage requires ≥2 teams (got ${teamOpts.length}). ` +
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

  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.agents.length, pageIndex);
    const slice = team.agents.slice(page.start, page.end);

    const combinedOptions: Array<{ label: string; description: string }> = slice.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: a.description ?? "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      combinedOptions.push({ label: MORE_LABEL, description: `View next batch (${remaining} Agent(s) remaining)` });
    }

    if (combinedOptions.length < 2) {
      throw new Error(
        `[wb form] agent page ${pageIndex} has ${combinedOptions.length} option(s); ` +
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

  if (stage === "task_select") {
    const taskPageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.tasks.length, taskPageIndex);
    const taskSlice = team.tasks.slice(page.start, page.end);

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

    if (taskOpts.length < 2) {
      throw new Error(
        `[wb form] task page ${taskPageIndex} has ${taskOpts.length} option(s); ` +
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
 * Build a WorkBuddy `AskUserQuestion` fake form response.
 *
 * Transport: **OpenAI chat/completions** (stream or non-stream).
 * questions shape: same as CC AskUserQuestion —— `{questions: [{question, header, options, multiSelect}]}`.
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const id = "wb-session-init-" + Date.now();
  const toolCallId = TOOLCALL_PREFIX + Date.now();
  const input = buildAskUserQuestionArgs(data);
  const argsStr = JSON.stringify(input);

  if (data.stream) {
    return buildOpenAIStreamingResponse(id, created, model, toolCallId, argsStr);
  }
  return buildOpenAINonStreamingResponse(id, created, model, toolCallId, argsStr);
}

// ── OpenAI Non-streaming ───────────────────────────────────────────────────────

function buildOpenAINonStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  argsStr: string,
): Response {
  return new Response(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: toolCallId,
          type: "function",
          function: {
            name: TOOL_NAME,
            arguments: argsStr,
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── OpenAI Streaming ───────────────────────────────────────────────────────────

function buildOpenAIStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  argsStr: string,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Chunk 1: role + tool_call declaration (empty arguments)
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [{
              index: 0,
              id: toolCallId,
              type: "function",
              function: { name: TOOL_NAME, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`));

      // Chunk 2: arguments delta (whole JSON as single delta)
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: argsStr },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`));

      // Chunk 3: finish
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })}\n\n`));

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}
