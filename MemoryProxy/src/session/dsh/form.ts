/**
 * dsh Session Init Form — the carrier for the `ask_user_question` tool_call.
 *
 * In preset scenarios (web-app + standard/code/cordis presets, etc.), the
 * dsh (deepseek-harness) client auto-attaches `@deepseek-ai/dsh-tool-ask-user`,
 * adding an `ask_user_question` tool to the main-conversation tools array (see
 * the dsh source `packages/interaction/tool-ask-user/src/index.ts`).
 *
 * The proxy-side session-init form directly reuses this dsh native tool name and
 * fakes an assistant tool_call SSE to let the client UI render the options.
 *
 * # Differences from the workbuddy form (3 shape differences + tool name)
 *   - tool_name: `AskUserQuestion` → `ask_user_question`
 *   - multiSelect (camelCase) → multi_select (snake_case)
 *   - each question requires an `id` (dsh schema hard constraint, echoed in answer)
 *   - the top-level `questions[]` can carry several questions at once
 *     (workbuddy/CC usually sends a single one; to align with the dsh schema the
 *     array structure is kept here — a single question is a one-element array)
 *
 * # Transport
 *   - Protocol = **OpenAI /v1/chat/completions** (matching the dsh client's fetch)
 *   - SSE stream or non-stream (follows the request's `body.stream`)
 *   - Skeleton copied verbatim from workbuddy (chunk 1 = role+tool_call decl /
 *     chunk 2 = arguments delta / chunk 3 = finish_reason:tool_calls / DONE)
 *
 * # State machine
 *   - Fully reuses the CB state machine (session/codebuddy/init.ts), same as the
 *     workbuddy pattern; stage values (asset_confirm / team / agent_select /
 *     task_select / agent_task) match CB exactly and are passed through directly.
 *
 * # tool_call id prefix
 *   - `call_dsh_session_init_` — distinct from CB (`call_session_init_`),
 *     workbuddy (`call_wb_session_init_`), codex (`fc_codex_session_init_`)
 *
 * # Schema basis from packet capture
 *   - `docs/dsh-recon/fixtures/dsh-tool-catalog-schema.json`
 *   - dsh source `packages/interaction/tool-ask-user/src/index.ts`
 */

import type { TeamOption } from "../types.js";
// The dsh (deepseek-harness) ask_user_question UI has no options-count cap
// (source packages/interaction/tool-ask-user/src/index.ts + UI QuestionComposer.tsx
// both map-render directly, without truncation). Therefore the dsh form **does not
// paginate**; team/agent/task options are all included in full.
// Compare: CC hard-requires ≤4 options (AskUserQuestion internal validation) and must
// paginate; codex has a similar limit; CB has no limit and doesn't paginate. dsh is in
// the "UI-unlimited" class.
// See MemoryProxy/docs/dsh-recon/2026-08-14-dsh-integration-notes.md pitfall #9.

// ── Constants ──────────────────────────────────────────────────────────────────

/** dsh's native tool name. **Do not** change it to CC's `AskUserQuestion` — the dsh preset attaches the snake_case name. */
export const TOOL_NAME = "ask_user_question";
export const TOOLCALL_PREFIX = "call_dsh_session_init_";

export const TEAM_FORM_TITLE = "Session Initialization — Select Team";
export const AGENT_TASK_FORM_TITLE = "Session Initialization — Select Agent and Task";
export const RETRY_FORM_TITLE = "Selection unrecognized, please select again";

export const SKIP_LABEL = "Do not associate this time (skip injection, proceed directly)";
// dsh does not paginate; MORE_LABEL is kept only for backward compatibility (tests or
// future pagination); it is never emitted today.
export const MORE_LABEL = "More →";

/**
 * Placeholder reasoning_content for the fake tool_call assistant message.
 *
 * ## Why it must be non-empty
 *
 * dsh `serialize.ts:99` only echoes reasoning_content back to the upstream body when
 * `toolCalls.length > 0 && reasoning.length > 0`. The dsh `translate.ts:133` inbound
 * parse works the same way: a reasoning block is opened only when
 * `reasoning_content.length > 0` — **an empty string is silently dropped**.
 *
 * Empty string `""` = the client parses a `text: ""` block → length 0 after the
 * serialize join → upstream body lacks reasoning_content → deepseek thinking mode
 * hard-validates and returns 400
 * `The reasoning_content in the thinking mode must be passed back to the API`.
 *
 * Stuffing in a non-empty placeholder lets the client really open a reasoning block,
 * carried along on the next-turn replay. The value itself has no effect on the model
 * (the fake session-init never actually goes through the model anyway).
 *
 * See docs/dsh-recon/2026-08-14-dsh-integration-notes.md pitfall #7.
 */
const REASONING_PLACEHOLDER = "[proxy session-init form]";

export const ASSET_CONFIRM_YES = "Yes, associate team assets";
export const ASSET_CONFIRM_NO = "No, do not associate this time";
export const ASSET_CONFIRM_FORM_TITLE = "Session Initialization — Associate Team Assets?";

/**
 * General note appended to the end of each question step: informs the user that
 * "selecting skip = skip session init this time, inject no team assets". The dsh
 * ask_user_question UI also supports an "Other" / free-text fallback (see dsh docs §3.4
 * `custom` field); replying "skip / skip / do not associate" (or Chinese equivalents)
 * takes the SKIP_RE bypass.
 * The copy is unified across the claude-code / workbuddy / codex / codebuddy / dsh
 * endpoints to avoid drift between clients.
 */
const SKIP_HINT = ' (Selecting "skip" will bypass session init and inject no team assets)';

/** Returns true if the given string contains any dsh form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_call id belongs to a dsh session-init form. */
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
  /** @deprecated dsh does not paginate (see the file header); the field is kept so session/index.ts dispatch can pass it through; the builder ignores it. */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// ── ask_user_question input schema (dsh snake_case + required id) ──────────────

interface DshAskQuestionOption {
  label: string;
  description: string;
}

interface DshAskQuestion {
  /** Hard requirement of the dsh schema, echoed in the answer; the proxy generates a stable id (a short label for the question). */
  id: string;
  question: string;
  header: string;
  options: DshAskQuestionOption[];
  /** dsh uses snake_case, unlike CC's multiSelect camelCase. */
  multi_select: boolean;
}

function buildAskUserQuestionArgs(data: FormData): { questions: DshAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: DshAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      id: "asset_confirm",
      question: titlePrefix + "Would you like to associate team assets for this conversation?" + SKIP_HINT,
      header: "Associate Assets",
      options: [
        { label: ASSET_CONFIRM_YES, description: "Select Team / Agent / Task, inject team context" },
        { label: ASSET_CONFIRM_NO, description: "Do not inject anything this time, proceed directly" },
      ],
      multi_select: false,
    });
    return { questions };
  }

  if (stage === "team") {
    // dsh has no options-count cap; render all, no pagination (see the header comment).
    const teamOpts: DshAskQuestionOption[] = teams.map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: "",
    }));
    if (teamOpts.length < 2) {
      throw new Error(
        `[dsh form] team stage requires ≥2 teams (got ${teamOpts.length}). ` +
          `Caller must auto-select when teams.length === 1.`,
      );
    }
    questions.push({
      id: "team_select",
      question: titlePrefix + "Please select the Team for this session:" + SKIP_HINT,
      header: "Team",
      options: teamOpts,
      multi_select: false,
    });
    return { questions };
  }

  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    // dsh has no options-count cap; render all, no pagination.
    const combinedOptions: DshAskQuestionOption[] = team.agents.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: a.description ?? "",
    }));

    if (combinedOptions.length < 2) {
      throw new Error(
        `[dsh form] agent stage requires ≥2 agents (got ${combinedOptions.length}). ` +
          `Caller must handle single-agent auto-select upstream.`,
      );
    }

    questions.push({
      id: "agent_select",
      question: titlePrefix + `Please select the Agent to use under "${team.team_name}":` + SKIP_HINT,
      header: "Agent",
      options: combinedOptions,
      multi_select: false,
    });
    return { questions };
  }

  if (stage === "task_select") {
    // dsh has no options-count cap; render all, no pagination.
    // team.tasks[0] is the virtual default task ("do not associate a task this time"),
    // unshifted once at the source — without pagination it no longer shows up at the
    // start of every page like in the old version (pitfall doc §6, pitfall #9).
    const taskOpts: DshAskQuestionOption[] = team.tasks.map((t) => ({
      label: t.isDefault
        ? t.task_name
        : `${t.task_name} (${t.task_id.slice(-8)})`,
      description: "",
    }));

    if (taskOpts.length < 2) {
      throw new Error(
        `[dsh form] task stage requires ≥2 tasks (got ${taskOpts.length}). ` +
          `Default task should always be prepended by fetchTeamsAndAgents.`,
      );
    }

    questions.push({
      id: "task_select",
      question: titlePrefix + `Please select the Task to associate under "${team.team_name}":` + SKIP_HINT,
      header: "Task",
      options: taskOpts,
      multi_select: false,
    });
    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build a dsh `ask_user_question` fake form response.
 *
 * Transport: **OpenAI chat/completions** (stream or non-stream).
 * arguments shape: dsh native `{questions: [{id, question, header, options, multi_select}]}`.
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const id = "dsh-session-init-" + Date.now();
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
        // deepseek thinking-mode hard constraint — full analysis in the REASONING_PLACEHOLDER definition.
        // Key: it must be **non-empty**, otherwise the client's translate.ts:133 `reasoning.length > 0`
        // predicate drops it and serialize.ts:99 then sees length 0 on the output side → the upstream body is missing the field → 400.
        reasoning_content: REASONING_PLACEHOLDER,
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
      // Chunk 1: role + tool_call declaration (empty arguments) + reasoning_content
      // reasoning_content must be **non-empty** (value = REASONING_PLACEHOLDER) — an empty
      // string is dropped by dsh translate.ts:133, not echoed back at serialize time, upstream 400.
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            reasoning_content: REASONING_PLACEHOLDER,
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
