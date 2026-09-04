/**
 * Codex Responses API handler.
 *
 * Handles `POST /v1/responses` + 3 aux endpoints (`/responses/compact`,
 * `/memories/trace_summarize`, `/realtime/calls`) for the Codex CLI client.
 *
 * Protocol: OpenAI Responses API — third independent path alongside
 * anthropicHandler (Anthropic Messages) and handler (OpenAI Chat Completions).
 *
 * Internal dispatch:
 *   /v1/responses               → main loop (session-init + injection + forward)
 *   /v1/responses/compact       → aux passthrough (no injection, credit only)
 *   /v1/memories/trace_summarize → aux passthrough
 *   /v1/realtime/calls          → aux passthrough
 *   other codex paths           → 404
 *
 * Session-init flow:
 *   1. Extract session_id from header/body
 *   2. Check sessionStore for binding
 *   3. If unbound → call handleSessionInit (reuses CB state machine with
 *      agentSource="codex", protocol="responses") → return request_user_input form
 *   4. Detect Default mode gate → permanent bypass
 *   5. If bound → inject assets via buildCodexInjectionBlock → forward
 *
 * See docs/2026-08-07-codex-integration-plan.md.
 */

import type { Context } from "hono";
import type { ProxyConfig } from "./types.js";
import { apiKeyToKeyId, extractBearerToken, uuidv7 } from "./opik.js";
import { createPipeline, writeLog } from "./logger.js";
import { extractSpaceIdFromPath } from "./credit-reporter.js";
import { joinUrl } from "./guard-adapter.js";
import { verifyUserKey } from "./auth.js";
import { resolveModelId } from "./pricing.js";
import { codexAdapter } from "./agent-adapters/codex.js";
import {
  DEFAULT_GATE_PREFIX,
  buildFormResponse as buildCodexFormResponse,
  codexFormAnswersAsMessages,
} from "./session/codex/form.js";
import { buildCodexInjectionBlock, type CodexInjectionInput } from "./common/codex-injection.js";
import { log } from "./report/log.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "./langfuse.js";
import { TdaiClient } from "./tdai/client.js";
import { deriveTdaiIdentity } from "./tdai/identity.js";
import { recordTdaiTurn } from "./tdai/recorder.js";
import { trackWrite, withL0Retry } from "./tdai/pending-writes.js";
import type { TdaiIdentity, TdaiMessage } from "./tdai/types.js";
import { triggerSkillExtractIfReady } from "./skill/handler-glue.js";
import { isExtractionAllowed, logExtractionSkipped } from "./extraction-gate.js";

// ── Constants ────────────────────────────────────────────────────────────────

const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "x-tdai-user-key",
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);

// ── TDAI L0 helpers (aligned with anthropicHandler / handler pattern) ────────

/**
 * TDAI L0 client factory — semantic equivalent of anthropicHandler.ts::createTdaiClient.
 * spaceId takes precedence over config default serviceId to report multi-tenant codex
 * requests to the correct kernel instance. Returns null when config.tdai.memory.enabled=false.
 */
function createCodexTdaiClient(config: ProxyConfig, spaceId?: string): TdaiClient | null {
  if (!config.tdai.enabled || !config.tdai.memory.enabled || !config.tdai.endpoint) return null;
  return new TdaiClient({
    enabled: config.tdai.enabled && config.tdai.memory.enabled,
    endpoint: config.tdai.endpoint,
    apiKey: config.tdai.apiKey,
    serviceId: spaceId || config.tdai.serviceId,
    writeL0: config.tdai.memory.writeL0,
    recallL1: config.tdai.memory.recallL1,
    injectL2L3: config.tdai.memory.injectL2L3,
    l1Limit: config.tdai.memory.l1Limit,
    l2Limit: config.tdai.memory.l2Limit,
    timeoutMs: config.tdai.memory.timeoutMs,
  });
}

/**
 * Extracts the latest role=user message text from codex `input[]` and builds a TdaiMessage.
 * Equivalent to the codex variant of tdai/recorder.ts::extractLatestUserMessage — key differences are
 * traversal condition (type==="message" && role==="user") and text extraction (content[].input_text).
 * Reuses codexAdapter.extractUserText to ensure consistency with langfuse traceInput in codexHandler
 * (docs/2026-08-07-codex-integration-plan.md §9).
 */
function extractLatestCodexUserMessage(input: unknown): TdaiMessage | null {
  if (!Array.isArray(input)) return null;
  const text = codexAdapter.extractUserText(input) ?? "";
  const trimmed = text.trim();
  if (!trimmed) return null;
  return { role: "user", content: trimmed };
}

// ── Codex session state (exported for unit tests) ────────────────────────────

export interface CodexSessionState {
  status: "initialized" | "pending";
  bypassed?: boolean;
  sessionInfo?: Record<string, unknown> | null;
}

// ── Aux detection (exported for unit tests) ──────────────────────────────────

/** Aux endpoint path suffixes — hardcoded in codex-rs/core/src/client.rs. */
const CODEX_AUX_PATH_SUFFIXES = new Set([
  "/responses/compact",
  "/memories/trace_summarize",
  "/realtime/calls",
]);

/** Known aux thread_source values. */
const CODEX_AUX_THREAD_SOURCES = new Set([
  "memory_consolidation",
  "system",
]);

/**
 * Classify a codex request as main or auxiliary.
 * Exported for unit tests.
 */
export function classifyCodexRequest(
  body: Record<string, unknown>,
  path: string,
  headers: Record<string, string>,
): "main" | "auxiliary" {
  // Signal 1: aux endpoint path suffix
  for (const suffix of CODEX_AUX_PATH_SUFFIXES) {
    if (path.endsWith(suffix)) return "auxiliary";
  }

  // Signal 2: x-openai-memgen-request header
  if (headers["x-openai-memgen-request"] === "true") return "auxiliary";

  // Signal 3: body.client_metadata.thread_source whitelist
  const meta = body.client_metadata as { thread_source?: string } | undefined;
  const ts = meta?.thread_source;
  if (typeof ts === "string" && CODEX_AUX_THREAD_SOURCES.has(ts)) return "auxiliary";

  return "main";
}

// ── Session ID extraction (exported for unit tests) ──────────────────────────

/**
 * Extract session_id from codex request.
 * Primary: `session-id` header. Fallback: `body.client_metadata.session_id`.
 */
export function extractCodexSessionId(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): string | null {
  if (headers["session-id"]) return headers["session-id"];
  const meta = body.client_metadata as { session_id?: string } | undefined;
  if (typeof meta?.session_id === "string") return meta.session_id;
  return null;
}

// ── Default mode gate detection (exported for unit tests) ────────────────────

/**
 * Scan codex input[] for the Default mode gate string in function_call_output.
 *
 * When the client is in Default mode, it intercepts `request_user_input` tool
 * calls and fabricates a `function_call_output.output` starting with
 * "request_user_input is unavailable in".
 *
 * Legacy utility function; interception logic is now internalized inside CB state machine
 * (codex-only pre-checks section of session/codebuddy/init.ts). Export retained because
 * codex-handler.test.ts has unit tests directly invoking it to verify structural recognition.
 */
export function detectDefaultModeGate(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  // Only match when "last item of input is gate output": see comment with same name in codebuddy/init.ts.
  const last = input[input.length - 1] as Record<string, unknown> | null | undefined;
  if (!last || typeof last !== "object") return false;
  if (last.type !== "function_call_output") return false;
  const output = last.output;
  return typeof output === "string" && output.startsWith(DEFAULT_GATE_PREFIX);
}

// ── Asset injection (exported for unit tests) ────────────────────────────────

/**
 * Inject `<tdai_injections>` wrapper into codex body.input[0].content[].
 *
 * Appends the injection block to the developer message (input[0]) content.
 * Defensive: if input[0] is not a message with an array content, returns
 * the body unchanged.
 *
 * Returns a shallow copy — original body is not mutated.
 */
export function injectCodexAssets(
  body: Record<string, unknown>,
  assets: CodexInjectionInput,
): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input) || input.length === 0) return body;

  const devMsg = input[0] as Record<string, unknown> | null;
  if (!devMsg || typeof devMsg !== "object") return body;
  if (devMsg.type !== "message") return body;

  const content = devMsg.content;
  if (!Array.isArray(content)) return body;

  const injectionBlock = buildCodexInjectionBlock(assets);

  // Shallow-copy chain: body → input → input[0] → content
  const newContent = [...content, injectionBlock];
  const newDevMsg = { ...devMsg, content: newContent };
  const newInput = [newDevMsg, ...input.slice(1)];
  return { ...body, input: newInput };
}

// ── Upstream request helpers ─────────────────────────────────────────────────

function buildUpstreamHeaders(
  c: Context,
  config: ProxyConfig,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  // Codex uses OpenAI protocol: inject Bearer token
  if (config.upstream.apiKey) {
    headers["authorization"] = `Bearer ${config.upstream.apiKey}`;
    delete headers["x-api-key"];
  }
  return headers;
}

function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  return out;
}

// ── Main handler ─────────────────────────────────────────────────────────────

/**
 * Codex endpoint handler.
 *
 * Routes internally:
 *   - aux endpoints → lightweight passthrough
 *   - main /v1/responses → full pipeline (session-init, injection, mem-command, forward)
 */
export async function handleCodexEndpoint(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();
  const path = c.req.path;

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const apiKey =
    extractBearerToken(c.req.header("authorization") ?? c.req.header("Authorization") ?? "") ??
    c.req.header("x-api-key") ??
    "";

  const spaceId = extractSpaceIdFromPath(path) ?? "";
  const { userId, rejected: userKeyRejected, rejectReason } =
    await verifyUserKey(apiKey, spaceId);
  if (userKeyRejected) {
    return c.json(
      { error: `Authentication failed: ${rejectReason ?? "unknown"}` },
      401,
    );
  }

  const keyId = userId || (apiKey ? apiKeyToKeyId(apiKey) : "unknown");

  // ── 2. Read body ───────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // ── 3. Extract headers as plain object ─────────────────────────────────────
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    headers[k.toLowerCase()] = v;
  }

  // ── DEBUG: dump request_user_input tool schema once so we can see codex's
  //           expected arguments shape and fix our fake form. Remove after fix.
  try {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const rui = tools.find(
      (t: any) => t?.type === "function" && t?.name === "request_user_input" ||
                  t?.function?.name === "request_user_input" ||
                  t?.name === "request_user_input",
    );
    if (rui) {
      console.log("[codex-debug] request_user_input tool schema:", JSON.stringify(rui));
    }
  } catch {}

  // ── 4. Classify request ────────────────────────────────────────────────────
  const requestKind = classifyCodexRequest(body, path, headers);
  const isAuxiliary = requestKind === "auxiliary";
  // Invocation signature is resolveModelId(creditPricingConfig, requestedModel) — previously
  // mistakenly passed body as first param (missing config), causing return value to be whole body object.
  // This bug existed since codex P1 onboarding initial frames, but was unobserved until langfuse integration.
  // Aligned with invocation pattern in handler.ts:482 / anthropicHandler.ts.
  const requestedModel = typeof body.model === "string" ? body.model : "";
  const modelId = resolveModelId(config.creditPricing, requestedModel);

  const pipe = createPipeline(config, traceId, modelId);

  // ── 5. Aux passthrough ─────────────────────────────────────────────────────
  if (isAuxiliary) {
    pipe.info("CODEX_AUX", `auxiliary request → passthrough (path=${path})`);
    // aux does not report to langfuse (aligned with CC/CB — sidequery/fork aux are not main dialog turns)
    return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, null);
  }

  // ── 6. Session ID extraction ───────────────────────────────────────────────
  const sessionId = extractCodexSessionId(headers, body);
  const sessionKey = sessionId ?? `${keyId}:${traceId}`;
  const agentSource = "codex";
  const isStream = body.stream !== false;

  const callerUserKey = apiKey || null;

  // ── 6b. Langfuse turn context (one trace = one turn) ────────────────────────
  // Turn sequence for codex derived from number of "human inputs" in body.input[] (same convention as CC/CB;
  // tool loop requests within same turn compute identical turnSeq → same trace). User queries
  // use codex adapter extractUserText — codex uses input[] instead of messages[];
  // generic resolveLatestUserQuery relies on costGuard profile for messages[] which is unsuitable here.
  const turnSeq = countHumanTurnsCodex(body.input);
  const userQuery = codexAdapter.extractUserText(body.input) ?? "";
  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(sessionKey, turnSeq),
    turnSeq,
    traceName: `${modelId} / ${keyId}`,
    userId: keyId,
    sessionId: sessionKey,
    // agent_source tag indicates client family; protocol:responses distinguishes codex wire format.
    tags: [
      `agent_source:${agentSource}`,
      "protocol:responses",
      isStream ? "stream" : "non-stream",
      `session:${sessionKey}`,
    ],
    routeTags: [],
    userQuery,
  };

  // ── 7. Session-init state machine ──────────────────────────────────────────
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("./injection/types.js").AssetCapabilityFlags | undefined;
  let injectionSkipped = false;
  let sessionJustRegistered = false;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;
  // Store initResult agent/task detail for § 9 injection phase to construct <session_context>.
  // handleSessionInit originally inserts session_context via messages[0], but that messages
  // array was a temporary synthesizedMessages array passed in, which doesn't return to codex body.
  // Explicitly capture detail here so synthetic body below uses buildSessionContextBlockWithToggles
  // to build the same block and prefill in front of synthetic system message.
  let cachedAgentDetail: unknown = null;
  let cachedTaskDetail: unknown = null;

  const input = Array.isArray(body.input) ? body.input : [];

  // ── mem:session-reset pre-hook ──
  if (config.memCommand?.enabled) {
    const { isSessionResetCommand } = await import("./mem-command/pre-intercept.js");
    if (isSessionResetCommand(body as Record<string, unknown>, agentSource)) {
      const { parseCommandFromText, isMemCommandAllowed } = await import("./mem-command/index.js");
      const { codexAdapter } = await import("./agent-adapters/codex.js");
      const userText = codexAdapter.extractUserText(input) ?? "";
      const memCmd = parseCommandFromText(userText);
      if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
        const { getSessionStore } = await import("./session/store.js");
        const store = getSessionStore();
        const compositeKey = `${agentSource}:${sessionKey}`;
        store.bind(compositeKey, { userId: userId || "anonymous", agentSource, sessionId: sessionKey, spaceId });

        // ── Force archive old agent skill buffer (best-effort) ──
        const oldState = store.get(compositeKey);
        if (oldState?.status === "initialized" && oldState.sessionInfo && config.coreSkill?.endpoint) {
          const si = oldState.sessionInfo as Record<string, string>;
          if (si.space_id && si.user_id && si.team_id && si.agent_id) {
            import("./skill/core-client.js").then(({ getCoreSkillClient }) => {
              const client = getCoreSkillClient(config.coreSkill!);
              client.forceArchive(
                {
                  space_id: si.space_id,
                  user_id: si.user_id,
                  team_id: si.team_id,
                  agent_id: si.agent_id,
                  session_id: sessionKey,
                  task_id: si.task_id || undefined,
                  reason: "session-reset",
                },
                { serviceId: si.space_id },
              ).then((res) => {
                console.log(`[session-reset] force-archive old buffer: status=${res.status} session=${sessionKey} agent=${si.agent_id}`);
              }).catch((err) => {
                console.warn(`[session-reset] force-archive failed (best-effort): ${err instanceof Error ? err.message : String(err)}`);
              });
            }).catch(() => {});
          }
        }

        const resetEpoch = Date.now();
        await store.set(compositeKey, { status: "uninitialized", keyId: sessionKey, startedAt: resetEpoch, attemptCount: 0, userId: userId || "anonymous", resetEpoch, resetFlow: true });
        const bindingRepo = store.getBindingRepo();
        if (bindingRepo) await bindingRepo.deleteBinding(spaceId, sessionKey).catch(() => {});
        console.log(`[mem-command:pre] session-reset session=${sessionKey} → falling through to pop form`);
      }
    }
  }

  // ── 7. Session-init state machine (reuses CB with agentSource="codex") ────
  //
  // Legacy version 7a (independent Default gate interception) + 7b.1 (independent MORE interception) consolidated into CB state machine
  // (codex-only pre-checks block at top of session/codebuddy/init.ts). codexHandler is only
  // responsible for passing body.input[] to reqCtx.codexAnswerInput for state machine to recognize gate/MORE.
  // First Default gate hit returns initResult.bypassReason === "default-gate", with Plan mode prompt returned
  // by this handler; subsequent requests for same session passthrough under bypass steady state.
  if (config.sessionInit?.enabled && sessionId) {
    try {
      const { getSessionStore, handleSessionInit, parsePresetIdentity } = await import("./session/index.js");
      const { getMetadataClient } = await import("./meta/client.js");
      const store = getSessionStore();
      const metadataClient = getMetadataClient(config.coreSkill, spaceId, apiKey);
      const presetIdentity = parsePresetIdentity(config.sessionInit, headers);

      const compositeKey = `${agentSource}:${sessionKey}`;
      const identity = {
        userId: userId || "anonymous",
        agentSource,
        sessionId: sessionKey,
        spaceId,
      };
      const recovered = await store.getOrRecover(compositeKey, identity, {
        metadataClient,
        // Codex doesn't use messages[] — pass empty for recovery.
        // History-scan fallback won't find form markers but will
        // produce a one-shot bypass for existing conversations.
        messages: [],
      });

      let initResult: Awaited<ReturnType<typeof handleSessionInit>>;
      const isTerminalState = recovered?.status === "initialized";
      // Recovery hit source determines whether prewarm is needed (see detailed notes at symmetric position in handler.ts).
      const needsPrewarm =
        recovered?.__recoverySource === "l2b" ||
        recovered?.__recoverySource === "history-scan";

      if (recovered && isTerminalState) {
        // Recovered from L2b/L2a — skip form, apply context
        const { buildSessionContextBlockWithToggles } = await import("./session/context-injector.js");
        const systemAppend = recovered.bypassed
          ? null
          : buildSessionContextBlockWithToggles(
              recovered.agentDetail ?? null,
              recovered.taskDetail ?? null,
              config.sessionInit,
              sessionKey,
            );
        initResult = {
          intercepted: false,
          messages: [],
          systemAppend,
          sessionInfo: recovered.sessionInfo,
          agentDetail: recovered.agentDetail,
          taskDetail: recovered.taskDetail,
          bypassed: recovered.bypassed,
          justRegistered: needsPrewarm,
        };
      } else {
        // Run the state machine — codex reuses CB's handleSessionInit
        // with agentSource="codex". CB parses answers from `messages[]`, but
        // codex clients send answers as `function_call_output.output` items in
        // `body.input[]`. We synthesize a minimal `messages[]` array from those
        // outputs so CB's extractors (which look at the last user/tool message
        // text) find the pick verbatim. See session/codex/form.ts::codexFormAnswersAsMessages.
        const synthesizedMessages = codexFormAnswersAsMessages(input);
        // DEBUG: dump function_call_output raw text so we can tell whether the
        // client shows the form to the user (real answer) vs auto-fills (model-
        // generated answer). Also dump the extracted answers.
        const rawOutputs = input
          .filter((it: any) => it?.type === "function_call_output")
          .map((it: any) => ({ call_id: it.call_id, output_preview: String(it.output ?? "").slice(0, 200) }));
        if (rawOutputs.length > 0) {
          console.log(`[codex-debug] session=${sessionKey} function_call_outputs=${JSON.stringify(rawOutputs)} synth_msgs=${JSON.stringify(synthesizedMessages).slice(0, 500)}`);
        }
        initResult = await handleSessionInit(
          sessionKey,
          userId || null,
          synthesizedMessages,
          config.sessionInit,
          store,
          {
            stream: isStream,
            modelId: modelId as string,
            protocol: "responses" as any,
            // Pass raw input[] to CB state machine to recognize codex client-specific
            // Default gate string and MORE pagination marker.
            codexAnswerInput: input,
          },
          agentSource,
          metadataClient,
          apiKey,
          spaceId,
          presetIdentity,
        );
      }

      if (initResult.intercepted) {
        // CB state machine intercepted → directly use formData already carrying pageIndex
        // re-rendered into Responses API SSE via codex builder. CB state machine internally
        // populates latest state.codexPageIndex into formData.{teamPage,agentPage,taskPage} for codex source.
        if (initResult.formData) {
          return buildCodexFormResponse({
            teams: initResult.formData.teams,
            stage: initResult.formData.stage,
            selectedTeamId: initResult.formData.selectedTeamId,
            selectedAgentId: initResult.formData.selectedAgentId,
            retry: initResult.formData.retry,
            teamPage: initResult.formData.teamPage ?? 0,
            agentPage: initResult.formData.agentPage ?? 0,
            taskPage: initResult.formData.taskPage ?? 0,
            // Override stream with the current request's stream flag — the CB
            // FormData carries the value from when the form was first built,
            // but codex clients pass a fresh stream setting each turn.
            stream: isStream,
            modelId: initResult.formData.modelId ?? (modelId as string),
          });
        }
        // Defensive fallback: no formData → intercept without a form response
        // (should be unreachable now that every CB intercepted return sets it).
        if (initResult.response) return initResult.response;
      }

      // ── Default gate first hit: CB state machine has already landed in bypass state; this
      //    handler returns one Plan-mode prompt; on the next request recovered.bypassed=true
      //    routes through the initialized branch and passes through directly — no repeat prompt.
      if ((initResult as any).bypassReason === "default-gate") {
        pipe.info("CODEX_GATE", "Default mode gate detected → notify user (first hit)");
        const { buildMemResponse } = await import("./mem-command/response-builder.js");
        // Reset-scenario gate: user explicitly sent mem:session-reset command, but the codex
        // client is not in Plan mode so no form can be shown → wording must clearly state
        // "reset command requires Plan mode" rather than a generic "assets feature disabled".
        const gateText = (initResult as any).resetFlow
          ? "⚠️ mem:session-reset requires Plan mode support.\n\n"
            + "The codex client is not currently in Plan mode, so the asset selection form cannot be shown.\n"
            + "Switch to Plan mode and run mem:session-reset again."
          : "Plan mode is not enabled, so team asset features will not be activated for this conversation (Skill / Task / Agent are not involved)."
            + "To use them, switch to Plan mode and start a new conversation.";
        return buildMemResponse(gateText, {
          protocol: "responses",
          stream: isStream,
          requestId: `codex-gate-${Date.now()}`,
        });
      }

      if (initResult.justRegistered) sessionJustRegistered = true;
      if (initResult.bypassed) {
        injectionSkipped = true;
        console.log(`[codex] session=${sessionKey} bypassed → skipping all injection`);
        if (initResult.resetFlow) {
          _resetFlowResult = { agentName: "", agentIdShort: "", teamId: "", bypassed: true };
        }
      }

      if (!initResult.bypassed && initResult.sessionInfo) {
        // Fetch asset capabilities for this session
        try {
          const { fetchAssetCapabilities } = await import("./tdai/capabilities.js");
          assetCapabilities = await fetchAssetCapabilities({
            endpoint: config.tdai.endpoint,
            apiKey: config.tdai.apiKey,
            serviceId: config.tdai.serviceId,
            serviceIdOverride: spaceId,
            userId: (initResult.sessionInfo as { user_id?: string }).user_id,
            userKey: callerUserKey,
            timeoutMs: config.tdai.memory.timeoutMs,
          });
        } catch (err) {
          console.warn(`[codex] asset-capability resolve failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Prewarm front short-circuit: turn matching mem-command doesn't forward or consume hook-cache;
      // normal prewarm would waste 2-3s + 3 network requests. See symmetric notes in handler.ts.
      let memCommandPending = false;
      if (config.memCommand?.enabled) {
        try {
          const userTextPeek = codexAdapter.extractUserText(input);
          if (userTextPeek) {
            const { parseCommandFromText, isMemCommandAllowed } = await import("./mem-command/index.js");
            const peek = parseCommandFromText(userTextPeek);
            if (peek && isMemCommandAllowed(config.memCommand, peek.command)) {
              memCommandPending = true;
              console.log(`[codex] prewarm skipped: mem-command pending (cmd=${peek.command}) session=${sessionKey}`);
            }
          }
        } catch (err) {
          console.warn(
            "[codex] pre-prewarm peek failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Prewarm injection pipeline cache (same as anthropicHandler)
      if (
        !initResult.bypassed &&
        initResult.justRegistered &&
        initResult.sessionInfo &&
        !memCommandPending &&
        config.injection?.enabled &&
        (config.injection.injectors?.length ?? 0) > 0
      ) {
        try {
          const mod = await import("./injection/index.js");
          await mod.prewarmFromConfig(config, {
            keyId: sessionKey,
            userId: userId || "anonymous",
            agentSource,
            spaceId,
            sessionInfo: initResult.sessionInfo as import("./session/types.js").SessionInfo,
            agentDetail: initResult.agentDetail ?? null,
            taskDetail: initResult.taskDetail ?? null,
            assetCapabilities,
            callerUserKey: callerUserKey ?? undefined,
          }, { clearBefore: true });
        } catch (err) {
          console.warn("[codex] prewarm error:", err instanceof Error ? err.message : String(err));
        }
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      if (sessionInfo && !sessionInfo.space_id && spaceId) {
        sessionInfo.space_id = spaceId;
      }
      // Cache detail for § 9 below (to construct <session_context> block) — written in both branches:
      // recovered branch initResult is manually constructed; walked-through branch comes from
      // handleSessionInit return, fields are agent/taskDetail from SessionInitResult.
      cachedAgentDetail = initResult.agentDetail ?? null;
      cachedTaskDetail = initResult.taskDetail ?? null;

      // Record resetFlow to outer scope for confirmation response return
      if (initResult.resetFlow && initResult.justRegistered && !initResult.bypassed) {
        _resetFlowResult = {
          agentName: initResult.agentDetail?.name ?? "Unknown",
          agentIdShort: (initResult.sessionInfo as Record<string, unknown>)?.agent_id
            ? String((initResult.sessionInfo as Record<string, unknown>).agent_id).slice(-8) : "",
          teamId: (initResult.sessionInfo as Record<string, unknown>)?.team_id
            ? String((initResult.sessionInfo as Record<string, unknown>).team_id).slice(-8) : "",
          taskName: initResult.taskDetail?.name,
        };
      }
    } catch (err: unknown) {
      console.error("[codex] session-init error:", err instanceof Error ? err.message : String(err));
      sessionInfo = undefined;
      injectionSkipped = true;
    }
  }

  // ── mem:session-reset completion confirmation ─────────────────────────────
  if (_resetFlowResult) {
    const { agentName, agentIdShort, teamId, taskName, bypassed } = _resetFlowResult;
    const lines = bypassed
      ? ["✅ Skipped team asset association", "", "Subsequent conversations will not inject team assets (Skill / Memory / Knowledge)."]
      : [
          "✅ Team assets rebound",
          "",
          `- **Agent**: ${agentName}${agentIdShort ? ` (${agentIdShort})` : ""}`,
          teamId ? `- **Team**: ${teamId}` : null,
          taskName ? `- **Task**: ${taskName}` : "- **Task**: Unassociated",
          "",
          "Subsequent conversations will use the new Agent's Skill, Memory, and Knowledge assets.",
        ].filter(Boolean);
    const text = (lines as string[]).join("\n");

    const { buildMemResponse } = await import("./mem-command/response-builder.js");
    console.log(`[mem-command:session-reset] completed: bypassed=${!!bypassed} agent=${agentName} (${agentIdShort})`);
    return buildMemResponse(text, {
      protocol: "responses",
      stream: isStream,
      requestId: `mem-reset-${Date.now()}`,
    });
  }

  // ── 8. mem-command intercept ────────────────────────────────────────────────
  // Position: after session-init, before injection (same as CC/CB).
  //
  // ⚠️ Do not use parseMemCommand(body, ...) — that function only parses body.messages[] (CC/CB
  // format), while codex body uses input[], returning null immediately → mem commands silently passthrough to
  // LLM, model hallucinates fake responses like "Memory synced".
  // Directly use extracted userText with parseCommandFromText.
  if (config.memCommand?.enabled) {
    const userText = codexAdapter.extractUserText(input);
    if (userText) {
      const { parseCommandFromText, isMemCommandAllowed, executeMemCommand, buildMemResponse, extractSimpleMessages, truncateArgs } =
        await import("./mem-command/index.js");
      let memCmd = parseCommandFromText(userText);
      // session-reset already handled by pre-hook, skip to prevent double execution
      if (memCmd?.command === "session-reset") memCmd = null;
      if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
        // Session not initialized → command not available
        if (!sessionInfo || injectionSkipped) {
          const errText = `⚠️ Session not initialized; command unavailable. Please complete session initialization (select Team/Agent) and try again.`;
          const errResponse = buildMemResponse(errText, {
            protocol: "responses",
            stream: isStream,
            requestId: `mem-cmd-${Date.now()}`,
          });
          console.log(`[codex] mem-command cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} blocked: session not initialized`);
          return errResponse;
        }
        pipe.info("CODEX_MEM_CMD", `mem command intercepted: ${memCmd.command}`);
        const memResult = await executeMemCommand(memCmd, {
          sessionKey,
          agentSource: "codex",
          config,
          spaceId,
          userId: userId || "",
          apiKey: apiKey || "",
          sessionInfo: sessionInfo as Record<string, unknown>,
          protocol: "responses",
          stream: isStream,
          args: memCmd.args,
          // Task command family uses recent conversation to generate draft. Responses API body.input[] structure:
          //   { type:"message", role, content:[{type:"input_text"|"output_text", text}] }
          // extractSimpleMessages includes built-in recognition for this format, converting it to minimal {role, content} format.
          bodyMessages: extractSimpleMessages(input),
        });

        // ── L0 write (synchronous await, aligned with CC/CB mem command path) ──
        //   mem command is the only persistence opportunity for this turn; cannot be fire-and-forget (trackWrite).
        //   Must explicitly await persistence before returning to avoid loss if process exits before flush.
        const tdaiClientForMem = createCodexTdaiClient(config, spaceId);
        const tdaiIdentityForMem = deriveTdaiIdentity({
          sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
          userId: userId || null,
          sessionKey,
          userKey: callerUserKey,
        });
        if (tdaiClientForMem && tdaiIdentityForMem && isExtractionAllowed(config, "tdai-memory")) {
          const userMsg = { role: "user" as const, content: memCmd.rawMessage };
          try {
            await recordTdaiTurn(tdaiClientForMem, tdaiIdentityForMem, userMsg, memResult.messageText);
          } catch (err: unknown) {
            console.error("[codex] mem-command L0 write error:", err);
          }
        }

        // ── Skill extract (synchronous await to ensure conversation turn count accumulates properly) ──
        if (isExtractionAllowed(config, "skill")) {
          try {
            const assistantMessage = {
              type: "message" as const,
              role: "assistant" as const,
              content: [{ type: "output_text" as const, text: memResult.messageText }],
            };
            await triggerSkillExtractIfReady({
              config,
              sessionKey,
              agentSource: "codex",
              sessionInfo: sessionInfo as Record<string, unknown>,
              inputMessages: input,
              assistantMessage,
              protocol: "responses",
              assetCapabilities,
            });
          } catch (err: unknown) {
            console.warn("[codex] mem-command skill extract trigger error:", err instanceof Error ? err.message : String(err));
          }
        }

        // ── Langfuse: report mem-command generation ──
        //   lf for codex handler constructed prior to mem command block (line 366); reuse directly.
        langfuseReportGeneration({
          traceId: lf.traceId,
          name: "memory-proxy",
          model: "memory-proxy",
          startTime,
          endTime: new Date().toISOString(),
          input: userText,
          output: memResult.messageText,
          usage: { input_tokens: 0, output_tokens: 0 },
          traceName: `memory-proxy / ${keyId}`,
          userId: lf.userId,
          sessionId: lf.sessionId,
          tags: [...lf.tags, "mem-command"],
          traceInput: userText,
          traceOutput: memResult.messageText,
        });

        console.log(`[codex] mem-command cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} success=${memResult.success}`);
        return memResult.response;
      }
    }
  }

  // ── 9. Asset injection (every turn, no caching) ────────────────────────────
  // Only inject when session is initialized and not bypassed.
  //
  // Strategy: run the existing injection pipeline on a synthetic OpenAI-shaped
  // body (with an empty system message). The pipeline appends text blocks to
  // the system message's content — we extract those appended blocks and
  // re-package them as `<tdai_injections>` for the codex body format.
  //
  // This reuses 100% of the existing pipeline infrastructure (hook cache,
  // prewarm, all injectors) without writing a third protocol adapter.
  if (!injectionSkipped && sessionInfo && config.injection?.enabled && (config.injection.injectors?.length ?? 0) > 0) {
    try {
      const { getInjectionPipeline } = await import("./injection/index.js");
      const pipeline = getInjectionPipeline(config);

      // ── session_context prefill ─────────────────────────────────────────────
      // handleSessionInit CB init puts <session_context> ([Agent]+[Task] description)
      // into its internally held messages[0] (temporary array we passed to it). This messages array
      // will not be returned to codex handler; meanwhile initResult.systemAppend is only filled in CC branch,
      // and is always undefined for CB branch. As a result, codex side only gets skill/memory/knowledge segments,
      // **agent/task descriptions were completely omitted from the final body**.
      //
      // Fix: directly use buildSessionContextBlockWithToggles with agentDetail/taskDetail saved on the handler side
      // to construct the same block and prefill into the synthetic body system message.
      // Below pipeline.process will continue to append more injection content after the same system message,
      // and raw mode will extract them all together → developer block includes session_context.
      const { buildSessionContextBlockWithToggles } = await import("./session/context-injector.js");
      const sessionContextBlock = buildSessionContextBlockWithToggles(
        cachedAgentDetail as any,
        cachedTaskDetail as any,
        config.sessionInit,
        sessionKey,
      );

      // Build a synthetic OpenAI body that the pipeline can parse/serialize.
      // The pipeline's OpenAI adapter reads `body.messages` and injects
      // text into the system message. We use a single system message as
      // the injection target; all injected text ends up there.
      const syntheticBody: Record<string, unknown> = {
        messages: [
          { role: "system", content: sessionContextBlock ?? "" },
          { role: "user", content: "." },
        ],
        model: modelId,
      };

      const injectedBody = await pipeline.process(syntheticBody, {
        protocol: "openai",
        traceId,
        keyId,
        modelId: modelId as string,
        stream: isStream,
        agentSource,
        userId: userId || "anonymous",
        spaceId,
        sessionKey,
        turnSeq: 0,
        requestPath: c.req.path,
        custom: { session: sessionInfo, userKey: callerUserKey ?? undefined, assetCapabilities },
      });

      // Extract injected content from the synthetic body's system message.
      // The pipeline appends to `messages[0].content` (system message).
      const injectedMessages = injectedBody.messages as Array<Record<string, unknown>> | undefined;
      const sysMsg = injectedMessages?.[0];
      const injectedText = typeof sysMsg?.content === "string" ? sysMsg.content : "";

      if (injectedText.length > 0) {
        // The injectedText produced by Pipeline is already the **final XML text** (containing
        // multiple internal tags such as <skill_tools> / <available_skills> / <user_memory> /
        // <tdai_profile_memory> / <memory-tools-guide>), matching exact byte output seen by CC / CB clients in system message.
        // Embed directly inside <tdai_injections> wrapper using raw mode — do not wrap with inner
        // <available_skills> tag, nor escape inner XML tags, otherwise model will see escaped entities
        // (`&lt;user_memory&gt;`) and fail to parse structure.
        body = injectCodexAssets(body, { raw: injectedText });
      }
    } catch (err: unknown) {
      console.error("[codex] injection pipeline error:", err instanceof Error ? err.message : String(err));
      // Degrade gracefully: forward without injection
    }
  }

  // ── 10. Build archive ctx (skill + tdai L0), forward, tap for hooks ──────
  //
  // Only create ctx under main dialog + initialized + non-bypassed steady state — injectionSkipped
  // scenario aligns with CC/CB "skip L0/skill" branch (when sessionInfo lacks team/user/agent trio,
  // triggerSkillExtractIfReady will exit early on its own, but checking beforehand saves a fanout).
  const archiveCtx = buildArchiveCtx({
    config,
    sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
    injectionSkipped,
    input,
    sessionKey,
    agentSource,
    spaceId,
    userId,
    callerUserKey,
    assetCapabilities,
  });

  // ── 11. Forward to upstream ────────────────────────────────────────────────
  return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, lf, archiveCtx);
}

// ── Archive context (skill/conversation/add + TDAI L0 write) ─────────────────

/**
 * Archiving trigger context — packages all inputs needed by hooks, constructed in handleCodexEndpoint
 * and passed all the way to the end of consumeCodexStream completeStream to trigger skill/L0 hooks.
 *
 * Only created for main conversation + initialized session + non-bypassed state; in other cases archiveCtx=null,
 * and forward side skips hook when null is encountered (aligned with CC/CB isMainDialog branch).
 */
export interface CodexArchiveCtx {
  config: ProxyConfig;
  sessionKey: string;
  agentSource: string;
  sessionInfo: Record<string, unknown>;
  spaceId: string;
  /**
   * Raw codex `input[]` — expanded inside normalize-conversation convertCodexInputItem
   * according to protocol="responses" during skill archiving.
   */
  input: unknown[];
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  /** Latest user question extracted from `input[]` (extracted via extractLatestCodexUserMessage). */
  tdaiUserMessage: TdaiMessage | null;
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
}

function buildArchiveCtx(args: {
  config: ProxyConfig;
  sessionInfo: Record<string, unknown> | null | undefined;
  injectionSkipped: boolean;
  input: unknown[];
  sessionKey: string;
  agentSource: string;
  spaceId: string;
  userId: string;
  callerUserKey: string | null;
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
}): CodexArchiveCtx | null {
  const { sessionInfo, injectionSkipped } = args;
  if (injectionSkipped || !sessionInfo) return null;

  const tdaiClient = args.assetCapabilities?.chat_memory === false
    ? null
    : createCodexTdaiClient(args.config, args.spaceId);
  const tdaiIdentity = deriveTdaiIdentity({
    sessionInfo,
    userId: args.userId || null,
    sessionKey: args.sessionKey,
    userKey: args.callerUserKey,
  });
  const tdaiUserMessage = extractLatestCodexUserMessage(args.input);

  return {
    config: args.config,
    sessionKey: args.sessionKey,
    agentSource: args.agentSource,
    sessionInfo,
    spaceId: args.spaceId,
    input: args.input,
    tdaiClient,
    tdaiIdentity,
    tdaiUserMessage,
    assetCapabilities: args.assetCapabilities,
  };
}

/**
 * Triggers skill/conversation/add + TDAI L0 write after stream completion, aligned with CC/CB
 * anthropicHandler.ts:1867-1948 section.
 *
 * Parameters:
 *   assistantText: accumulated assistant text from SSE accumulator
 *   toolUseCount:  accumulated function_call count in stream (round boundary criterion)
 *
 * Fails silently (errors logged), never blocks upstream response chain.
 */
async function triggerCodexArchiveHooks(
  ctx: CodexArchiveCtx,
  assistantText: string,
  toolUseCount: number,
): Promise<void> {
  // ── TDAI L0 write ──
  // Symmetric with anthropicHandler stream branch (line 1867-1878):
  //   - trackWrite attached to global in-flight set (index.ts flushPendingWrites handles SIGTERM packet loss fallback)
  //   - withL0Retry 3-time backoff guards against tdai kernel transient disconnects
  //   - non-await in stream scenario allows archiving hook to return early
  if (ctx.tdaiClient && ctx.tdaiIdentity && isExtractionAllowed(ctx.config, "tdai-memory")) {
    trackWrite(
      withL0Retry(() =>
        recordTdaiTurn(ctx.tdaiClient!, ctx.tdaiIdentity, ctx.tdaiUserMessage, assistantText || null),
      ).catch((err: unknown) => {
        console.warn("[codex-tdai-l0] failed:", err instanceof Error ? err.message : String(err));
      }),
    );
  } else if (ctx.tdaiClient) {
    logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionKey);
  }

  // ── Skill conversation/add trigger ──
  // Symmetric with anthropicHandler stream branch (line 1928-1948): return after archiving write to ensure
  // cross-node next turn reads latest buffer state; assistantMessage constructs codex message format using stream
  // accumulator outputText (type:"message", role:"assistant", content:[{type:"output_text", text}]), with toolCallCountOverride counted by stream.
  if (isExtractionAllowed(ctx.config, "skill")) {
    const assistantMessage = assistantText
      ? {
          type: "message" as const,
          role: "assistant" as const,
          content: [{ type: "output_text" as const, text: assistantText }],
        }
      : null;
    await triggerSkillExtractIfReady({
      config: ctx.config,
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      sessionInfo: ctx.sessionInfo,
      inputMessages: ctx.input,
      assistantMessage,
      protocol: "responses",
      assetCapabilities: ctx.assetCapabilities,
      toolCallCountOverride: toolUseCount,
    });
  } else {
    logExtractionSkipped(ctx.config, "skill", ctx.sessionKey);
  }
}

// ── Forward helper ───────────────────────────────────────────────────────────

async function forwardToUpstream(
  c: Context,
  config: ProxyConfig,
  body: Record<string, unknown>,
  traceId: string,
  startTime: string,
  keyId: string,
  modelId: string,
  pipe: ReturnType<typeof createPipeline>,
  lf: LangfuseTurnContext | null,
  archiveCtx: CodexArchiveCtx | null = null,
): Promise<Response> {
  // Per-agent upstream override (upstream.agents.codex.url) takes precedence over global url.
  // Aligned with resolution pattern in anthropicHandler.ts:1029. Codex typically requires pointing to a
  // compatibility layer supporting Responses API — some OpenAI-compatible upstreams only implement
  // messages/chat_completions and not /responses; per-agent override allowed here.
  const agentUpstreamEntry = config.upstream.agents?.["codex"];
  const upstreamBase = agentUpstreamEntry?.url || config.upstream.url;
  const upstreamUrl = joinUrl(upstreamBase, c.req.path);
  const upstreamHeaders = buildUpstreamHeaders(c, config);
  upstreamHeaders["content-type"] = "application/json";
  // apiKey override aligned with per-agent strategy: agentUpstreamEntry.apiKey takes precedence,
  // otherwise passthrough client Bearer token.
  if (agentUpstreamEntry) {
    if (agentUpstreamEntry.apiKey) {
      upstreamHeaders["authorization"] = `Bearer ${agentUpstreamEntry.apiKey}`;
    }
    // else: retain client key passthrough in c.req.header('authorization')
  }

  pipe.forwardStart(upstreamUrl);

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });
  } catch (err: unknown) {
    pipe.error("CODEX_FORWARD", err instanceof Error ? err : new Error(String(err)));
    // Report langfuse failure (forward error — upstream did not return response body, fetch threw locally)
    if (lf) {
      try {
        langfuseReportFailure({
          lf,
          model: modelId,
          startTime,
          endTime: new Date().toISOString(),
          input: buildCodexLangfuseInput(body),
          statusMessage: `forward error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
          extraTags: ["error"],
          observationMetadata: { stage: "forward", stream: true, upstreamUrl },
        });
      } catch (lfErr: unknown) {
        pipe.error("LANGFUSE_SPAN", lfErr);
      }
    }
    return c.json(
      { error: "Upstream request failed", detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }

  pipe.forwardDone(upstreamResp.status);

  // Log usage
  writeLog(config, {
    timestamp: startTime,
    event: "request",
    modelId,
    keyId,
    sessionKey: keyId,
    upstreamUrl,
    stream: true,
    traceId,
  });

  // ── Upstream 4xx/5xx: copy body text for langfuse error reporting; tap on success ──
  // Codex Responses API only has SSE streaming responses, no stream vs non-stream separation.
  if (upstreamResp.status >= 400) {
    // 4xx/5xx usually returns small JSON error; read in full for langfuse reporting
    const errText = await upstreamResp.text();
    if (lf) {
      try {
        langfuseReportFailure({
          lf,
          model: modelId,
          startTime,
          endTime: new Date().toISOString(),
          input: buildCodexLangfuseInput(body),
          status: upstreamResp.status,
          statusMessage: errText.slice(0, 500),
          extraTags: ["error"],
          observationMetadata: { stage: "upstream", stream: true, upstreamUrl },
        });
      } catch (lfErr: unknown) {
        pipe.error("LANGFUSE_SPAN", lfErr);
      }
    }
    return new Response(errText, {
      status: upstreamResp.status,
      headers: filterResponseHeaders(upstreamResp.headers),
    });
  }

  // 2xx: aux scenario (lf=null && archiveCtx=null) directly passthrough without tap; main dialog tap
  // copy for langfuse reporting + skill/L0 archiving hook (P1-P2 gap fix).
  // As long as either lf or archiveCtx is non-null, teeing tap stream is required.
  const needTap = Boolean(lf) || Boolean(archiveCtx);
  if (!needTap || !upstreamResp.body) {
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: filterResponseHeaders(upstreamResp.headers),
    });
  }

  const [rawClientStream, tapStream] = upstreamResp.body.tee();
  consumeCodexStream(tapStream, {
    lf,
    modelId,
    startTime,
    upstreamUrl,
    inputBody: body,
    pipe,
    archiveCtx,
  });

  return new Response(rawClientStream, {
    status: upstreamResp.status,
    headers: filterResponseHeaders(upstreamResp.headers),
  });
}

// ── Langfuse helpers ─────────────────────────────────────────────────────────

/**
 * Derives turn sequence from codex `body.input[]` — counts message items with role=user.
 *
 * Aligned with turnSeq.ts::countHumanTurns(openai/anthropic): tool loop requests within the same turn
 * (adding function_call_output items) do not increment human messages, producing the same
 * turnSeq so multiple requests merge into a single langfuse trace.
 */
export function countHumanTurnsCodex(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let count = 0;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type === "message" && it.role === "user") count++;
  }
  return count;
}

/**
 * Builds input payload for langfuse — codex input[] is already structured conversation history
 * and can be passed through directly (same purpose as anthropic buildLangfuseInput: allow langfuse UI
 * to clearly display input for this invocation). instructions block attached separately to complete context
 * (codex system prompt is in body.instructions rather than input).
 */
function buildCodexLangfuseInput(body: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = { input: body.input };
  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    out.instructions = body.instructions;
  }
  return out;
}

export interface CodexTapContext {
  /**
   * langfuse trace context; null indicates aux scenario without langfuse reporting, but archiving
   * may still be needed (in theory aux won't carry archiveCtx; when both null, upstream tap doesn't start).
   */
  lf: LangfuseTurnContext | null;
  modelId: string;
  startTime: string;
  upstreamUrl: string;
  inputBody: Record<string, unknown>;
  pipe: ReturnType<typeof createPipeline>;
  /**
   * skill archiving + TDAI L0 write hook context;
   * null indicates current request does not trigger archiving (aux / session uninitialized / bypass).
   */
  archiveCtx?: CodexArchiveCtx | null;
}

/**
 * Consumes codex Responses API SSE stream, extracts usage + assistant output, and reports to langfuse.
 *
 * Codex SSE key frames (see docs/2026-08-05-codex-onboarding.md §7.5.2/3):
 *   - response.output_text.delta:  {delta: "..."}                → accumulate assistant text
 *   - response.function_call_arguments.delta: {delta: "..."}     → accumulate tool_use args (for observation)
 *   - response.completed: {response: {usage, output, status, ...}} → completion, retrieve usage
 *
 * Silent failure — telemetry never impacts business logic chain.
 */
export function consumeCodexStream(stream: ReadableStream<Uint8Array>, ctx: CodexTapContext): void {
  const { lf, modelId, startTime, upstreamUrl, inputBody, pipe, archiveCtx } = ctx;

  (async () => {
    const decoder = new TextDecoder();
    let sseBuf = "";
    let usage: Record<string, unknown> = {};
    let outputText = "";
    let toolUseCount = 0;
    let stopReason: string | undefined;
    let streamCompleted = false;
    // 5-minute timeout fallback: client disconnect may hang upstream stream, force completion upon timeout here.
    const timeoutHandle = setTimeout(() => {
      if (!streamCompleted) {
        pipe.error("STREAM_TIMEOUT", "Codex stream reading exceeded 5 minutes");
        void completeStream().catch((err) => pipe.error("STREAM_TIMEOUT_COMPLETE", err));
      }
    }, 5 * 60 * 1000);

    async function completeStream(): Promise<void> {
      if (streamCompleted) return;
      streamCompleted = true;
      clearTimeout(timeoutHandle);

      const endTime = new Date().toISOString();
      if (lf) {
        try {
          const output = outputText
            ? { role: "assistant", content: outputText }
            : toolUseCount > 0
              ? { role: "assistant", content: `[${toolUseCount} tool call(s)]` }
              : undefined;
          langfuseReportGeneration({
            traceId: lf.traceId,
            name: modelId,
            model: modelId,
            startTime,
            endTime,
            input: buildCodexLangfuseInput(inputBody),
            output,
            usage: Object.keys(usage).length > 0 ? usage : undefined,
            traceName: lf.traceName,
            userId: lf.userId,
            sessionId: lf.sessionId,
            tags: lf.tags,
            traceInput: lf.userQuery || undefined,
            traceOutput: output,
            traceMetadata: {
              stream: true,
              upstreamUrl,
              stop_reason: stopReason,
              tool_use_count: toolUseCount,
            },
            observationMetadata: {
              stream: true,
              stop_reason: stopReason,
              tool_use_count: toolUseCount,
            },
          });
        } catch (lfErr: unknown) {
          pipe.error("LANGFUSE_SPAN", lfErr);
        }
      }

      // ── Skill/conversation/add + TDAI L0 archiving hook ──
      // Aligned with stream branch of anthropicHandler.ts (line 1867-1948): trigger skill archiving + L0 write after langfuse report.
      // Silent failure (warned internally), does not block client SSE.
      // Skip directly if archiveCtx=null (aux / session uninitialized / bypass).
      if (archiveCtx) {
        try {
          await triggerCodexArchiveHooks(archiveCtx, outputText, toolUseCount);
        } catch (archiveErr: unknown) {
          pipe.error("CODEX_ARCHIVE", archiveErr instanceof Error ? archiveErr : new Error(String(archiveErr)));
        }
      }
    }

    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuf += decoder.decode(value, { stream: true });
        const parts = sseBuf.split("\n\n");
        sseBuf = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n");
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("data: ")) dataStr = line.slice(6);
            else if (line.startsWith("data:")) dataStr = line.slice(5);
          }
          if (!dataStr) continue;

          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            const evtType = evt.type as string | undefined;

            if (evtType === "response.output_text.delta") {
              const delta = evt.delta;
              if (typeof delta === "string") outputText += delta;
            } else if (evtType === "response.output_item.added") {
              const item = evt.item as Record<string, unknown> | undefined;
              if (item?.type === "function_call") toolUseCount++;
            } else if (evtType === "response.completed") {
              const resp = evt.response as Record<string, unknown> | undefined;
              if (resp?.usage) {
                Object.assign(usage, resp.usage as Record<string, unknown>);
              }
              stopReason = (resp?.status as string) ?? "completed";
            } else if (evtType === "response.incomplete") {
              // max_output_tokens / other interruptions (Responses API standard)
              const resp = evt.response as Record<string, unknown> | undefined;
              const details = resp?.incomplete_details as Record<string, unknown> | undefined;
              stopReason = `incomplete:${details?.reason ?? "unknown"}`;
              if (resp?.usage) Object.assign(usage, resp.usage as Record<string, unknown>);
            }
          } catch {
            // ignore malformed frames — telemetry-level issues do not block
          }
        }
      }
    } catch (err: unknown) {
      pipe.error("CODEX_TAP", err instanceof Error ? err : new Error(String(err)));
    } finally {
      await completeStream();
    }
  })().catch((err: unknown) => pipe.error("CODEX_TAP_UNHANDLED", err));
}
