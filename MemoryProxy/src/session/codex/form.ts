/**
 * Codex Session Init Form — `request_user_input` function_call.
 *
 * Codex client form protocol:
 *   - Tool name: `request_user_input`
 *   - Args: `{questions: [{prompt, options?}, ...]}`
 *   - Protocol: OpenAI Responses API (SSE `response.*` event sequence)
 *   - ID prefix: `call_codex_session_init_`
 *   - Plan mode gating: in Default mode the client gate intercepts and returns
 *     `"request_user_input is unavailable in Default mode"`
 *
 * Contains no Claude Code / CodeBuddy logic.
 */

import type { TeamOption } from "../types.js";
import { computeCodexPagination } from "./pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const TOOL_NAME = "request_user_input";
/**
 * Prefix for `function_call.call_id` — when the codex client replays the form result
 * back into input[], it links `call_id` to `function_call_output`. This field is
 * free-form per the OpenAI Responses spec; on read-back this prefix identifies
 * whether the item is a session-init.
 */
export const TOOLCALL_PREFIX = "call_codex_session_init_";
/**
 * Prefix for `function_call.id` — the OpenAI Responses spec strictly requires `id`
 * to start with `fc` (`fc_xxxxxxxxxxxx`). Previously the id also used TOOLCALL_PREFIX
 * (starting with call_); a Responses API upstream that strictly enforces the spec
 * returns a 400 when the client replays into input[]:
 *   Invalid 'input[N].id': 'call_codex_session_init_xxx'.
 *   Expected an ID that begins with 'fc'.
 * See the 2026-08-13 user packet-capture error report. call_id keeps the call_ prefix; only id uses fc_.
 */
export const TOOLCALL_ID_PREFIX = "fc_codex_session_init_";

export const TEAM_FORM_TITLE = "Session Initialization — Select Team";
export const AGENT_TASK_FORM_TITLE = "Session Initialization — Select Agent and Task";
export const RETRY_FORM_TITLE = "Selection unrecognized, please select again";

export const ASSET_CONFIRM_YES = "Yes, associate team assets";
export const ASSET_CONFIRM_NO = "No, do not associate this time";
export const ASSET_CONFIRM_FORM_TITLE = "Session Initialization — Associate Team Assets?";

/**
 * Stable marker for the codex pagination "More..." option (stored in option.label;
 * clicking it sends it back verbatim to the codex handler, where we intercept it →
 * pageIndex++ and resend the next form page).
 *
 * MARKER is a stable internal identifier string (aligned with the CC MORE_MARKER
 * naming); LABEL is the user-facing readable text ("More..."). Extraction only needs
 * to substring-match LABEL; MARKER itself never goes into the label (to avoid
 * "__..." characters polluting the UI display).
 */
export const CODEX_MORE_MARKER = "__codex_more_marker__" as const;
export const CODEX_MORE_LABEL = "More...";

/**
 * Prefix string for the gate interception in the client's Default mode.
 * When `function_call_output.output` starts with this, it is judged a gate hit.
 */
export const DEFAULT_GATE_PREFIX = "request_user_input is unavailable in";

/**
 * Universal note appended to the end of each question step: tells the user that
 * "selecting skip = this session init is skipped, no team assets are injected".
 * Codex's request_user_input shows questions + options to the user in Plan mode;
 * the skip entry is the "No, do not associate this time" button. Wording is unified
 * across the claude-code/workbuddy/codebuddy/dsh endpoints (five in total).
 */
const SKIP_HINT = ' (Selecting "skip" will bypass session init and inject no team assets)';

/** Returns true if the given string contains any codex form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a function_call id belongs to a codex session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return id.startsWith(TOOLCALL_PREFIX);
}

/**
 * Judge whether `function_call_output.output` is a client Default-mode gate interception.
 * The gate string startsWith `"request_user_input is unavailable in"`.
 */
export function isDefaultModeGate(output: string): boolean {
  return output.startsWith(DEFAULT_GATE_PREFIX);
}

// ── Form Data ──────────────────────────────────────────────────────────────────

/**
 * The stage enum supported by the codex form.
 *
 * 2026-08-08 refactor: on the codex side the old "agent_task" (asking agent+task in
 * a single request) was split into two independent stages: "agent_select" asks only
 * for the agent, "task_select" asks only for the task. Reason: see docs & task-brief
 * — the old stage left partialMore (agent really chosen + task=more) unable to return
 * to the same stage to re-ask the task, so the user always saw the first page while paging.
 *
 * The old "agent_task" value is kept (for the legacy path when the CB client reuses
 * the CB state machine, and for old unit tests); new codex sessions no longer use it.
 */
export type FormStage = "asset_confirm" | "team" | "agent_select" | "task_select" | "agent_task";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  /**
   * The agent_id already selected during the agent_select stage. When the task_select
   * stage renders the task list, this field is currently used only for logging/echo —
   * tasks are team-wide and not affected by the agent. If an agent-scoped task list is
   * introduced later, this field can be used directly.
   */
  selectedAgentId?: string;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
  /**
   * codex pagination page index (0-based). The three stages are each independent:
   *   - teamPage:  team stage
   *   - agentPage: agent_select stage (and the legacy agent_task agent question)
   *   - taskPage:  task_select stage (and the legacy agent_task task question)
   *
   * Missing values default to 0. The codex handler reads them from the codexPageIndex
   * field in sessionStore and passes them down; when the user answers "More...", the
   * handler intercepts and bumps +1 to resend.
   */
  teamPage?: number;
  agentPage?: number;
  taskPage?: number;
}

// ── Answer extraction ────────────────────────────────────────────────────────

/**
 * Extract the session-init form's `function_call_output` from codex `body.input[]`
 * into a CB-compatible `messages[]` (one `role: "user"` message whose content is the
 * concatenated answer text), so CB's `handleSessionInit` state machine can be reused
 * (no need to build a separate codex-side extractor / state machine).
 *
 * Only the **last** `function_call_output` whose call_id starts with
 * `call_codex_session_init_` is taken, because the codex client replays the whole
 * input[] each time, accumulating answers across form turns; the CB state machine
 * only cares about the latest step.
 *
 * `output` can be:
 *   - a plain string answer: `"yes, associate team assets"`
 *   - a JSON string `{"answers":{"q1":"yes"}}` (may vary across codex client versions)
 *   - a JSON string `{"question":"...","answer":"..."}` or an array
 * Fallback strategy: if a structured answer value can be parsed, concatenate and
 * return it; otherwise use the raw string as-is.
 *
 * Returning an empty array → CB goes through the `pending_*` retry/fallback branch.
 */
export function codexFormAnswersAsMessages(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return [];

  let lastOutput: string | null = null;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type !== "function_call_output") continue;
    const callId = it.call_id;
    if (typeof callId !== "string" || !callId.startsWith(TOOLCALL_PREFIX)) continue;
    const output = it.output;
    if (typeof output === "string") lastOutput = output;
  }

  if (lastOutput === null) return [];

  const text = extractAnswerText(lastOutput);
  if (!text) return [];

  return [{ role: "user", content: text }];
}

/**
 * Try to pull the answer text out of a codex `function_call_output.output`.
 *
 * The tool_result structure of codex `request_user_input` varies slightly across
 * client versions / languages — first try JSON-parsing the common shapes; if none
 * match, fall back to the raw string (CB's matcher is substring-fallback anyway, so
 * matching the option label is enough).
 */
function extractAnswerText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // Not a JSON prefix → return the raw string as-is.
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;

  try {
    const parsed = JSON.parse(trimmed);
    const collected: string[] = [];
    collectAnswerStrings(parsed, collected);
    if (collected.length > 0) return collected.join("\n");
  } catch {
    // JSON parse failed → fall back to the raw string
  }
  return trimmed;
}

/**
 * Scan the last session-init form `function_call_output` in codex `body.input[]` and
 * extract MORE-marker hits per question id.
 *
 * Usage: intercept before handleSessionInit — on a hit bump pageIndex+1 and resend
 * the form directly, without advancing the CB state machine.
 *
 * Returns:
 *   - hasMore: at least one question's answer contains CODEX_MORE_LABEL
 *   - perQuestion: whether each question id hit MORE
 *
 * Aligned with `codexFormAnswersAsMessages`: only the last `function_call_output`
 * whose call_id starts with `call_codex_session_init_` is taken.
 *
 * Compatible with several output shapes:
 *   - plain string (single question)
 *   - JSON: `{"answers":{"team_select":"More..."}}`
 *   - JSON: `{"answers":{"agent_select":"agent-1","task_select":"More..."}}`
 *   - JSON: multi_question_result envelope
 *
 * Shapes that cannot be parsed degrade to "only check the CODEX_MORE_LABEL substring
 * against the plain string" — perQuestion is then all false (the caller decides which
 * page to bump from state.status).
 */
export interface CodexMoreDetection {
  hasMore: boolean;
  perQuestion: {
    team_select: boolean;
    agent_select: boolean;
    task_select: boolean;
  };
}

export function detectCodexMore(input: unknown): CodexMoreDetection {
  const result: CodexMoreDetection = {
    hasMore: false,
    perQuestion: { team_select: false, agent_select: false, task_select: false },
  };
  if (!Array.isArray(input)) return result;

  let lastOutput: string | null = null;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type !== "function_call_output") continue;
    const callId = it.call_id;
    if (typeof callId !== "string" || !callId.startsWith(TOOLCALL_PREFIX)) continue;
    const output = it.output;
    if (typeof output === "string") lastOutput = output;
  }
  if (lastOutput === null) return result;

  const trimmed = lastOutput.trim();
  if (!trimmed) return result;

  // Try structured parsing
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      collectMorePerQuestion(parsed, result);
    } catch {
      // ignore
    }
  }

  // Fallback: substring match against the whole text
  if (lastOutput.includes(CODEX_MORE_LABEL)) {
    result.hasMore = true;
  }
  // If structured parsing hit any perQuestion, also mark hasMore
  if (
    result.perQuestion.team_select ||
    result.perQuestion.agent_select ||
    result.perQuestion.task_select
  ) {
    result.hasMore = true;
  }

  return result;
}

function collectMorePerQuestion(node: unknown, out: CodexMoreDetection): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  // { answers: { q_id: label } }
  if (obj.answers && typeof obj.answers === "object") {
    const answers = obj.answers as Record<string, unknown>;
    for (const [qid, val] of Object.entries(answers)) {
      if (typeof val !== "string") continue;
      if (!val.includes(CODEX_MORE_LABEL)) continue;
      if (qid === "team_select" || qid === "agent_select" || qid === "task_select") {
        (out.perQuestion as Record<string, boolean>)[qid] = true;
      }
    }
  }

  // { type: "multi_question_result", questions: [{id, answer}] }
  const mqr = (obj.result ?? obj) as Record<string, unknown> | undefined;
  if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
    for (const q of mqr.questions) {
      if (!q || typeof q !== "object") continue;
      const qo = q as Record<string, unknown>;
      const qid = typeof qo.id === "string" ? qo.id : "";
      const cand = qo.answer ?? qo.answers ?? qo.selected ?? qo.selectedOption ?? qo.value;
      let val: string | null = null;
      if (typeof cand === "string") val = cand;
      else if (Array.isArray(cand)) {
        const f = cand.find((x) => typeof x === "string");
        if (typeof f === "string") val = f;
      }
      if (val && val.includes(CODEX_MORE_LABEL)) {
        if (qid === "team_select" || qid === "agent_select" || qid === "task_select") {
          (out.perQuestion as Record<string, boolean>)[qid] = true;
        }
      }
    }
  }
}

function collectAnswerStrings(node: unknown, out: string[]): void {
  if (node == null) return;
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectAnswerStrings(item, out);
    return;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    // Priority keys: answers / answer / value / selection
    for (const key of ["answers", "answer", "value", "selection", "selected"]) {
      if (key in obj) {
        collectAnswerStrings(obj[key], out);
        return;
      }
    }
    // Otherwise walk all values (defensive; questions[].answer style)
    for (const v of Object.values(obj)) collectAnswerStrings(v, out);
  }
}

// ── Question builder ─────────────────────────────────────────────────────────
//
// Codex `request_user_input` schema (the official definition pulled from the codex
// system prompt):
//
//   {
//     questions: [1..3],              top level only allows 1-3 questions
//     each question: {
//       id: string (snake_case, required),
//       header: string (≤ 12 chars, required),
//       question: string (required),  ← note the field name is not `prompt`
//       options: [2..3],              each question allows only 2-3 options
//       each option: { label, description } (both required)
//     }
//   }
//
// The client auto-appends an "Other" option as the free-text fallback, so we must not
// add our own. When there are more than 3 options (e.g. long team/agent/task lists),
// keep only the first 2 labels; users wanting the rest type the id/name via "Other".
//
// See docs/2026-08-05-codex-onboarding.md §7.5.3.

interface CodexOption {
  label: string;
  description: string;
}

interface CodexQuestion {
  id: string;       // stable snake_case identifier
  header: string;   // UI label, ≤ 12 chars
  question: string; // full question shown to the user
  options: CodexOption[];
}

/** Clips header to ≤ 12 chars (Chinese counted as 1 char each — codex does not specify, so conservatively count characters). */
function clampHeader(s: string): string {
  return s.length <= 12 ? s : s.slice(0, 12);
}

/**
 * Build options with pagination: split entries into pages under codex's 3-slot cap;
 * non-last pages append a "More..." option for the user to page onward; the last page
 * has no MORE and just lists what remains.
 *
 * - entries.length <= 3 && single page → returned as-is
 * - middle pages: first 2 real + MORE (3 items; the client's "Other" slot is separate)
 * - last page: remaining 2~3 real
 * - entries.length === 0: fallback 2 placeholder items (codex requires ≥ 2)
 * - entries.length === 1: real item + "skip" placeholder (codex requires ≥ 2)
 */
function buildOptions(
  entries: Array<{ label: string; description: string }>,
  pageIndex: number,
): CodexOption[] {
  if (entries.length === 0) {
    return [
      { label: "Skip", description: "Do not associate this time, proceed directly" },
      { label: "Retry", description: "Re-fetch the list and choose again" },
    ];
  }
  if (entries.length === 1) {
    return [
      entries[0]!,
      { label: "Skip", description: "Do not associate this time, proceed directly" },
    ];
  }

  const safePage = Math.max(0, pageIndex);
  const page = computeCodexPagination(entries.length, safePage);
  const slice = entries.slice(page.start, page.end);

  if (page.isLastPage) {
    return slice;
  }

  const remaining = page.total - page.end;
  const morePageNo = safePage + 2; // human-facing (1-based, next page)
  const moreOption: CodexOption = {
    label: CODEX_MORE_LABEL,
    description: `View the next batch of candidates (page ${morePageNo}/${page.totalPages}, ${remaining} left)`,
  };
  return [...slice, moreOption];
}

function pageSuffix(pageIndex: number, totalPages: number): string {
  return totalPages > 1 ? ` (Page ${pageIndex + 1}/${totalPages})` : "";
}

function buildQuestions(data: FormData): CodexQuestion[] {
  const { teams, stage, selectedTeamId, retry } = data;
  const retryHint = retry ? " (not recognized last time, please select again)" : "";
  const teamPage = Math.max(0, data.teamPage ?? 0);
  const agentPage = Math.max(0, data.agentPage ?? 0);
  const taskPage = Math.max(0, data.taskPage ?? 0);

  if (stage === "asset_confirm") {
    return [{
      id: "asset_confirm",
      header: clampHeader("Team assets"),
      question: `Would you like to associate team assets for this conversation (Skill / Memory / Agent / Task / Knowledge)?${retryHint}`,
      options: [
        {
          label: ASSET_CONFIRM_YES,
          description: "Next you'll be asked to pick Team, Agent, Task; each turn then auto-injects the related assets.",
        },
        {
          label: ASSET_CONFIRM_NO,
          description: "Skip team assets for this session and start the conversation directly.",
        },
      ],
    }];
  }

  if (stage === "team") {
    const entries = teams.map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: `Team ID: ${t.team_id}${t.agents?.length ? `, includes ${t.agents.length} Agent(s)` : ""}`,
    }));
    const pageInfo = computeCodexPagination(entries.length, teamPage);
    return [{
      id: "team_select",
      header: clampHeader("Select Team"),
      question: `Please select the Team for this session${pageSuffix(teamPage, pageInfo.totalPages)}${retryHint}:`,
      options: buildOptions(entries, teamPage),
    }];
  }

  // stage in { "agent_select", "task_select", "agent_task" (legacy) }
  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return [];

  const questions: CodexQuestion[] = [];

  // Agent question — rendered for both the new "agent_select" stage and the legacy "agent_task".
  if ((stage === "agent_select" || stage === "agent_task") && team.agents.length > 0) {
    const entries = team.agents.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: `Agent ID: ${a.agent_id}`,
    }));
    const pageInfo = computeCodexPagination(entries.length, agentPage);
    questions.push({
      id: "agent_select",
      header: clampHeader("Select Agent"),
      question: `Please select the Agent to use under "${team.team_name}"${pageSuffix(agentPage, pageInfo.totalPages)}${retryHint}:`,
      options: buildOptions(entries, agentPage),
    });
  }

  // Task question — rendered for both the new "task_select" stage and the legacy "agent_task".
  if ((stage === "task_select" || stage === "agent_task") && team.tasks.length > 0) {
    const entries = team.tasks.map((t) => ({
      label: t.isDefault ? t.task_name : `${t.task_name} (${t.task_id.slice(-8)})`,
      description: t.isDefault
        ? "This Agent's default task (recommended)"
        : `Task ID: ${t.task_id}`,
    }));
    const pageInfo = computeCodexPagination(entries.length, taskPage);
    const opts = buildOptions(entries, taskPage);
    questions.push({
      id: "task_select",
      header: clampHeader("Select Task"),
      question: `Please select the Task to associate under "${team.team_name}"${pageSuffix(taskPage, pageInfo.totalPages)}${retryHint}:`,
      options: opts,
    });
  }

  return questions;
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build a Codex `request_user_input` fake form response.
 * Supports both SSE streaming (Responses API events) and non-streaming JSON.
 */
export function buildFormResponse(data: FormData): Response {
  const questions = buildQuestions(data);
  const argsJson = JSON.stringify({ questions });

  // `id` and `call_id` are two independent fields in the OpenAI Responses spec:
  //   - id     : function_call item's own unique identifier; spec requires an `fc` prefix
  //   - call_id: the association key pairing this function_call with the following
  //              function_call_output; spec allows free-form. The read-back side
  //              (codexFormAnswersAsMessages / extractCodexMoreFlags) identifies
  //              session-init via call_id.startsWith(TOOLCALL_PREFIX), so call_id
  //              still uses the call_ prefix.
  const ts = Date.now();
  const fcId = TOOLCALL_ID_PREFIX + ts;
  const callId = TOOLCALL_PREFIX + ts;
  const responseId = "resp_codex_session_init_" + ts;

  if (data.stream) {
    return buildStreamingResponse(responseId, fcId, callId, argsJson);
  }
  return buildNonStreamingResponse(responseId, fcId, callId, argsJson);
}

// ── Non-streaming ────────────────────────────────────────────────────────────

function buildNonStreamingResponse(
  responseId: string,
  fcId: string,
  callId: string,
  argsJson: string,
): Response {
  const body = {
    id: responseId,
    object: "response",
    status: "completed",
    output: [
      {
        type: "function_call",
        id: fcId,
        name: TOOL_NAME,
        arguments: argsJson,
        call_id: callId,
      },
    ],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Streaming (Responses API SSE) ────────────────────────────────────────────

function buildStreamingResponse(
  responseId: string,
  fcId: string,
  callId: string,
  argsJson: string,
): Response {
  const encoder = new TextEncoder();
  // Key: in the Responses API, every event's data JSON **must** carry a `type` field
  // (same name as the SSE `event:` header); otherwise the codex client parser cannot
  // read the event type, and the tool_call never shows up in the client UI (the form
  // does not pop up). Mirrors the real upstream behavior in the packet trace §7.5.2/3.
  const sse = (event: string, d: Record<string, unknown>) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...d })}\n\n`);

  const functionCallItem = {
    type: "function_call" as const,
    id: fcId,
    name: TOOL_NAME,
    arguments: argsJson,
    call_id: callId,
  };

  const responseObj = {
    id: responseId,
    object: "response",
    status: "completed",
    output: [functionCallItem],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };

  const stream = new ReadableStream({
    start(controller) {
      // response.created
      controller.enqueue(sse("response.created", {
        response: { ...responseObj, status: "in_progress", output: [] },
      }));

      // response.in_progress
      controller.enqueue(sse("response.in_progress", {
        response: { ...responseObj, status: "in_progress", output: [] },
      }));

      // response.output_item.added (function_call) —— arguments starts as an empty string,
      // streamed in via arguments.delta (mirrors the real upstream frame sequence)
      controller.enqueue(sse("response.output_item.added", {
        output_index: 0,
        item: { ...functionCallItem, arguments: "" },
      }));

      // response.function_call_arguments.delta —— key: the real upstream event carries
      // item_id to align with the item.id in output_item.added; without item_id the
      // client cannot attach the delta back to the matching tool call. item.id is now
      // fcId (fc_ prefix), so item_id must come from the same source.
      controller.enqueue(sse("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: fcId,
        delta: argsJson,
      }));

      // response.function_call_arguments.done
      controller.enqueue(sse("response.function_call_arguments.done", {
        output_index: 0,
        item_id: fcId,
        arguments: argsJson,
      }));

      // response.output_item.done (function_call complete)
      controller.enqueue(sse("response.output_item.done", {
        output_index: 0,
        item: functionCallItem,
      }));

      // response.completed
      controller.enqueue(sse("response.completed", {
        response: responseObj,
      }));

      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
