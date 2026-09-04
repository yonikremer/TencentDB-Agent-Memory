/**
 * Session Initialization Module — Public API.
 *
 * Post-split architecture:
 *   - codebuddy/    → CodeBuddy-specific session-init (ask_followup_question form, XML extractor)
 *   - claude-code/  → Claude Code-specific session-init (AskUserQuestion form, JSON extractor, pagination)
 *   - Shared modules: store.ts, types.ts, context-injector.ts, registrar.ts
 *
 * All kernel API calls go through src/meta/client.ts (MetadataClient).
 */

// ── Shared modules ────────────────────────────────────────────────────────────

export { SessionStore, getSessionStore } from "./store.js";
export type {
  SessionInitStatus,
  SessionInitState,
  SessionInitData,
  SessionRegistrationData,
  SessionInfo,
  AgentDetail,
  TaskDetail,
  TeamOption,
  AgentInTeam,
  TaskInTeam,
  TaskOption as TaskOpt,
  AgentOption as AgentOpt,
} from "./types.js";

export { buildSessionInfo } from "./registrar.js";
export { injectSessionContext, SESSION_CONTEXT_OPEN, SESSION_CONTEXT_CLOSE } from "./context-injector.js";
export { parsePresetIdentity, resolvePresetIdentity } from "./preset.js";
export type { PresetIdentity, PresetResolution } from "./preset.js";

// ── CodeBuddy-specific modules ────────────────────────────────────────────────

export {
  handleSessionInit as handleCodeBuddySessionInit,
  buildFormResponse as buildCodeBuddyFormResponse,
  containsFormTitle as containsCodeBuddyFormTitle,
  extractFromOptionText as extractCodeBuddyFromOptionText,
  extractStructured as extractCodeBuddyStructured,
  resolveAgent as resolveCodeBuddyAgent,
  resolveTask as resolveCodeBuddyTask,
  BYPASS_MARKER as CB_BYPASS_MARKER,
  getLastUserMessageText as getCodeBuddyLastUserMessage,
} from "./codebuddy/index.js";

// ── Claude Code-specific modules ──────────────────────────────────────────────

export {
  handleSessionInit as handleClaudeCodeSessionInit,
  buildFormResponse as buildClaudeCodeFormResponse,
  containsFormTitle as containsClaudeCodeFormTitle,
  extractFromOptionText as extractClaudeCodeFromOptionText,
  extractStructured as extractClaudeCodeStructured,
  resolveAgent as resolveClaudeCodeAgent,
  resolveTask as resolveClaudeCodeTask,
  BYPASS_MARKER as CC_BYPASS_MARKER,
  MORE_MARKER,
  getLastUserMessageText as getClaudeCodeLastUserMessage,
} from "./claude-code/index.js";

// ── Legacy compatibility API (backward compatible with old handler.ts callers) ─

import type { SessionInitConfig } from "../types.js";
import { SessionStore } from "./store.js";
import {
  handleSessionInit as cbHandle,
  SessionRequestContext as CBSessionRequestContext,
  SessionInitResult as CBSessionInitResult,
} from "./codebuddy/init.js";
import {
  handleSessionInit as ccHandle,
  SessionRequestContext as CCSessionRequestContext,
  SessionInitResult as CCSessionInitResult,
} from "./claude-code/init.js";
import {
  buildFormResponse as buildWorkBuddyFormResponse,
  FormData as WBFormData,
  FormStage as WBFormStage,
} from "./workbuddy/form.js";
import {
  buildFormResponse as buildDshFormResponse,
  FormData as DshFormData,
  FormStage as DshFormStage,
} from "./dsh/form.js";
import {
  buildFormResponse as buildOpencodeFormResponse,
  FormData as OCFormData,
  FormStage as OCFormStage,
} from "./opencode/form.js";

// Re-export the types under their old names for backward compat
export type SessionRequestContext = CBSessionRequestContext & Partial<CCSessionRequestContext>;
export type SessionInitResult = CBSessionInitResult;

/**
 * @deprecated Use handleCodeBuddySessionInit() or handleClaudeCodeSessionInit().
 * This function routes to the corresponding implementation based on the agentSource parameter.
 */
import type { MetadataClient } from "../meta/client.js";
import type { PresetIdentity } from "./preset.js";

export async function handleSessionInit(
  sessionKey: string,
  userId: string | null,
  messages: Record<string, unknown>[],
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  agentSource: string = "codebuddy",
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
  presetIdentity?: PresetIdentity,
): Promise<SessionInitResult> {
  if (agentSource === "claude-code") {
    return ccHandle(
      sessionKey, userId, messages, config, store,
      // Forward the entire reqCtx directly so new fields (e.g. codex's
      // codexAnswerInput) aren't dropped when picking fields by hand. protocol MUST be forwarded — without it,
      // applyArtifactsAndContext takes the openai path (injects
      // <session_context> into messages as a role=system message) instead of
      // the anthropic path (returns systemAppend that anthropicHandler merges
      // into body.system). The openai path currently only works because
      // AnthropicAdapter.serialize() hoists role=system back onto body.system
      // as a safety net; forwarding the correct protocol keeps intent and
      // implementation aligned and survives `injection.enabled=false`.
      reqCtx,
      metadataClient,
      userKey,
      spaceId,
      presetIdentity,
    );
  }
  // Same as above: the entire reqCtx is forwarded to the CB state machine.
  // codexHandler stores body.input[] in reqCtx.codexAnswerInput for the
  // codex-only pre-check sections inside the CB state machine
  // (detectCodexDefaultGate + detectCodexMore in session/codebuddy/init.ts) to
  // recognize the Default gate and MORE pagination. Picking fields by hand would
  // drop it → codex pagination breaks.
  const result = await cbHandle(
    sessionKey, userId, messages, config, store,
    reqCtx,
    metadataClient,
    userKey,
    spaceId,
    presetIdentity,
    agentSource,
  );

  // The WorkBuddy client reuses the CB state machine (the full
  // uninitialized → pending_team → pending_agent_task → initialized flow), but
  // form rendering needs CC's `AskUserQuestion` shape + OpenAI
  // chat/completions SSE tool_calls transport (the WB client is a hybrid of CC
  // tool semantics + OpenAI protocol, confirmed by packet capture
  // [wb-ask-user-schema]).
  //
  // Following the codex pattern (`session/codex/form.ts::buildFormResponse`),
  // we **re-render at the outer layer** here after the CB state machine
  // produces formData: discard result.response (the CB ask_followup_question
  // SSE) and generate the AskUserQuestion SSE via workbuddy/form.ts instead.
  // Benefit: the CB state machine code is untouched — no need to dispatch to
  // each of the 10 intercepted sites.
  if (agentSource === "workbuddy" && result.intercepted && result.formData) {
    const cbFd = result.formData;
    const wbFd: WBFormData = {
      teams: cbFd.teams,
      // The CB state machine's stage values (asset_confirm | team | agent_select
      // | task_select | agent_task) match the WB form's FormStage exactly; pass
      // them through directly.
      stage: cbFd.stage as WBFormStage,
      selectedTeamId: cbFd.selectedTeamId,
      selectedAgentId: cbFd.selectedAgentId,
      // CB carries the pagination fields teamPage / agentPage / taskPage (for
      // the codex passthrough), while the WB form uses a single pageIndex —
      // pick the page for the current stage.
      pageIndex:
        cbFd.stage === "team" ? cbFd.teamPage
        : cbFd.stage === "agent_select" ? cbFd.agentPage
        : cbFd.stage === "task_select" ? cbFd.taskPage
        : 0,
      retry: cbFd.retry,
      stream: reqCtx.stream,
      modelId: reqCtx.modelId,
    };
    result.response = buildWorkBuddyFormResponse(wbFd);
  }

  // The dsh (deepseek-harness) client reuses the CB state machine + its own
  // ask_user_question carrier. Fully symmetric with workbuddy: after the CB
  // state machine produces formData, re-render the response at the outer layer
  // instead of sharing CB's ask_followup_question (the dsh preset attaches the
  // native dsh ask_user_question, confirmed by capture
  // fixtures/dsh-tool-catalog-schema.json). The stage values match exactly and
  // pass through directly; the dsh form uses a CC-shape single pageIndex,
  // picking the pagination field like workbuddy does.
  if (agentSource === "dsh" && result.intercepted && result.formData) {
    const cbFd = result.formData;
    const dshFd: DshFormData = {
      teams: cbFd.teams,
      stage: cbFd.stage as DshFormStage,
      selectedTeamId: cbFd.selectedTeamId,
      selectedAgentId: cbFd.selectedAgentId,
      pageIndex:
        cbFd.stage === "team" ? cbFd.teamPage
        : cbFd.stage === "agent_select" ? cbFd.agentPage
        : cbFd.stage === "task_select" ? cbFd.taskPage
        : 0,
      retry: cbFd.retry,
      stream: reqCtx.stream,
      modelId: reqCtx.modelId,
    };
    result.response = buildDshFormResponse(dshFd);
  }

  // The opencode client (sst/opencode CLI, Bun-bundled binary) maintains a hard
  // whitelist of tools in its agent-loop: `bash, edit, glob, grep, invalid,
  // question, read, skill, task, todowrite, webfetch, write`. Any tool_call not
  // in the whitelist is rejected by the client and rendered as `invalid
  // [tool=xxx, error=Model tried to call unavailable tool]` (captured
  // 2026-08-19: CB's `ask_followup_question` is rejected 3 times, then the CB
  // state machine abandons → falls back to bypass).
  //
  // Fix: fully symmetric with workbuddy / dsh — after the CB state machine
  // produces formData, **re-render at the outer layer** and emit the opencode
  // native `question` tool_call SSE instead. The stage values pass through
  // directly, and the pagination field is chosen by the current stage.
  //
  // See the header comment of session/opencode/form.ts (schema basis / the three
  // shape differences).
  if (agentSource === "opencode" && result.intercepted && result.formData) {
    const cbFd = result.formData;
    const ocFd: OCFormData = {
      teams: cbFd.teams,
      stage: cbFd.stage as OCFormStage,
      selectedTeamId: cbFd.selectedTeamId,
      selectedAgentId: cbFd.selectedAgentId,
      pageIndex:
        cbFd.stage === "team" ? cbFd.teamPage
        : cbFd.stage === "agent_select" ? cbFd.agentPage
        : cbFd.stage === "task_select" ? cbFd.taskPage
        : 0,
      retry: cbFd.retry,
      stream: reqCtx.stream,
      modelId: reqCtx.modelId,
    };
    result.response = buildOpencodeFormResponse(ocFd);
  }

  return result;
}
