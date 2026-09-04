/**
 * opencode Session Init Form — the carrier for the `question` tool_call.
 *
 * The opencode CLI (sst/opencode, Bun-packaged binary) maintains a **hard allowlist**
 * of tools in its agent-loop: `bash, edit, glob, grep, invalid, question, read, skill,
 * task, todowrite, webfetch, write`. Any tool_call whose name is not on the allowlist
 * is rejected by the client and rendered as `invalid [tool=xxx, error=Model tried to
 * call unavailable tool]`.
 *
 * Therefore the proxy-side session-init form **cannot reuse** CB's `ask_followup_question`
 * or CC's `AskUserQuestion` — it must map to opencode's native `question` tool.
 *
 * # Basis for the `question` tool schema
 *
 * Source: sst/opencode `packages/opencode/src/tool/question.ts` + Question v1
 * schema (`Question.Prompt`). Core structure:
 *   {
 *     questions: [
 *       {
 *         question: string,             // prompt text (required)
 *         header:   string,             // title, ≤30 chars (required)
 *         options:  [{label, description?}, ...],  // at least 1 item
 *         multiple?: boolean,           // allow multiple selection (optional, default false)
 *       },
 *       ...
 *     ]
 *   }
 *
 * # Differences from the workbuddy form (3 points + tool name)
 *   - tool_name: `AskUserQuestion` → `question`
 *   - multiSelect (camelCase) → **multiple** (opencode-specific naming; neither CC's
 *     `multiSelect` nor dsh's `multi_select`)
 *   - header length limit: opencode ≤30 chars (wb/CC unlimited) → use `.slice(0, 30)`
 *   - tool_call id prefix: `call_oc_session_init_`
 *
 * # Transport
 *   - Protocol = **OpenAI /v1/chat/completions** (opencode internally uses the
 *     `@ai-sdk/openai-compatible` provider)
 *   - SSE stream or non-stream (follows the request's `body.stream`)
 *   - Skeleton copied verbatim from workbuddy (chunk 1 = role+tool_call decl / chunk 2 =
 *     arguments delta / chunk 3 = finish_reason:tool_calls / DONE)
 *
 * # State machine
 *   - Fully reuses the CB state machine (session/codebuddy/init.ts), same as the
 *     workbuddy/dsh pattern; stage values (asset_confirm / team / agent_select /
 *     task_select / agent_task) match CB exactly and are passed through directly.
 *
 * # Pagination
 *   - opencode `question.options` has no observed hard cap, but to keep the UI look
 *     consistent with CC/WB we reuse the `computePagination` + `MORE_LABEL` tail-slot
 *     scheme (≤4 options/page).
 *
 * # Format of the user's answer echoed back (for the extractor's reference)
 *   After the user finishes selecting, opencode's `question` tool returns a textual
 *   tool-result to the model:
 *     `User has answered your questions: "Question 1"="Answer 1", "Question 2"="Answer 2, Answer 3"`
 *   The existing extractor's substring fallback (doing `hay.includes` on team_name /
 *   agent_name / the last 8 id chars) already covers this format, so no opencode-specific
 *   branch is needed.
 */

import type { TeamOption } from "../types.js";
import { computePagination, CC_MAX_OPTIONS as CC_MAX_OPTIONS_SHARED } from "../claude-code/pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

/** opencode's native tool name, an allowlist member. Do not change to `AskUserQuestion` or `ask_followup_question`. */
export const TOOL_NAME = "question";
export const TOOLCALL_PREFIX = "call_oc_session_init_";

export const TEAM_FORM_TITLE = "Session Initialization — Select Team";
export const AGENT_TASK_FORM_TITLE = "Session Initialization — Select Agent and Task";
export const RETRY_FORM_TITLE = "Selection unrecognized, please select again";

export const SKIP_LABEL = "Do not associate this time (skip injection, proceed directly)";
export const MORE_LABEL = "More →";

export const ASSET_CONFIRM_YES = "Yes, associate team assets";
export const ASSET_CONFIRM_NO = "No, do not associate this time";
export const ASSET_CONFIRM_FORM_TITLE = "Session Initialization — Associate Team Assets?";

/**
 * General note appended to the end of each question step: informs the user that
 * "selecting skip = skip session init this time, inject no team assets". The opencode
 * `question` tool UI also lets the user type a free-form reply (non-option text);
 * replying "skip" / "do not associate" (or Chinese equivalents) triggers the SKIP_RE
 * bypass. The copy is unified across the claude-code / workbuddy / codex / codebuddy /
 * dsh endpoints to avoid drift between clients.
 */
const SKIP_HINT = ' (Selecting "skip" will bypass session init and inject no team assets)';

/** Hard cap for the opencode question header. The schema validates ≤30 chars; longer headers are rejected by the client. */
const OC_HEADER_MAX = 30;

const CC_MAX_OPTIONS = CC_MAX_OPTIONS_SHARED;

/** Clips arbitrary header text to the ≤30 chars allowed by the opencode schema. */
function clipHeader(s: string): string {
  return s.length > OC_HEADER_MAX ? s.slice(0, OC_HEADER_MAX) : s;
}

/** Returns true if the given string contains any opencode form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_call id belongs to an opencode session-init form. */
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
  /** Pagination: current page index (0-based); aligned with CC/WB, only a single pageIndex is used (team/agent/task single question). */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// ── opencode `question` input schema ───────────────────────────────────────────

interface OCQuestionOption {
  label: string;
  description: string;
}

interface OCAskQuestion {
  question: string;
  /** opencode hard constraint: ≤30 chars. */
  header: string;
  options: OCQuestionOption[];
  /** opencode-specific naming: `multiple` (neither CC's `multiSelect` nor dsh's `multi_select`). */
  multiple: boolean;
}

function buildQuestionArgs(data: FormData): { questions: OCAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: OCAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      question: titlePrefix + "Would you like to associate team assets for this conversation?" + SKIP_HINT,
      header: clipHeader("Associate Assets"),
      options: [
        { label: ASSET_CONFIRM_YES, description: "Select Team / Agent / Task, inject team context" },
        { label: ASSET_CONFIRM_NO, description: "Do not inject anything this time, proceed directly" },
      ],
      multiple: false,
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
        `[oc form] team stage requires ≥2 teams (got ${teamOpts.length}). ` +
          `Caller must auto-select when teams.length === 1.`,
      );
    }
    questions.push({
      question: titlePrefix + "Please select the Team for this session:" + SKIP_HINT,
      header: clipHeader("Team"),
      options: teamOpts.slice(0, CC_MAX_OPTIONS),
      multiple: false,
    });
    return { questions };
  }

  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.agents.length, pageIndex);
    const slice = team.agents.slice(page.start, page.end);

    const combinedOptions: OCQuestionOption[] = slice.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: a.description ?? "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      combinedOptions.push({ label: MORE_LABEL, description: `View next batch (${remaining} Agent(s) remaining)` });
    }

    if (combinedOptions.length < 2) {
      throw new Error(
        `[oc form] agent page ${pageIndex} has ${combinedOptions.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const pageSuffix = page.totalPages > 1 ? ` (Page ${pageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Please select the Agent to use under "${team.team_name}"${pageSuffix}:` + SKIP_HINT,
      header: clipHeader(page.totalPages > 1 ? `Agent ${pageIndex + 1}/${page.totalPages}` : "Agent"),
      options: combinedOptions.slice(0, CC_MAX_OPTIONS),
      multiple: false,
    });
    return { questions };
  }

  if (stage === "task_select") {
    const taskPageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.tasks.length, taskPageIndex);
    const taskSlice = team.tasks.slice(page.start, page.end);

    const taskOpts: OCQuestionOption[] = taskSlice.map((t) => ({
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
        `[oc form] task page ${taskPageIndex} has ${taskOpts.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const taskPageSuffix = page.totalPages > 1 ? ` (Page ${taskPageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Please select the Task to associate under "${team.team_name}"${taskPageSuffix}:` + SKIP_HINT,
      header: clipHeader(page.totalPages > 1 ? `Task ${taskPageIndex + 1}/${page.totalPages}` : "Task"),
      options: taskOpts.slice(0, CC_MAX_OPTIONS),
      multiple: false,
    });
    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build an opencode `question` fake form response.
 *
 * Transport: **OpenAI chat/completions** (stream or non-stream).
 * arguments shape: opencode's native `{questions: [{question, header, options, multiple}]}`.
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const id = "oc-session-init-" + Date.now();
  const toolCallId = TOOLCALL_PREFIX + Date.now();
  const input = buildQuestionArgs(data);
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
