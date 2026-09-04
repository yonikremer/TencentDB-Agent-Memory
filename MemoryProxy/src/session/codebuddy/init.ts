/**
 * CodeBuddy Session Initialization — State Machine Entry.
 *
 * Flow:
 *   1. uninitialized → Kernel pulls teams[], sends `ask_followup_question` form
 *   2. pending_team_select → Parses user team selection, sends agent_task form
 *   3. pending_agent_task → Parses agent+task, fetches details, registers, injects
 *   4. initialized → Strips + injects on every request
 */

import type { SessionInitConfig } from "../../types.js";
import type {
  AgentDetail,
  SessionInitData,
  SessionInitState,
  SessionRegistrationData,
  TaskDetail,
  TaskInTeam,
  TeamOption,
} from "../types.js";
import { DEFAULT_TASK_LABEL } from "../types.js";
import { SessionStore } from "../store.js";
import { buildSessionInfo } from "../registrar.js";
import { injectSessionContextWithToggles } from "../context-injector.js";
import type { MetadataClient } from "../../meta/client.js";
import { resolvePresetIdentity, type PresetIdentity } from "../preset.js";

import { buildFormResponse, FormData } from "./form.js";
import {
  extractFromOptionText,
  extractTeamFromOptionText,
  extractAssetConfirm,
  extractStructured,
  extractAgentOnly,
  extractTaskOnly,
  resolveAgent,
  resolveTask,
  BYPASS_MARKER,
} from "./extractor.js";
import { getLastUserMessageText } from "./cleaner.js";
import { emitSessionInitTelemetryIfCompleted } from "../init-telemetry.js";
import { isDshRuntimeContextSnapshot } from "../../common/user-query-extractor.js";
import {
  CODEX_MORE_LABEL,
  DEFAULT_GATE_PREFIX,
  detectCodexMore,
} from "../codex/form.js";
// WorkBuddy reuses CC's AskUserQuestion form + CC pagination layout (workbuddy/form.ts directly
// imports computePagination + MORE_LABEL="More →"). When WorkBuddy runs through the CB state machine,
// its MORE pagination interception needs the same MORE_LABEL check + computePagination out-of-bounds
// check to stay aligned with the form-side slicing. CC's MORE_LABEL value is identical to workbuddy/form.ts.
import { MORE_LABEL as WB_MORE_LABEL } from "../claude-code/form.js";
import { computePagination as computeCCPagination } from "../claude-code/pagination.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SessionRequestContext {
  stream: boolean;
  modelId: string;
  protocol?: "openai" | "anthropic";
  /**
   * codex client exclusive: codex replies do not use the CB-compatible messages[], but are embedded
   * as the `function_call_output` item in `body.input[]`. codexHandler has already used
   * `codexFormAnswersAsMessages` to extract a copy of `messages` to hand over to the CB state machine for normal
   * option matching, but the state machine internally still needs the **raw** input[] to:
   *   1. Detect Default mode gate strings (the client replays historical gate outputs every time)
   *   2. Accurately pinpoint whether MORE hit team/agent/task based on question id
   *
   * CC/normal CB scenarios never pass this field.
   */
  codexAnswerInput?: unknown[];
  /**
   * CB v1.106+ ask_followup_question schema requires questions to be a true array;
   * older versions expect a JSON string. The handler detects this from body.tools and fills this field,
   * the form builder uses this to decide whether to JSON.stringify(questions).
   * Defaults to true if unset (aligning with newer versions).
   */
  questionsAsArray?: boolean;
}

export interface SessionInitResult {
  intercepted: boolean;
  response?: Response;
  messages?: Record<string, unknown>[];
  sessionInfo?: import("../types.js").SessionInfo | null;
  justRegistered?: boolean;
  agentDetail?: AgentDetail | null;
  taskDetail?: TaskDetail | null;
  /** User selects "No" — don't associate team assets → bypass path; every injection hook should skip. */
  bypassed?: boolean;
  /**
   * Bypass trigger reason (meaningful only when `bypassed === true`). codexHandler uses it to decide
   * whether the first gate hit should return a "Plan mode hint" rather than passing through directly.
   *
   * - "default-gate"  → codex client's Default mode intercepted our request_user_input
   *                     and forged a "request_user_input is unavailable in Default mode"
   *                     string; codexHandler should return a Plan mode hint once before entering steady
   *                     bypass state.
   * - undefined       → Other bypass paths (user explicitly selected "No", no-agents, preset
   *                     mismatch, etc.), takes the respective handler's default bypass behavior.
   *
   * CC/CB clients themselves cannot trigger default-gate (clients don't forge gate strings), keeping
   * the constant for cross-handler evaluation is sufficient.
   */
  bypassReason?: "default-gate";
  /**
   * Anthropic-only: pre-built `<session_context>` string the caller must
   * append to `body.system` (the ClaudeCode init module populates this;
   * CodeBuddy stays OpenAI so it is always undefined here). Kept in this
   * interface so `session/index.ts`'s union type stays uniform.
   */
  systemAppend?: string | null;
  /**
   * Raw FormData — always populated when `intercepted === true`.
   *
   * The codex handler re-renders it into OpenAI Responses API SSE format
   * (`response.output_item.added` + `function_call` item) via
   * `session/codex/form.ts::buildFormResponse`. CB / CC themselves never read
   * this field — `response` is already the complete response in their protocol.
   */
  formData?: FormData;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

type MessageArr = Record<string, unknown>[];

/**
 * codex-only: Determine whether the last function_call_output in `body.input[]` is a
 * client Default mode gate interception. Since the client carries historical gate outputs every round,
 * "whether it's the first hit" is judged by the caller by checking sessionStore.bypassed;
 * here we are only responsible for structural identification.
 *
 * CB/CC clients never send this string, so it remains safe to opt-in checking this codex-exclusive
 * scenario in the CB state machine (agentSource==="codex" + reqCtx.codexAnswerInput non-empty).
 */
function detectCodexDefaultGate(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  // Only recognize the case where "the very last item in input is the gate output" — meaning this round
  // the codex client intercepted the tool_call and directly replayed the gate.
  //
  // Why must we look at the **last item** rather than the "latest function_call_output":
  // The codex client replays the entire historical input every round. Once a Default mode
  // gate output appears in history, it will permanently settle in the input. When the user switches from Default to Plan and resends the command,
  // the client will append a **new user message** at the end of the input (that mem:session-reset
  // or the user's answer to the form), while the old gate output remains in the middle. If we scan for the "latest function_call_output",
  // it would permanently hit the old gate, creating an infinite loop stuck on the "please switch to Plan mode" message.
  //
  // Only when the tail is function_call_output (meaning the client just replayed the gate and hasn't let the user input yet)
  // do we judge it as Default; if the tail is a user message / tool_use / etc. → it means the current turn is a new turn,
  // ignoring historical residual gates.
  const last = input[input.length - 1] as Record<string, unknown> | null | undefined;
  if (!last || typeof last !== "object") return false;
  if (last.type !== "function_call_output") return false;
  const output = last.output;
  return typeof output === "string" && output.startsWith(DEFAULT_GATE_PREFIX);
}

/**
 * codex-only: Based on recovered.status + detectCodexMore().perQuestion, decide
 * which pageIndex (team/agent/task) should be bumped. Returns the bump result and the pre-filled
 * new codexPageIndex object; the caller uses it to write state + resend the form of the same stage.
 *
 * partialMore scenario (agent is a real choice, task=more): directly increment pageIndex on the task side by 1
 * and pass it to the CB state machine for continued consumption — CB will only hit the real chosen agent and advance the grand state;
 * the task side relies on the taskPage value of the next stage form to re-prompt.
 */
function computeCodexPageBumps(
  cur: { teamPage?: number; agentPage?: number; taskPage?: number } | undefined,
  perQuestion: { team_select: boolean; agent_select: boolean; task_select: boolean },
  fallbackStage: "team" | "agent" | "task" | null,
): { next: { teamPage: number; agentPage: number; taskPage: number }; bumped: Array<"team" | "agent" | "task"> } {
  const teamPage = cur?.teamPage ?? 0;
  const agentPage = cur?.agentPage ?? 0;
  const taskPage = cur?.taskPage ?? 0;
  const bumped: Array<"team" | "agent" | "task"> = [];
  let nextTeam = teamPage;
  let nextAgent = agentPage;
  let nextTask = taskPage;
  if (perQuestion.team_select) { nextTeam++; bumped.push("team"); }
  if (perQuestion.agent_select) { nextAgent++; bumped.push("agent"); }
  if (perQuestion.task_select) { nextTask++; bumped.push("task"); }
  if (bumped.length === 0 && fallbackStage) {
    if (fallbackStage === "team") { nextTeam++; bumped.push("team"); }
    else if (fallbackStage === "agent") { nextAgent++; bumped.push("agent"); }
    else if (fallbackStage === "task") { nextTask++; bumped.push("task"); }
  }
  return { next: { teamPage: nextTeam, agentPage: nextAgent, taskPage: nextTask }, bumped };
}

/**
 * Generates a FormData equipped with codex pagination page numbers for the codex handler to re-render. CB clients
 * will ignore these page number fields (CB `ask_followup_question` doesn't paginate).
 */
function withCodexPageIndex(
  fd: FormData,
  px: { teamPage?: number; agentPage?: number; taskPage?: number } | undefined,
): FormData {
  if (!px) return fd;
  return {
    ...fd,
    teamPage: px.teamPage ?? 0,
    agentPage: px.agentPage ?? 0,
    taskPage: px.taskPage ?? 0,
  };
}

/**
 * WorkBuddy-only: Detects if the user's answer in a certain stage clicked "More →", and if hit, calculates the post-flip
 * pageIndex (wrapping back to page 0 if out of bounds).
 *
 * Background: WorkBuddy (agentSource="workbuddy") reuses the CB state machine to run the entire flow:
 * uninitialized → pending_team_select → pending_agent_select → pending_task_select,
 * but form rendering goes through workbuddy/form.ts (AskUserQuestion + CC pagination,
 * MORE_LABEL="More →"). The CB state machine originally only intercepts MORE in the agentSource="codex" branch
 * (the isCodexSource gate in Section B). When WorkBuddy falls into the pending_*_select branch,
 * extractAgentOnly/extractTaskOnly fails to recognize "More →" → unrecognized → infinitely resends page 1.
 *
 * Fix: At the entry of each pending_*_select branch, before running the extractor, first use this function to evaluate
 * MORE. If hit, bump the page number of the corresponding stage and resend the same-stage form (the page number is
 * picked from codexPageIndex by the workbuddy re-rendering branch in session/index.ts according to the stage,
 * and passed to workbuddy/form.ts's pageIndex).
 *
 * @param answerText  The user answer text extracted by getLastUserMessageText(messages)
 * @param currentPage The current stage's page number (0-based)
 * @param total       Total candidates in the current stage (agents.length / tasks.length / teams.length)
 * @returns null=not MORE; number=post-flip pageIndex (wraps to 0 on out of bounds)
 */
function detectWorkbuddyMorePage(
  answerText: string,
  currentPage: number,
  total: number,
): number | null {
  if (!answerText.includes(WB_MORE_LABEL)) return null;
  const nextPage = currentPage + 1;
  // Use the same pagination algorithm as the form side to check for out-of-bounds, preventing it from stopping
  // at an out-of-bounds page after flipping past the last page which causes the form to throw
  // a solo-page assertion; aligns with safeNextPage wrap-around logic in claude-code/init.ts.
  const totalPages = computeCCPagination(Math.max(0, total), 0).totalPages;
  return nextPage > totalPages - 1 ? 0 : nextPage;
}

/** Determines whether this is a "brand new" CodeBuddy / dsh conversation (at most one real user message, no assistant/tool).
 *
 * dsh (deepseek-harness) stuffs 3 role=user metadata entries that are **not user input** into the first-frame body:
 *   - <system-reminder> workspace instructions
 *   - the "Current runtime context." snapshot
 *   - the <available_skills> list (<system-reminder>\nA skill is a reusable...)
 * Counting them verbatim would misjudge the dsh first frame as "not new" → the upstream safety-net would skip session-init.
 * Here, when counting, skip user messages that carry the dsh metadata signature (str content starting with a known anchor).
 * See MemoryProxy/docs/dsh-recon/2026-08-14-dsh-capture-analysis.md §2.3.
 */
function isFreshCBConversation(messages: MessageArr): boolean {
  let userCount = 0;
  for (const m of messages) {
    const role = (m.role as string) ?? "";
    if (role === "assistant" || role === "tool") return false;
    if (role !== "user") continue;
    // dsh-metadata user messages don't count as real user input
    const c = (m as { content?: unknown }).content;
    if (typeof c === "string") {
      if (
        c.startsWith("<system-reminder>") ||
        isDshRuntimeContextSnapshot(c)
      ) {
        continue;
      }
    }
    userCount++;
    if (userCount > 1) return false;
  }
  return userCount <= 1;
}

async function fetchTeamsAndAgents(
  userId: string,
  config: SessionInitConfig,
  metadataClient: MetadataClient,
): Promise<{ teams: TeamOption[] }> {
  const teamsRaw = await metadataClient.listTeams(userId);
  const teams: TeamOption[] = [];

  // Parallel fan-out: for each team, fetch agents & tasks concurrently
  const teamResults = await Promise.all(
    teamsRaw.map(async (t) => {
      const [agentsRaw, tasksRaw] = await Promise.all([
        // Agents are scoped to (team, owner) — each user only sees the agents
        // they created within the team. Tasks remain team-wide (unchanged).
        metadataClient.listAgents(t.team_id, userId),
        metadataClient.listTasks(t.team_id),
      ]);
      const tasks: TaskInTeam[] = tasksRaw.map((tk) => ({
        task_id: tk.task_id,
        task_name: tk.title,
      }));
      // See the matching comment in claude-code/init.ts fetchTeamsAndAgents: defaultTaskId
      // is unshifted to the head of the tasks list at the source; downstream form/extractor ride the existing path.
      if (config.defaultTaskId) {
        tasks.unshift({
          task_id: config.defaultTaskId,
          task_name: DEFAULT_TASK_LABEL,
          isDefault: true,
        });
      }
      return {
        team_id: t.team_id,
        team_name: t.name,
        agents: agentsRaw.map((a) => ({
          agent_id: a.agent_id,
          agent_name: a.name,
          description: a.description ?? undefined,
        })),
        tasks,
      };
    }),
  );
  teams.push(...teamResults);
  return { teams };
}

function findTeamIdForAgent(teams: TeamOption[], agentId: string): string | undefined {
  for (const team of teams) {
    if (team.agents.some((a) => a.agent_id === agentId)) return team.team_id;
  }
  return undefined;
}

/**
 * Assemble the registration payload for a resolved (agent, task). Returns
 * `null` when the agent cannot be matched to any team in the cached list —
 * the caller must bypass session init in that case (there is no
 * `defaultTeamId` fallback any more).
 */
function buildRegistrationData(
  extracted: SessionInitData,
  cachedTeams: TeamOption[],
  sessionId: string,
  userId: string,
): SessionRegistrationData | null {
  const teamId = findTeamIdForAgent(cachedTeams, extracted.agent_id);
  if (!teamId) return null;
  return {
    team_id: teamId,
    user_id: userId,
    agent_id: extracted.agent_id,
    task_id: extracted.task_id,
    session_id: sessionId,
  };
}

function applyArtifactsAndContext(
  messages: MessageArr,
  agentDetail: AgentDetail | null | undefined,
  taskDetail: TaskDetail | null | undefined,
  sessionKey: string,
  config: SessionInitConfig,
): MessageArr {
  // This used to decide whether to stripInitArtifacts based on config.keepInitArtifacts;
  // now the session_init form interaction is **always retained**, never removed.
  const injected = injectSessionContextWithToggles(messages, agentDetail, taskDetail, config, sessionKey);
  if (injected !== messages) {
    const finalRoles = (injected as unknown[]).map((m: any) => m.role);
    console.log(
      `[session-init:cb] session=${sessionKey} processed: ${messages.length} msgs, ` +
        `ctx=${agentDetail ? "Y" : "N"}/${taskDetail ? "Y" : "N"} final=[${finalRoles.join(",")}]`,
    );
  }
  return injected as MessageArr;
}

/**
 * Register a session given a resolved agent(+task), fetch details, inject context.
 * Shared by the interactive form path (Case 2) and the header pre-selection path.
 */
export async function completeRegistration(
  resolved: SessionInitData,
  state: SessionInitState,
  cachedTeams: TeamOption[],
  compositeKey: string,
  sessionKey: string,
  userId: string | null,
  config: SessionInitConfig,
  store: SessionStore,
  messages: MessageArr,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
): Promise<SessionInitResult> {
  const regUserId = (state as any).userId || userId;
  if (!regUserId) {
    console.warn(
      `[session-init:cb] session=${compositeKey} no user_id available → bypass`,
    );
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
  }
  // task_id is OPTIONAL for registration: the kernel treats task as an
  // optional business dimension (isolation.ts), so a header-identity agent
  // with team+agent but no task (or a stale task) still registers and gets
  // memory — recall just broadens across the agent's memories instead of
  // narrowing to a task. The interactive "Don't bind a task this time" / defaultTaskId path
  // also lands here with task_id = defaultTaskId (a virtual value). Do NOT
  // bypass when task_id is missing/undefined.
  const regData = buildRegistrationData(resolved, cachedTeams, sessionKey, regUserId);
  if (!regData) {
    console.warn(
      `[session-init:cb] session=${compositeKey} agent=${resolved.agent_id} not bound to any team → bypass`,
    );
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
  }

  let agentDetail: AgentDetail | null = null;
  let taskDetail: TaskDetail | null = null;

  if (metadataClient) {
    // When task_id is defaultTaskId (virtual value), skip getTask — the kernel does not have this task.
    const shouldFetchTask = regData.task_id && regData.task_id !== config.defaultTaskId;
    const [agentRes, taskRes] = await Promise.allSettled([
      metadataClient.getAgent(resolved.agent_id).then((a) => ({
        id: a.agent_id,
        name: a.name,
        description: a.description ?? undefined,
        prompt: a.prompt ?? undefined,
      })),
      shouldFetchTask
        ? metadataClient.getTask(regData.task_id!).then((t) => ({
            id: t.task_id,
            name: t.title,
            description: t.description ?? undefined,
          }))
        : Promise.resolve(null),
    ]);
    if (agentRes.status === "fulfilled") agentDetail = agentRes.value;
    else console.warn(`[session-init:cb] getAgent failed: ${String(agentRes.reason)}`);
    if (taskRes.status === "fulfilled") taskDetail = taskRes.value;
    else console.warn(`[session-init:cb] getTask failed: ${String(taskRes.reason)}`);
  }

  const sessionInfo = buildSessionInfo(regData, userKey, spaceId);
  console.log(
    `[session-init:cb] session=${compositeKey} → initialized ` +
      `agent=${resolved.agent_id} task=${regData.task_id ?? "-"} team=${regData.team_id} user=${sessionInfo.user_id}`,
  );

  // Fire-and-forget: record a participation log (aligned with the claude-code branch, source marked as codebuddy).
  // Bypass scenarios have already returned above and are filtered out naturally; failures only warn, never block injection.
  if (
    metadataClient &&
    typeof metadataClient.appendParticipationLog === "function" &&
    regData.task_id
  ) {
    metadataClient
      .appendParticipationLog({
        team_id: regData.team_id,
        task_id: regData.task_id,
        agent_id: regData.agent_id,
        user_id: regData.user_id,
        source: "context_proxy:codebuddy",
      })
      .catch((err: unknown) => {
        console.warn(
          `[session-init:cb] participation-log append failed for session=${compositeKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  const nextState: SessionInitState = {
    status: "initialized",
    keyId: sessionKey,
    startedAt: state.startedAt,
    attemptCount: state.attemptCount,
    sessionInfo,
    userId: regUserId,
    cachedTeams: state.cachedTeams ?? cachedTeams,
    selectedTeamId: state.selectedTeamId,
    agentDetail,
    taskDetail,
    resetFlow: state.resetFlow,
    resetEpoch: state.resetEpoch,
  };
  await store.set(compositeKey, nextState);

  const out = applyArtifactsAndContext(messages, agentDetail, taskDetail, compositeKey, config);
  return {
    intercepted: false,
    messages: out,
    sessionInfo,
    justRegistered: true,
    agentDetail,
    taskDetail,
    resetFlow: state.resetFlow ?? false,
  };
}

// ── Main Handler ───────────────────────────────────────────────────────────────

/**
 * Top-level entry wrapper: decorates handleSessionInitInner and emits a telemetry
 * event once it completes (only when prev !== initialized && after === initialized).
 *
 * The telemetry decoration never mutates the state machine; failures/exceptions are silent
 * and invisible to the business flow.
 * See docs/design/2026-08-03-internal-usage-telemetry-plan.md §7.2.
 */
export async function handleSessionInit(
  sessionKey: string,
  userId: string | null,
  messages: MessageArr,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
  presetIdentity?: PresetIdentity,
  agentSource: string = "codebuddy",
): Promise<SessionInitResult> {
  const compositeKey = `${agentSource}:${sessionKey}`;
  const prevStatus = store.get(compositeKey)?.status ?? "uninitialized";
  try {
    const result = await handleSessionInitInner(
      sessionKey, userId, messages, config, store, reqCtx,
      metadataClient, userKey, spaceId, presetIdentity, agentSource,
    );
    // codex-only post-pass enhancement: stuff the latest state's codexPageIndex into formData
    // so that codexHandler's buildCodexFormResponse gets the correct pagination page numbers. Thus
    // none of the return { intercepted: true } sites inside handleSessionInitInner
    // needs a per-site change. CB clients ignore these fields.
    if (agentSource === "codex" && result.intercepted && result.formData) {
      const latest = store.get(compositeKey);
      if (latest?.codexPageIndex) {
        result.formData = withCodexPageIndex(result.formData, latest.codexPageIndex);
      }
    }
    return result;
  } finally {
    emitSessionInitTelemetryIfCompleted({
      store,
      compositeKey,
      prevStatus,
      agentSource,
    });
  }
}

async function handleSessionInitInner(
  sessionKey: string,
  userId: string | null,
  messages: MessageArr,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
  presetIdentity?: PresetIdentity,
  agentSource: string = "codebuddy",
): Promise<SessionInitResult> {
  const compositeKey = `${agentSource}:${sessionKey}`;
  if (sessionKey === "unknown" || !sessionKey) return { intercepted: false };

  const state = store.get(compositeKey);

  // ── codex-only pre-checks: Default gate + MORE pagination ───────────────
  //
  // These two recognizers can never fire for CB/CC clients (DEFAULT_GATE_PREFIX / CODEX_MORE_LABEL
  // are codex-client-exclusive strings), so they are only enabled when opted into a codex source that
  // also has a raw input; legacy CB users see zero regression.
  //
  // isCodexClient (agentSource === "codex") is the master switch for "stage splitting":
  //   - Any codex client runs session-init through the two-step pending_agent_select →
  //     pending_task_select, never landing on the legacy pending_agent_task.
  //   - The CB client's ask-both-at-once pending_agent_task path is left completely untouched.
  // The codexInput check lives inside pre-checks because gate/MORE recognition only happens when
  // the current request also carries an answer; an empty-input first frame doesn't need it, but it
  // still follows the codex semantics for the subsequent stage splitting.
  const codexInput = reqCtx.codexAnswerInput;
  const isCodexClient = agentSource === "codex";
  const isCodexSource = isCodexClient && Array.isArray(codexInput);

  // A. Default-mode gate — the codex client intercepted request_user_input and backfilled the
  //    "request_user_input is unavailable in Default mode" string. On the first hit, fall into a bypass
  //    state + attach a bypassReason so codexHandler returns a Plan-mode hint once; subsequent requests
  //    on the same session pass straight through (state.bypassed=true is already covered by the Case 3
  //    branch).
  if (isCodexSource && detectCodexDefaultGate(codexInput)) {
    const alreadyBypassed = state?.bypassed === true;
    if (!alreadyBypassed) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state?.startedAt ?? Date.now(),
        attemptCount: state?.attemptCount ?? 0,
        userId: state?.userId ?? (userId ?? undefined),
        cachedTeams: state?.cachedTeams,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(
        `[session-init:cb] session=${compositeKey} codex Default gate → bypass (first hit, notify)`,
      );
      return {
        intercepted: false,
        bypassed: true,
        justRegistered: true,
        bypassReason: "default-gate",
        // When the codex Default gate fires from a mem:session-reset, resetFlow is threaded out of the old state
        // so codexHandler can swap in the targeted "reset command needs Plan mode" copy.
        resetFlow: state?.resetFlow ?? false,
      };
    }
    // Already bypassed: fall through, Case 3 takes the pass-through branch
  }

  // B. MORE pagination — the user clicked the "More..." option. The CB state machine recognizes and
  //    advances/pages through it itself rather than letting codexHandler intercept independently. Order of
  //    evaluation: first check whether there is a real answer (partial vs full MORE); only intercept the whole
  //    request on fullMore. partialMore lets the real answer advance the grand state, and the MORE side's next
  //    stage form automatically carries the new pageIndex after the advance.
  if (
    isCodexSource &&
    state &&
    state.status !== "initialized" &&
    state.status !== "uninitialized"
  ) {
    const detection = detectCodexMore(codexInput);
    if (detection.hasMore) {
      // Use the text produced by codexFormAnswersAsMessages to judge "does it contain a non-MORE real answer"
      const answerText = getLastUserMessageText(messages);
      const stripped = answerText.split(CODEX_MORE_LABEL).join("").trim();
      const hasRealAnswer = stripped.length > 0;
      const partialMore = hasRealAnswer && (
        !detection.perQuestion.team_select ||
        !detection.perQuestion.agent_select ||
        !detection.perQuestion.task_select
      );
      // fallbackStage: with a pure-string MORE, infer the stage back from state.status
      const fallbackStage: "team" | "agent" | "task" | null =
        detection.perQuestion.team_select || detection.perQuestion.agent_select || detection.perQuestion.task_select
          ? null
          : state.status === "pending_team_select"
            ? "team"
            : state.status === "pending_agent_task" || state.status === "pending_agent_select"
              ? "agent"
              : state.status === "pending_task_select"
                ? "task"
                : null;

      const { next, bumped } = computeCodexPageBumps(state.codexPageIndex, detection.perQuestion, fallbackStage);

      if (bumped.length > 0) {
        await store.set(compositeKey, { ...state, codexPageIndex: next });
        console.log(
          `[session-init:cb] session=${compositeKey} codex MORE (${bumped.join(",")}, ${partialMore ? "partial" : "full"}) → ` +
            `teamPage=${next.teamPage} agentPage=${next.agentPage} taskPage=${next.taskPage}`,
        );

        // Full MORE (no real answer) → intercept the whole request and return the next-page form for the current stage.
        // Partial MORE (real answer + MORE) → persist pageIndex but keep running the CB state machine to
        // consume the real answer; the MORE side is re-prompted by the next stage form's taskPage/agentPage values.
        if (!partialMore) {
          const cachedTeams = state.cachedTeams ?? [];
          // The stage is inferred from the current state.status. After the split, each pending_* maps to its
          // own independent stage, and the form returned to codex only asks that stage's question.
          let stage: FormData["stage"];
          if (state.status === "pending_team_select") stage = "team";
          else if (state.status === "pending_agent_select") stage = "agent_select";
          else if (state.status === "pending_task_select") stage = "task_select";
          else stage = "agent_task"; // legacy pending_agent_task (CB one-shot)
          const fd: FormData = withCodexPageIndex({
            teams: cachedTeams,
            stage,
            selectedTeamId: state.selectedTeamId,
            selectedAgentId: state.selectedAgentId,
            stream: reqCtx.stream,
            questionsAsArray: reqCtx.questionsAsArray,
            modelId: reqCtx.modelId,
            protocol: reqCtx.protocol,
          }, next);
          return { intercepted: true, response: buildFormResponse(fd), formData: fd };
        }
        // partial fall through to state-machine dispatch
      }
    }
  }

  // [session-reset] gate removed: always init on missing state

  // ── DEBUG BYPASS ─────────────────────────────────────────────────────
  // When the sessionInit.debugForceIdentity triple is fully present and the state is not yet initialized,
  // register directly with the forced identity, skipping listTeams / form rendering. Meant for local/E2E tests
  // that don't need to rely on the kernel's team/agent list endpoints.
  // Applies uniformly to every agentSource (codebuddy/workbuddy/codex).
  if (
    config.debugForceIdentity &&
    userId &&
    metadataClient &&
    (!state || state.status !== "initialized")
  ) {
    const forced = config.debugForceIdentity;
    console.log(
      `[session-init:cb] session=${compositeKey} DEBUG bypass — force identity ` +
        `team=${forced.team_id} agent=${forced.agent_id} task=${forced.task_id ?? "-"} user=${userId}`,
    );
    const forcedTeams: TeamOption[] = [
      {
        team_id: forced.team_id,
        team_name: forced.team_id,
        agents: [
          { agent_id: forced.agent_id, agent_name: forced.agent_id } as any,
        ],
        tasks: forced.task_id
          ? [{ task_id: forced.task_id, task_name: forced.task_id } as any]
          : [],
      } as TeamOption,
    ];
    const seededState: SessionInitState = (state ?? {
      status: "uninitialized",
      keyId: sessionKey,
      startedAt: Date.now(),
      attemptCount: 0,
      userId,
    }) as SessionInitState;
    return await completeRegistration(
      { agent_id: forced.agent_id, task_id: forced.task_id } as any,
      seededState,
      forcedTeams,
      compositeKey,
      sessionKey,
      userId,
      config,
      store,
      messages,
      metadataClient,
      userKey,
      spaceId,
    );
  }

  // ── Case 1: Uninitialized → first pop the asset_confirm dialog ─────────
  if (!state || state.status === "uninitialized") {
    if (!userId) {
      console.warn(
        `[session-init:cb] session=${compositeKey} no userId, passing through unintercepted`,
      );
      return { intercepted: false };
    }
    if (!metadataClient) {
      console.warn(
        `[session-init:cb] session=${compositeKey} no metadataClient, passing through unintercepted`,
      );
      return { intercepted: false };
    }

    let teams: TeamOption[];
    try {
      const cfg = await fetchTeamsAndAgents(userId, config, metadataClient);
      teams = cfg.teams;
    } catch (err) {
      console.warn(
        `[session-init:cb] session=${compositeKey} kernel unavailable for user=${userId}, passing through unintercepted: ${err instanceof Error ? err.message : String(err)}`,
      );
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        userId,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    const totalAgents = teams.reduce((acc, t) => acc + t.agents.length, 0);
    if (totalAgents === 0) {
      console.warn(
        `[session-init:cb] session=${compositeKey} user=${userId} has no active agents, passing through`,
      );
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        userId,
        cachedTeams: teams,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    // ── Header-driven pre-selection: skip forms when identity is provided ──
    if (presetIdentity && config.headerAutoSelect?.enabled) {
      const pr = resolvePresetIdentity(teams, presetIdentity);

      if (pr.hadMismatch) {
        if (config.headerAutoSelect.onMismatch === "bypass") {
          console.warn(`[session-init:cb] session=${compositeKey} preset mismatch → bypass`);
          await store.set(compositeKey, {
            status: "initialized",
            keyId: sessionKey,
            startedAt: Date.now(),
            attemptCount: 0,
            userId,
            cachedTeams: teams,
            sessionInfo: null,
            agentDetail: null,
            taskDetail: null,
            bypassed: true,
          } as SessionInitState);
          return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
        }
        console.warn(`[session-init:cb] session=${compositeKey} preset mismatch → fallback to form`);
        // fall through to the normal asset_confirm flow below
      } else if (pr.canRegister) {
        // team + agent resolved → register directly (task optional). A missing
        // task_id yields undefined → broad recall across the agent's memories;
        // a stale (unknown) task_id was already dropped by resolvePresetIdentity
        // (not echoed back) — warn so the operator can re-point the client.
        if (presetIdentity?.taskId && !pr.taskId) {
          console.warn(
            `[session-init:cb] session=${compositeKey} preset task_id="${presetIdentity.taskId}" not found in team=${pr.teamId} → registering without a task (broad recall)`,
          );
        }
        console.log(
          `[session-init:cb] session=${compositeKey} preset hit team=${pr.teamId} agent=${pr.agentId} task=${pr.taskId ?? "-"} → register directly`,
        );
        const seedState: SessionInitState = {
          status: "uninitialized",
          keyId: sessionKey,
          startedAt: Date.now(),
          attemptCount: 0,
          userId,
          cachedTeams: teams,
          selectedTeamId: pr.teamId,
        };
        return completeRegistration(
          { agent_id: pr.agentId!, task_id: pr.taskId },
          seedState, teams, compositeKey, sessionKey, userId,
          config, store, messages, metadataClient, userKey, spaceId,
        );
      } else if (pr.teamId) {
        // only team resolved → jump straight to agent+task selection (skip
        // asset_confirm + team_select). codex/WB/dsh/opencode use the two-step stage split, agent_select first;
        // the CB client keeps the legacy ask-both-at-once pending_agent_task semantics.
        //
        // opencode note: opencode's native `question` tool can only pop one question at a time,
        // so it cannot carry the "ask agent+task together" semantics and must split stages (same as codex/wb/dsh).
        const nextStatus = (isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode") ? "pending_agent_select" : "pending_agent_task";
        const nextStage: FormData["stage"] = (isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode") ? "agent_select" : "agent_task";
        await store.set(compositeKey, {
          status: nextStatus,
          keyId: sessionKey,
          startedAt: Date.now(),
          attemptCount: 0,
          userId,
          cachedTeams: teams,
          selectedTeamId: pr.teamId,
        });
        console.log(
          `[session-init:cb] session=${compositeKey} preset team=${pr.teamId} → ${nextStatus}`,
        );
        const fd: FormData = {
          teams,
          stage: nextStage,
          selectedTeamId: pr.teamId,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        };
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
    }

    // First pop the asset_confirm dialog
    await store.set(compositeKey, {
      status: "pending_asset_confirm",
      keyId: sessionKey,
      startedAt: Date.now(),
      attemptCount: 0,
      userId,
      cachedTeams: teams,
    });
    console.log(
      `[session-init:cb] session=${compositeKey} user=${userId} → pending_asset_confirm (teams=${teams.length})`,
    );
    const fd: FormData = {
      teams,
      stage: "asset_confirm",
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 1.25: Awaiting asset_confirm ────────────────────────────────────
  if (state.status === "pending_asset_confirm") {
    const lastUserText = getLastUserMessageText(messages);
    const choice = extractAssetConfirm(lastUserText);
    if (config.debugVerboseLogging) {
      console.log(
        `[session-init:cb-debug] asset_confirm session=${compositeKey} choice=${choice} lastUserText=${JSON.stringify(lastUserText).slice(0, 300)}`,
      );
    }

    if (choice === false) {
      // bypass: the user explicitly chose "no association" — keep the form conversation as-is, do not delete.
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: state.attemptCount,
        userId: state.userId,
        cachedTeams: state.cachedTeams,
        selectedTeamId: undefined,
        agentDetail: null,
        taskDetail: null,
        sessionInfo: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} user chose no-asset → bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (choice === true) {
      const teams = state.cachedTeams ?? [];
      if (teams.length === 1) {
        const onlyTeam = teams[0];
        // Cascading auto-select: when team=1 and the agent is also the only one, skip the agent form;
        // if there is only 1 task, auto-select one step further to avoid a solo-page assertion in the form.
        // This chain is shared by CB / WB / codex (the legacy CB path would ask both in one agent_task
        // round, but with a single agent it should likewise be skipped).
        if (onlyTeam.agents.length === 1) {
          const soloAgent = onlyTeam.agents[0];
          const nextState: SessionInitState = {
            ...state,
            status: "pending_agent_select" as any,
            keyId: sessionKey,
            attemptCount: 0,
            cachedTeams: teams,
            selectedTeamId: onlyTeam.team_id,
            selectedAgentId: soloAgent.agent_id,
          };
          console.log(
            `[session-init:cb] session=${compositeKey} only-team=${onlyTeam.team_id} only-agent=${soloAgent.agent_id} auto-select`,
          );
          // 0 tasks → bypass; 1 task → completeRegistration directly; ≥2 → emit a task form.
          if (onlyTeam.tasks.length === 0) {
            await store.set(compositeKey, {
              ...nextState,
              status: "initialized",
              sessionInfo: null,
              agentDetail: null,
              taskDetail: null,
              bypassed: true,
            } as SessionInitState);
            console.log(
              `[session-init:cb] session=${compositeKey} team has 0 tasks → bypass`,
            );
            return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
          }
          if (onlyTeam.tasks.length === 1) {
            const soleTaskId = onlyTeam.tasks[0].task_id;
            console.log(
              `[session-init:cb] session=${compositeKey} auto-select single task=${soleTaskId} → completeRegistration`,
            );
            return await completeRegistration(
              { agent_id: soloAgent.agent_id, task_id: soleTaskId },
              nextState, teams, compositeKey, sessionKey, userId,
              config, store, messages, metadataClient, userKey, spaceId,
            );
          }
          // ≥2 tasks: switch to the task_select stage and emit the task form.
          await store.set(compositeKey, {
            ...nextState,
            status: "pending_task_select",
          });
          console.log(
            `[session-init:cb] session=${compositeKey} → pending_task_select (tasks=${onlyTeam.tasks.length})`,
          );
          const fd: FormData = {
            teams,
            stage: "task_select",
            selectedTeamId: onlyTeam.team_id,
            selectedAgentId: soloAgent.agent_id,
            stream: reqCtx.stream,
            questionsAsArray: reqCtx.questionsAsArray,
            modelId: reqCtx.modelId,
            protocol: reqCtx.protocol,
          };
          return { intercepted: true, response: buildFormResponse(fd), formData: fd };
        }

        // ≥2 agents: the legacy CB path asks both at once via pending_agent_task; codex/WB/dsh/opencode
        // split stages and go through pending_agent_select. WB's form already asks in the CC style (split),
        // so route it through the codex branch to avoid the semantic ambiguity of landing in the legacy
        // agent_task stage where the form only asks the agent yet is processed with legacy semantics. opencode's
        // native `question` tool can only pop one question at a time, so it must also use the split stage.
        const useSplitStage = isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode";
        const nextStatus = useSplitStage ? "pending_agent_select" : "pending_agent_task";
        const nextStage: FormData["stage"] = useSplitStage ? "agent_select" : "agent_task";
        await store.set(compositeKey, {
          status: nextStatus,
          keyId: sessionKey,
          startedAt: state.startedAt,
          attemptCount: 0,
          userId: state.userId,
          cachedTeams: teams,
          selectedTeamId: onlyTeam.team_id,
        });
        console.log(
          `[session-init:cb] session=${compositeKey} only-team=${onlyTeam.team_id} → ${nextStatus}`,
        );
        const fd: FormData = {
          teams,
          stage: nextStage,
          selectedTeamId: onlyTeam.team_id,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        };
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }

      await store.set(compositeKey, {
        status: "pending_team_select",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams: teams,
      });
      console.log(
        `[session-init:cb] session=${compositeKey} → pending_team_select (teams=${teams.length})`,
      );
      const fd: FormData = {
        teams,
        stage: "team",
        stream: reqCtx.stream,
        questionsAsArray: reqCtx.questionsAsArray,
        modelId: reqCtx.modelId,
        protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd), formData: fd };
    }

    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} asset-confirm max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: state.cachedTeams ?? [],
      stage: "asset_confirm",
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 1.5: Awaiting team selection ─────────────────────────────────────
  if (state.status === "pending_team_select") {
    const lastUserText = getLastUserMessageText(messages);
    const teamId = extractTeamFromOptionText(lastUserText, state.cachedTeams ?? []);

    // The user actively bypasses in the team_select stage via SKIP_RE (skip / no association / skip)
    // (P1-4 fix). Mirrors the BYPASS_MARKER branch posture in pending_agent_select (init.ts:922) /
    // pending_task_select (init.ts:1037) — the legacy code missed it here, so a SKIP word was counted as
    // "unrecognized" against attemptCount and only forced a bypass after maxRetries (3 tries).
    if (teamId === BYPASS_MARKER) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams: state.cachedTeams ?? [],
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} team_select bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (teamId && teamId !== BYPASS_MARKER) {
      // codex/WB/dsh/opencode split stages: agent_select first → task_select; the CB legacy path keeps asking both at once in agent_task.
      const nextStatus = (isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode") ? "pending_agent_select" : "pending_agent_task";
      const nextStage: FormData["stage"] = (isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode") ? "agent_select" : "agent_task";
      const next: SessionInitState = {
        ...state,
        status: nextStatus,
        selectedTeamId: teamId,
        attemptCount: 0,
      };
      await store.set(compositeKey, next);
      console.log(`[session-init:cb] session=${compositeKey} team=${teamId} → ${nextStatus}`);
      const fd: FormData = {
        teams: state.cachedTeams ?? [],
        stage: nextStage,
        selectedTeamId: teamId,
        stream: reqCtx.stream,
        questionsAsArray: reqCtx.questionsAsArray,
        modelId: reqCtx.modelId,
        protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd), formData: fd };
    }

    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} team-select max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: state.cachedTeams ?? [],
      stage: "team",
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 2a (codex-only): Awaiting agent selection ────────────────────────
  //
  // codex-client-exclusive branch. After the user picks an agent in the agent_select stage → advance to the task_select
  // stage (if the team has only 1 task, auto-select completes directly).
  // CB clients never enter this branch.
  if (state.status === "pending_agent_select") {
    const cachedTeams = state.cachedTeams ?? [];
    const selectedTeamId = state.selectedTeamId;
    const team = cachedTeams.find((t) => t.team_id === selectedTeamId);
    if (!team) {
      console.warn(
        `[session-init:cb] session=${compositeKey} pending_agent_select but team=${selectedTeamId} not in cache → bypass`,
      );
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    const lastUserText = getLastUserMessageText(messages);

    // ── WorkBuddy-only: MORE pagination interception ──
    // WorkBuddy reuses the CB state machine + workbuddy/form.ts's paginated form (MORE_LABEL="More →").
    // extractAgentOnly doesn't recognize MORE, so it must be intercepted before it runs, otherwise clicking
    // "More →" would be treated as unrecognized → infinitely resending page 1. On a hit, bump agentPage and
    // resend the agent_select form (the page number is pulled from codexPageIndex.agentPage by the workbuddy/
    // opencode re-render branch in session/index.ts according to the stage). opencode shares the `More →`
    // MORE_LABEL and pagination semantics with workbuddy, so it is intercepted here too.
    if (agentSource === "workbuddy" || agentSource === "opencode") {
      const curAgentPage = state.codexPageIndex?.agentPage ?? 0;
      const nextAgentPage = detectWorkbuddyMorePage(lastUserText, curAgentPage, team.agents.length);
      if (nextAgentPage !== null) {
        const nextPx = {
          teamPage: state.codexPageIndex?.teamPage ?? 0,
          agentPage: nextAgentPage,
          taskPage: state.codexPageIndex?.taskPage ?? 0,
        };
        await store.set(compositeKey, { ...state, codexPageIndex: nextPx });
        console.log(
          `[session-init:cb] session=${compositeKey} WB agent MORE page ${curAgentPage} → ${nextAgentPage}`,
        );
        const fd: FormData = withCodexPageIndex({
          teams: cachedTeams,
          stage: "agent_select",
          selectedTeamId,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        }, nextPx);
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
    }

    const picked = extractAgentOnly(lastUserText, cachedTeams, selectedTeamId);

    if (picked === BYPASS_MARKER) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams,
        selectedTeamId,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} agent_select bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (picked) {
      const resolvedAgentId = resolveAgent(picked, cachedTeams, selectedTeamId);
      // 0 tasks → bypass; 1 task → auto-select and complete directly.
      if (team.tasks.length === 0) {
        console.log(
          `[session-init:cb] session=${compositeKey} agent=${resolvedAgentId} team has 0 tasks → bypass`,
        );
        await store.set(compositeKey, {
          status: "initialized",
          keyId: sessionKey,
          startedAt: state.startedAt,
          attemptCount: 0,
          userId: state.userId,
          cachedTeams,
          selectedTeamId,
          selectedAgentId: resolvedAgentId,
          sessionInfo: null,
          agentDetail: null,
          taskDetail: null,
          bypassed: true,
        } as SessionInitState);
        return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
      }
      if (team.tasks.length === 1) {
        const soleTaskId = team.tasks[0].task_id;
        console.log(
          `[session-init:cb] session=${compositeKey} agent=${resolvedAgentId} auto-select single task=${soleTaskId}`,
        );
        return await completeRegistration(
          { agent_id: resolvedAgentId, task_id: soleTaskId },
          state, cachedTeams, compositeKey, sessionKey, userId,
          config, store, messages, metadataClient, userKey, spaceId,
        );
      }
      // ≥2 tasks → enter the task_select stage and emit the next form.
      const nextState: SessionInitState = {
        ...state,
        status: "pending_task_select",
        selectedAgentId: resolvedAgentId,
        attemptCount: 0,
        // Clear the task page number when entering a new stage, so flipping restarts from page 1. agentPage is
        // spent; keeping or clearing it both work — clearing is cleaner, so reset everything to 0.
        codexPageIndex: { teamPage: state.codexPageIndex?.teamPage ?? 0, agentPage: 0, taskPage: 0 },
      };
      await store.set(compositeKey, nextState);
      console.log(
        `[session-init:cb] session=${compositeKey} agent=${resolvedAgentId} → pending_task_select (tasks=${team.tasks.length})`,
      );
      const fd: FormData = {
        teams: cachedTeams,
        stage: "task_select",
        selectedTeamId,
        selectedAgentId: resolvedAgentId,
        stream: reqCtx.stream,
        questionsAsArray: reqCtx.questionsAsArray,
        modelId: reqCtx.modelId,
        protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd), formData: fd };
    }

    // Extraction failed → retry / bypass.
    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} agent_select max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: cachedTeams,
      stage: "agent_select",
      selectedTeamId,
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 2b (codex-only): Awaiting task selection ────────────────────────
  if (state.status === "pending_task_select") {
    const cachedTeams = state.cachedTeams ?? [];
    const selectedTeamId = state.selectedTeamId;
    const selectedAgentId = state.selectedAgentId;
    const team = cachedTeams.find((t) => t.team_id === selectedTeamId);
    if (!team || !selectedAgentId) {
      console.warn(
        `[session-init:cb] session=${compositeKey} pending_task_select missing team/agent (team=${selectedTeamId} agent=${selectedAgentId}) → bypass`,
      );
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    const lastUserText = getLastUserMessageText(messages);

    // ── WorkBuddy-only: MORE pagination interception ──
    // Same as pending_agent_select: extractTaskOnly doesn't recognize "More →", so it must be intercepted
    // first. On a hit, bump taskPage and resend the task_select form (the page number is pulled from
    // codexPageIndex.taskPage by session/index.ts's workbuddy/opencode re-render branch according to stage).
    if (agentSource === "workbuddy" || agentSource === "opencode") {
      const curTaskPage = state.codexPageIndex?.taskPage ?? 0;
      const nextTaskPage = detectWorkbuddyMorePage(lastUserText, curTaskPage, team.tasks.length);
      if (nextTaskPage !== null) {
        const nextPx = {
          teamPage: state.codexPageIndex?.teamPage ?? 0,
          agentPage: state.codexPageIndex?.agentPage ?? 0,
          taskPage: nextTaskPage,
        };
        await store.set(compositeKey, { ...state, codexPageIndex: nextPx });
        console.log(
          `[session-init:cb] session=${compositeKey} WB task MORE page ${curTaskPage} → ${nextTaskPage}`,
        );
        const fd: FormData = withCodexPageIndex({
          teams: cachedTeams,
          stage: "task_select",
          selectedTeamId,
          selectedAgentId,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        }, nextPx);
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
    }

    const picked = extractTaskOnly(lastUserText, cachedTeams, selectedTeamId);

    if (picked === BYPASS_MARKER) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams,
        selectedTeamId,
        selectedAgentId,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} task_select bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (typeof picked === "string") {
      // Matched a task_id (including the defaultTaskId virtual entry) → complete.
      return await completeRegistration(
        { agent_id: selectedAgentId, task_id: picked },
        state, cachedTeams, compositeKey, sessionKey, userId,
        config, store, messages, metadataClient, userKey, spaceId,
      );
    }

    // Unrecognized → retry / bypass.
    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} task_select max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: cachedTeams,
      stage: "task_select",
      selectedTeamId,
      selectedAgentId,
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 2: Awaiting agent + task selection ───────────────────────────────
  if (state.status === "pending_agent_task" || state.status === "pending_form") {
    const lastUserText = getLastUserMessageText(messages);
    const cachedTeams = state.cachedTeams ?? [];
    const selectedTeamId = state.selectedTeamId;

    // LLM-based extraction fallback was removed — engineered paths only.
    // If neither the option-text match nor the structured parser recognises
    // the reply, the caller falls through to the retry / bypass branch.
    let extracted = extractFromOptionText(lastUserText, cachedTeams, selectedTeamId)
      ?? extractStructured(lastUserText);

    if (extracted && extracted.agent_id === BYPASS_MARKER) {
      console.warn(`[session-init:cb] session=${compositeKey} unexpected bypass in agent_task, treating as extraction failure`);
      extracted = null;
    }

    if (extracted) {
      const resolvedAgentId = resolveAgent(extracted.agent_id, cachedTeams, selectedTeamId);
      const resolvedTaskId = resolveTask(
        extracted.task_id,
        cachedTeams,
        resolvedAgentId,
        selectedTeamId,
      );
      const resolved: SessionInitData = {
        agent_id: resolvedAgentId,
        task_id: resolvedTaskId,
      };

      return await completeRegistration(
        resolved, state, cachedTeams, compositeKey, sessionKey, userId,
        config, store, messages, metadataClient, userKey, spaceId,
      );
    }

    // Extraction failed → retry / reset
    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: state.cachedTeams ?? [],
      stage: "agent_task",
      selectedTeamId: state.selectedTeamId,
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 3: Initialized ───────────────────────────────────────────────────
  const bypassed = (state as any).bypassed === true;
  const agent = bypassed ? null : (state.agentDetail ?? null);
  const task = bypassed ? null : (state.taskDetail ?? null);
  const out = applyArtifactsAndContext(messages, agent, task, sessionKey, config);
  return { intercepted: false, messages: out, sessionInfo: state.sessionInfo, bypassed };
}