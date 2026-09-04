/**
 * WorkBuddy endpoint handler —— skeleton layer (helper functions + main handler stub).
 *
 * WorkBuddy goes through the OpenAI Responses API (@openai/agents SDK); its wire protocol is
 * identical to Codex and its system prompt XML structure is similar to CodeBuddy. However, this
 * file is **intentionally fully decoupled from codexHandler / codebuddyHandler** — it imports no
 * sibling handler. Swapping WorkBuddy only touches this file plus injection/agents/workbuddy/,
 * leaving all other clients unaffected.
 *
 * This round (step one of the layered delivery): **expose only unit-test-friendly pure functions**
 *   - classifyWorkbuddyRequest: identify main vs auxiliary requests
 *   - extractWorkbuddySessionId: extract the session id from the header / body
 *   - detectWorkbuddyDefaultModeGate: detect the client's Default mode gate signal
 *   - injectWorkbuddyAssets: append a `<tdai_injections>` wrapper to body.input[0].content[]
 *
 * The full `handleWorkbuddyEndpoint(c, config)` main handler (auth / session-init /
 * mem-command / forward + langfuse tap) is deferred until the next round wires up the server
 * routes — it needs many config/session deps, so it is isolated first to shrink the regression
 * surface.
 */

import type { Context } from "hono";
import type { ProxyConfig } from "./types.js";
import { apiKeyToKeyId, extractBearerToken, uuidv7 } from "./opik.js";
import { createPipeline, writeLog } from "./logger.js";
import { extractSpaceIdFromPath } from "./credit-reporter.js";
import { joinUrl } from "./guard-adapter.js";
import { verifyUserKey } from "./auth.js";
import { resolveModelId } from "./pricing.js";
import { workbuddyAdapter } from "./agent-adapters/workbuddy.js";
import {
  buildWorkbuddyInjectionBlock,
  type WorkbuddyInjectionInput,
} from "./common/workbuddy-injection.js";
// WorkBuddy uses the Responses API, identical to the codex wire — the modal skeleton directly
// reuses buildFormResponse + codexFormAnswersAsMessages from session/codex/form.ts, and the
// state machine reuses CB's handleSessionInit(agentSource="codex"). This way WorkBuddy does
// not need its own separate form skeleton.
import {
  buildFormResponse as buildCodexFormResponse,
  codexFormAnswersAsMessages,
} from "./session/codex/form.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "./langfuse.js";

// ── TDAI L0 + Skill extraction imports ────────────────────────────────────────
import { TdaiClient } from "./tdai/client.js";
import { deriveTdaiIdentity } from "./tdai/identity.js";
import { recordTdaiTurn } from "./tdai/recorder.js";
import { trackWrite, withL0Retry } from "./tdai/pending-writes.js";
import type { TdaiIdentity, TdaiMessage } from "./tdai/types.js";
import { triggerSkillExtractIfReady } from "./skill/handler-glue.js";
import { isExtractionAllowed, logExtractionSkipped } from "./extraction-gate.js";

// ── Handler-level constants ──────────────────────────────────────────────────

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

// ── Types (exported for unit tests) ──────────────────────────────────────────

/**
 * WorkBuddy per-session state.
 * Semantically identical to CodexSessionState but a separate type, to avoid cross-handler
 * type sharing.
 *
 * - status: "initialized" means binding/onboarding is complete; "pending" means still waiting
 *   on the session-init form round-trip
 * - bypassed: the user explicitly chose "Default mode" to bypass binding, so form injection is
 *   permanently skipped
 * - sessionInfo: the { userId, teamId, agentId, ... } metadata attached after a successful bind,
 *   forwarded to the injection pipeline for context lookups
 */
export interface WorkbuddySessionState {
  status: "initialized" | "pending";
  bypassed?: boolean;
  sessionInfo?: Record<string, unknown> | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Signature string for the WorkBuddy client's Default mode gate.
 * After the user picks Default mode, the client emits this prefix in its function_call_output
 * ("request_user_input is unavailable in Default mode"); a match means the user explicitly
 * chose to bypass the binding flow, so the session should be permanently bypassed.
 *
 * The actual WorkBuddy client string is **still to be confirmed by capturing traffic**; for now
 * we ship with codex's gate string ("request_user_input is unavailable in Default mode") and
 * align it during integration testing with the real client.
 * TODO(workbuddy-integration): capture traffic to confirm the actual WorkBuddy client gate string.
 */
const DEFAULT_GATE_PREFIX = "request_user_input is unavailable in Default mode";

// ── Request classification ───────────────────────────────────────────────────

/**
 * Classify a WorkBuddy request as main or auxiliary.
 *
 * An auxiliary request is a client-initiated background call (memory generation, trace
 * summarization, compact, etc.) that must not trigger the session-init form or injection;
 * it is forwarded upstream as-is.
 *
 * Decision order (any match returns auxiliary):
 *   1. the path contains an aux path segment (/compact, /trace_summarize, /realtime, /memories)
 *   2. the headers carry a memgen marker (x-openai-memgen-request=true, following SDK convention)
 *   3. body.client_metadata.thread_source ∈ {system, memory_consolidation}
 *
 * An unknown thread_source is treated as main (conservative — better to miss an aux call than
 * to misclassify a real user interaction as aux).
 */
export function classifyWorkbuddyRequest(
  body: Record<string, unknown>,
  path: string,
  headers: Record<string, string>,
): "main" | "auxiliary" {
  // ① path-based aux detection
  const AUX_PATH_HINTS = ["/compact", "/trace_summarize", "/realtime", "/memories"];
  for (const hint of AUX_PATH_HINTS) {
    if (path.includes(hint)) return "auxiliary";
  }

  // ② header memgen marker
  const memgen =
    headers["x-openai-memgen-request"] ??
    headers["X-OpenAI-Memgen-Request"] ??
    "";
  if (memgen === "true" || memgen === "1") return "auxiliary";

  // ③ body.client_metadata.thread_source
  const meta = body.client_metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const ts = meta.thread_source;
    if (ts === "system" || ts === "memory_consolidation") return "auxiliary";
  }

  return "main";
}

// ── Session ID extraction ────────────────────────────────────────────────────

/**
 * Extract the WorkBuddy session id from the request headers / body.
 *
 * Priority (same as codex):
 *   1. header `session-id` (SDK default location)
 *   2. body.client_metadata.session_id (fallback)
 *
 * Neither present → null (the caller decides whether to reject or create a new session).
 */
export function extractWorkbuddySessionId(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): string | null {
  const fromHeader = headers["session-id"] ?? headers["Session-Id"];
  if (typeof fromHeader === "string" && fromHeader.length > 0) return fromHeader;

  const meta = body.client_metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const sid = meta.session_id;
    if (typeof sid === "string" && sid.length > 0) return sid;
  }
  return null;
}

// ── Default mode gate detection ──────────────────────────────────────────────

/**
 * Detect the WorkBuddy client's Default mode gate signal.
 *
 * When the user rejects the request_user_input form (choosing Default mode), the client
 * includes a function_call_output.output ~= "request_user_input is unavailable in Default mode"
 * in the next turn's input[]. A match means the user explicitly wants to bypass the binding
 * flow → the session should be marked bypassed.
 *
 * Same structure as the codex version; the prefix string is defined separately
 * (DEFAULT_GATE_PREFIX) so future client copy changes only touch this one constant.
 */
export function detectWorkbuddyDefaultModeGate(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type !== "function_call_output") continue;
    const output = it.output;
    if (typeof output === "string" && output.startsWith(DEFAULT_GATE_PREFIX)) {
      return true;
    }
  }
  return false;
}

// ── Asset injection ──────────────────────────────────────────────────────────

/**
 * Inject the `<tdai_injections>` wrapper into WorkBuddy body.input[0].content[].
 *
 * Homomorphic to the codex logic: attach the full XML text produced by the pipeline to the
 * end of the developer message (input[0]) content array.
 *
 * Defensive short-circuits:
 *   - no input, or input is not an array → return the original body
 *   - input[0] is not a message → return the original body
 *   - input[0].content is not an array → return the original body
 *   (Why these guards matter: on non-first frames input[0] may be a function_call and the like;
 *    only on the first turn is input[0] a developer/user message. Injecting into a function_call
 *    item's content would cause an upstream 400 or corrupt the semantics.)
 *
 * Returns a shallow copy and does not mutate the original body (body → input → input[0] →
 * content are shallow-copied along the whole chain).
 */
export function injectWorkbuddyAssets(
  body: Record<string, unknown>,
  assets: WorkbuddyInjectionInput,
): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input) || input.length === 0) return body;

  const devMsg = input[0] as Record<string, unknown> | null;
  if (!devMsg || typeof devMsg !== "object") return body;
  if (devMsg.type !== "message") return body;

  const content = devMsg.content;
  if (!Array.isArray(content)) return body;

  const injectionBlock = buildWorkbuddyInjectionBlock(assets);

  // Shallow-copy chain: body → input → input[0] → content
  const newContent = [...content, injectionBlock];
  const newDevMsg = { ...devMsg, content: newContent };
  const newInput = [newDevMsg, ...input.slice(1)];
  return { ...body, input: newInput };
}

// ── Human turn counting (langfuse instrumentation helper) ──────────────────

/**
 * Count the number of "human turns" in the WorkBuddy input[].
 *
 * Used as the turnSeq for the langfuse trace — only user-initiated messages (role=user and
 * type=message) count; function_call / function_call_output items produced by tool calls and
 * assistant feedback do not. This way multiple function_calls within one turn merge into a
 * single trace, which is easier to observe.
 *
 * Same logic as codex's countHumanTurnsCodex, copied separately to keep "zero dependencies
 * between handlers".
 */
export function countHumanTurnsWorkbuddy(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let count = 0;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type !== "message") continue;
    if (it.role !== "user") continue;
    count++;
  }
  return count;
}

// ── Workbuddy Archive Context (L0 write + Skill extract) ────────────────────

/**
 * WorkBuddy L0/Skill archiving context, mirroring the CodexArchiveCtx design in codexHandler:
 *   - when archiveCtx is null, the forward/session-bypass side skips the hooks entirely
 *   - failures are silent (warned internally) and never block the upstream response
 */
export interface WorkbuddyArchiveCtx {
  config: ProxyConfig;
  sessionKey: string;
  agentSource: string;
  sessionInfo: Record<string, unknown>;
  userId: string;
  /** The raw body.input[] (responses API input items) */
  input: unknown[];
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  tdaiUserMessage: TdaiMessage | null;
  /**
   * Asset capability flags (chat_memory / skill / ...); used to gate the archive hooks.
   * Aligned with codexHandler.CodexArchiveCtx.assetCapabilities.
   */
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
}

/**
 * Extract the latest user message from the responses API body.input[] for the L0 write.
 */
function extractLatestWorkbuddyUserMessage(input: unknown): TdaiMessage | null {
  if (!Array.isArray(input)) return null;
  const text = workbuddyAdapter.extractUserText(input);
  if (!text) return null;
  return { role: "user", content: text };
}

function createWorkbuddyTdaiClient(config: ProxyConfig): TdaiClient | null {
  if (!config.tdai?.enabled || !config.tdai?.memory?.enabled || !config.tdai?.endpoint) return null;
  return new TdaiClient({
    enabled: config.tdai.enabled,
    endpoint: config.tdai.endpoint,
    apiKey: config.tdai.apiKey,
    serviceId: config.tdai.serviceId,
    writeL0: config.tdai.memory.writeL0,
    recallL1: config.tdai.memory.recallL1,
    injectL2L3: config.tdai.memory.injectL2L3,
    l1Limit: config.tdai.memory.l1Limit,
    l2Limit: config.tdai.memory.l2Limit,
    timeoutMs: config.tdai.memory.timeoutMs,
  });
}

function buildWorkbuddyArchiveCtx(args: {
  config: ProxyConfig;
  sessionInfo: Record<string, unknown> | null | undefined;
  injectionSkipped: boolean;
  input: unknown[];
  sessionKey: string;
  userId: string;
  callerUserKey?: string | null;
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
}): WorkbuddyArchiveCtx | null {
  const { sessionInfo, injectionSkipped } = args;
  if (injectionSkipped || !sessionInfo) return null;

  // When chat_memory=false the user explicitly disabled memory → don't create the tdaiClient;
  // skill archiving still runs.
  // Aligned with codexHandler.buildArchiveCtx (lines 855-857).
  const tdaiClient = args.assetCapabilities?.chat_memory === false
    ? null
    : createWorkbuddyTdaiClient(args.config);
  const tdaiIdentity = deriveTdaiIdentity({
    sessionInfo,
    userId: args.userId || null,
    sessionKey: args.sessionKey,
    userKey: args.callerUserKey ?? null,
  });
  const tdaiUserMessage = extractLatestWorkbuddyUserMessage(args.input);

  return {
    config: args.config,
    sessionKey: args.sessionKey,
    agentSource: "workbuddy",
    sessionInfo,
    userId: args.userId,
    input: args.input,
    tdaiClient,
    tdaiIdentity,
    tdaiUserMessage,
    assetCapabilities: args.assetCapabilities,
  };
}

/**
 * Trigger the TDAI L0 write + skill extraction after the stream ends, mirroring
 * codexHandler's triggerCodexArchiveHooks. Failures are silent (already warned internally)
 * and never block downstream.
 *
 * @param ctx          archive context (only effective when non-null)
 * @param assistantText assistant text accumulated by the stream accumulator
 */
async function triggerWorkbuddyArchiveHooks(
  ctx: WorkbuddyArchiveCtx,
  assistantText: string,
  toolCallCountOverride?: number,
): Promise<void> {
  // ── TDAI L0 write ──
  // Symmetric to codexHandler's triggerCodexArchiveHooks:
  //   trackWrite registers onto the global in-flight set (index.ts flushPendingWrites covers it)
  //   withL0Retry retries 3 times with backoff against transient tdai kernel outages
  //   stream scenarios don't await, letting the archive hooks return early
  //
  // Note: buildWorkbuddyArchiveCtx already nulled tdaiClient when chat_memory=false, so there is
  // no need to re-check assetCapabilities.chat_memory here; a null tdaiClient is skipped naturally.
  if (ctx.tdaiClient && ctx.tdaiIdentity && isExtractionAllowed(ctx.config, "tdai-memory")) {
    trackWrite(
      withL0Retry(() =>
        recordTdaiTurn(ctx.tdaiClient!, ctx.tdaiIdentity, ctx.tdaiUserMessage, assistantText || null),
      ).catch((err: unknown) => {
        console.warn("[workbuddy-tdai-l0] failed:", err instanceof Error ? err.message : String(err));
      }),
    );
  } else if (ctx.tdaiClient) {
    logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionKey);
  }

  // ── Skill conversation/add trigger ──
  // Symmetric to codexHandler: return only after the archive write finishes, so the next turn on
  // another node reads the freshest buffer.
  // assistantMessage is assembled from the stream accumulator's outputText into a Responses API
  // message (type:"message", role:"assistant", content:[{type:"output_text", text}]) — consistent
  // with codexHandler.
  //
  // protocol must be "responses": the server.ts comment clearly states WorkBuddy shares the Codex
  // protocol, and the langfuse tag uses "protocol:responses" too. If "openai" is passed by
  // mistake, skill extraction's normalizeConversation would parse messages[] as Chat Completions
  // format, which mismatches the actual body.input[] (Responses API).
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
      agentSource: "workbuddy",
      sessionInfo: ctx.sessionInfo,
      inputMessages: ctx.input,
      assistantMessage,
      protocol: "responses",
      assetCapabilities: ctx.assetCapabilities,
      toolCallCountOverride,
    });
  } else {
    logExtractionSkipped(ctx.config, "skill", ctx.sessionKey);
  }
}

// ── Upstream helpers ─────────────────────────────────────────────────────────

/**
 * Shape the workbuddy request body into the langfuse observation `input` field.
 *
 * workbuddy uses the Responses API; the request body shape is:
 *   - body.input:        Array<InputItem> (always present: user messages / tool outputs, etc.)
 *   - body.instructions: string           (optional, system-level instructions)
 *
 * Combination strategy (minimize nesting depth in the langfuse UI):
 *   - instructions present → return { input, instructions }
 *   - only input       → return body.input directly
 *   - neither present  → return undefined (langfuse does not write the input field)
 */
function buildWorkbuddyLangfuseInput(body: Record<string, unknown>): unknown {
  const hasInput = Array.isArray(body.input);
  const hasInstructions =
    typeof body.instructions === "string" && (body.instructions as string).length > 0;
  if (!hasInput && !hasInstructions) return undefined;
  if (hasInput && hasInstructions) {
    return { input: body.input, instructions: body.instructions };
  }
  return hasInput ? body.input : { instructions: body.instructions };
}

function buildUpstreamHeaders(c: Context, config: ProxyConfig): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) h[k] = v;
  }
  if (config.upstream.apiKey) {
    h["authorization"] = `Bearer ${config.upstream.apiKey}`;
    delete h["x-api-key"];
  }
  return h;
}

function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((v, k) => {
    if (!SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) out.set(k, v);
  });
  return out;
}

/**
 * Forward the request to upstream. On SSE responses with `lf != null`, tees
 * the stream and reports usage/text to langfuse (best-effort).
 */
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
  archiveCtx: WorkbuddyArchiveCtx | null = null,
): Promise<Response> {
  // ── Per-agent upstream override ──
  // Aligned with codexHandler: supports config.upstream.agents?.workbuddy to point at its own
  // URL/apiKey; falls back to the global config.upstream.{url,apiKey} when unset.
  const perAgent = (config.upstream as unknown as {
    agents?: { workbuddy?: { url?: string; apiKey?: string } };
  }).agents?.workbuddy;
  const upstreamBase = ((perAgent?.url ?? config.upstream.url ?? "") as string).replace(/\/$/, "");
  const upstreamPath = c.req.path.replace(/^\/workbuddy\/[^/]+/, "");
  const upstreamUrl = joinUrl(upstreamBase, upstreamPath);

  const headers = buildUpstreamHeaders(c, config);
  // If per-agent specifies its own apiKey, override the globally injected authorization
  if (perAgent?.apiKey) {
    headers["authorization"] = `Bearer ${perAgent.apiKey}`;
    delete headers["x-api-key"];
  }
  const bodyStr = JSON.stringify(body);

  // Structured instrumentation: aligned with codex (forwardStart / forwardDone / info, three stages)
  pipe.forwardStart(upstreamUrl);

  // usage.log records the request (for ops / billing stats), matching codex's writeLog usage
  try {
    writeLog(config, {
      timestamp: startTime,
      event: "request",
      modelId,
      keyId,
      sessionKey: keyId,
      upstreamUrl,
      stream: true,
    });
  } catch {
    /* logger best-effort */
  }

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: bodyStr,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pipe.info("WORKBUDDY_FORWARD_ERR", msg);
    // Network-layer failure → report to langfuse failure so production dashboards can see it
    if (lf) {
      try {
        langfuseReportFailure({
          lf,
          model: modelId,
          startTime,
          endTime: new Date().toISOString(),
          input: buildWorkbuddyLangfuseInput(body),
          statusMessage: `fetch_failed: ${msg}`.slice(0, 500),
          extraTags: ["error"],
          observationMetadata: {
            stage: "forward",
            stream: true,
            upstreamUrl,
            keyId,
          },
        });
      } catch (lfErr: unknown) {
        pipe.error("LANGFUSE_SPAN", lfErr);
      }
    }
    return c.json({ error: `Upstream fetch failed: ${msg}` }, 502);
  }

  const respHeaders = filterResponseHeaders(upstreamResp.headers);
  const contentType = upstreamResp.headers.get("content-type") ?? "";
  const isSSE = contentType.includes("text/event-stream");

  pipe.forwardDone(upstreamResp.status);

  // Upstream 4xx/5xx → report to langfuse failure (body already consumed upstream; don't re-read
  // it to avoid breaking the stream)
  if (lf && upstreamResp.status >= 400) {
    try {
      langfuseReportFailure({
        lf,
        model: modelId,
        startTime,
        endTime: new Date().toISOString(),
        input: buildWorkbuddyLangfuseInput(body),
        status: upstreamResp.status,
        statusMessage: `upstream_${upstreamResp.status}`,
        extraTags: ["error"],
        observationMetadata: {
          stage: "upstream",
          stream: true,
          upstreamUrl,
          keyId,
          content_type: contentType,
        },
      });
    } catch (lfErr: unknown) {
      pipe.error("LANGFUSE_SPAN", lfErr);
    }
  }

  // Non-SSE or no langfuse ctx → passthrough
  if (!isSSE || !upstreamResp.body || !lf) {
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  }

  // SSE + langfuse: tee & tap
  const [passStream, tapStream] = upstreamResp.body.tee();
  void consumeWorkbuddyStream(tapStream, {
    startTime,
    modelId,
    keyId,
    traceId,
    lf,
    config,
    pipe,
    archiveCtx,
    inputBody: body,
    upstreamUrl,
  });

  return new Response(passStream, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}

/**
 * WorkBuddy tap context —— the parameter type for consumeWorkbuddyStream.
 */
interface WorkbuddyTapContext {
  startTime: string;
  modelId: string;
  keyId: string;
  traceId: string;
  lf: LangfuseTurnContext | null;
  config: ProxyConfig;
  pipe: ReturnType<typeof createPipeline>;
  archiveCtx: WorkbuddyArchiveCtx | null;
  /**
   * The final body forwarded upstream (including the injected input[]). Used in two places:
   *   1) the langfuse observation.input (buildWorkbuddyLangfuseInput)
   *   2) as a fallback — currently unused, but mirrors codex for future extension
   */
  inputBody: Record<string, unknown>;
  /** Upstream URL, written into observationMetadata for troubleshooting */
  upstreamUrl: string;
}

/**
 * Consume an SSE stream from upstream, extract text + usage, report to
 * langfuse, then trigger L0 write + skill extraction hooks.
 * Runs asynchronously without blocking the downstream response.
 *
 * Key mechanics (aligned with codex but keeping workbuddy's existing try/finally style):
 *   - 5-minute fallback setTimeout: force a final cleanup when the client disconnects or the
 *     upstream stalls without releasing the stream
 *   - toolUseCount accumulation: in the Responses API, each `response.output_item.done` +
 *     `item.type==="function_call"` counts one tool call; forwarded to skill archiving as the
 *     round-boundary criterion
 *   - buildWorkbuddyLangfuseInput(inputBody): writes body.input + instructions into the
 *     langfuse observation.input for troubleshooting
 */
async function consumeWorkbuddyStream(
  stream: ReadableStream<Uint8Array>,
  ctx: WorkbuddyTapContext,
): Promise<void> {
  // aux passthrough: skip langfuse + archive hooks
  if (!ctx.lf) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let assistantText = "";
  let usage: Record<string, unknown> | undefined;
  let responseId: string | undefined;
  // Q: accumulate the number of function_calls in the current turn (round-boundary criterion)
  let toolUseCount = 0;

  // P: 5-minute timeout fallback. An upstream or client disconnect can leave reader.read()
  // hanging forever; force a cancel with setTimeout to avoid leaking the tap coroutine. Use a
  // flag instead of throwing directly, because cancelling fetch's ReadableStream lets the main
  // loop exit naturally.
  let streamCompleted = false;
  const timeoutHandle = setTimeout(() => {
    if (!streamCompleted) {
      ctx.pipe.error(
        "STREAM_TIMEOUT",
        new Error("Workbuddy stream reading exceeded 5 minutes"),
      );
      // Actively cancel the reader; the read loop then exits on done=true or an error
      void reader.cancel().catch(() => {
        /* best-effort */
      });
    }
  }, 5 * 60 * 1000);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLines = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6));
        if (dataLines.length === 0) continue;
        const payload = dataLines.join("\n");
        if (payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload) as Record<string, unknown>;
          const evtType = evt.type as string | undefined;
          if (evtType === "response.output_text.delta") {
            const delta = evt.delta;
            if (typeof delta === "string") assistantText += delta;
          }
          // Q: tool call counting (matching codex's criteria) — increment only on
          // output_item.done when item.type==="function_call"; don't put it in
          // response.completed to avoid over- or under-counting.
          if (evtType === "response.output_item.done") {
            const item = evt.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") toolUseCount++;
            // The resp semantics inside response.output_item.done stay consistent with codex:
            // some upstreams emit usage/response.id here (multiple times within a stream);
            // the completed branch below is the authoritative usage source.
            const resp = (evt.response ?? evt) as Record<string, unknown>;
            if (typeof resp?.id === "string") responseId = resp.id as string;
            if (resp?.usage && typeof resp.usage === "object") {
              usage = resp.usage as Record<string, unknown>;
            }
          }
          if (evtType === "response.completed") {
            const resp = (evt.response ?? evt) as Record<string, unknown>;
            if (typeof resp?.id === "string") responseId = resp.id as string;
            if (resp?.usage && typeof resp.usage === "object") {
              usage = resp.usage as Record<string, unknown>;
            }
          }
        } catch {
          /* ignore malformed frames */
        }
      }
    }
  } catch (err) {
    ctx.pipe.info("WORKBUDDY_STREAM_ERR", err instanceof Error ? err.message : String(err));
  } finally {
    streamCompleted = true;
    clearTimeout(timeoutHandle);
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }

  const endTime = new Date().toISOString();
  try {
    // R: report with the structured input (body.input + instructions) for langfuse UI troubleshooting
    langfuseReportGeneration({
      traceId: ctx.lf.traceId,
      name: `workbuddy:${ctx.modelId}`,
      model: ctx.modelId,
      startTime: ctx.startTime,
      endTime,
      input: buildWorkbuddyLangfuseInput(ctx.inputBody),
      output: assistantText,
      usage: usage && Object.keys(usage).length > 0 ? usage : undefined,
      traceName: ctx.lf.traceName,
      userId: ctx.lf.userId,
      sessionId: ctx.lf.sessionId,
      tags: ctx.lf.tags,
      traceInput: ctx.lf.userQuery || undefined,
      traceOutput: assistantText,
      observationMetadata: {
        stream: true,
        response_id: responseId,
        keyId: ctx.keyId,
        upstreamUrl: ctx.upstreamUrl,
        tool_use_count: toolUseCount,
      },
    });
  } catch (err) {
    ctx.pipe.info(
      "WORKBUDDY_LANGFUSE_ERR",
      err instanceof Error ? err.message : String(err),
    );
  }

  // ── TDAI L0 write + Skill extraction ──
  // Aligned with codexHandler's triggerCodexArchiveHooks: fire archiving after the langfuse
  // report. archiveCtx=null (aux / uninitialized session / bypass) is skipped entirely.
  // Q: toolUseCount is passed to skill archiving as the round-boundary criterion.
  if (ctx.archiveCtx && assistantText) {
    await triggerWorkbuddyArchiveHooks(ctx.archiveCtx, assistantText, toolUseCount).catch(
      (err: unknown) => {
        ctx.pipe.info(
          "WORKBUDDY_ARCHIVE_ERR",
          err instanceof Error ? err.message : String(err),
        );
      },
    );
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

/**
 * WorkBuddy endpoint handler.
 *
 * 10-step flow (aligned with the codex/anthropic/openai handlers for side-by-side reading):
 *   1. Auth        - verify Bearer token / x-api-key signature
 *   2. Body        - parse the JSON body
 *   3. Headers     - build the lowercased request header map
 *   4. Classify    - main vs auxiliary
 *   5. Aux         - short-circuit passthrough (no injection, no langfuse reporting)
 *   6. Session ID  - extract session id from header/body, build the langfuse turn ctx
 *   7. Session init- reuse the CB state machine (handleSessionInit, agentSource="codex")
 *                   + codex form builder to render the Responses API SSE modal
 *   8. Mem command - intercept "/" commands (once the session is registered)
 *   9. Injection   - generic injection pipeline, inject into body.input[0].content[]
 *   10. Forward    - forward upstream + tap the SSE stream and report to langfuse
 */
export async function handleWorkbuddyEndpoint(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();
  const path = c.req.path;

  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const rawAuth = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const rawXApiKey = c.req.header("x-api-key") ?? "";
  const apiKey =
    extractBearerToken(rawAuth) ??
    rawXApiKey ??
    "";
  const spaceId = extractSpaceIdFromPath(path) ?? "";
  const { userId, rejected: userKeyRejected, rejectReason } = await verifyUserKey(
    apiKey,
    spaceId,
  );
  if (userKeyRejected) {
    return c.json({ error: `Authentication failed: ${rejectReason ?? "unknown"}` }, 401);
  }
  const keyId = userId || (apiKey ? apiKeyToKeyId(apiKey) : "unknown");

  // ── 2. Read body ─────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // ── 3. Extract headers ───────────────────────────────────────────────────
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    headers[k.toLowerCase()] = v;
  }

  // ── 4. Classify request ──────────────────────────────────────────────────
  // When workbuddyRequestRouting.enabled is off, requests are forced to main, taking the
  // fully-equivalent legacy path that predates aux routing. Ops rollback insurance, on by default;
  // follows CC's ccRequestRouting.enabled semantics but with the default inverted (CC: false for a
  // gradual rollout; WB: true for a conservative rollback).
  const wbRoutingEnabled = config.workbuddyRequestRouting?.enabled !== false;
  const requestKind = wbRoutingEnabled
    ? classifyWorkbuddyRequest(body, path, headers)
    : "main";
  const isAuxiliary = requestKind === "auxiliary";

  const requestedModel = typeof body.model === "string" ? body.model : "";
  const modelId = resolveModelId(config.creditPricing, requestedModel);
  const pipe = createPipeline(config, traceId, modelId);

  // ── 5. Aux passthrough ───────────────────────────────────────────────────
  if (isAuxiliary) {
    pipe.info("WORKBUDDY_AUX", `auxiliary request → passthrough (path=${path})`);
    return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, null, null);
  }

  // ── 6. Session ID + langfuse turn ctx ────────────────────────────────────
  const sessionId = extractWorkbuddySessionId(headers, body);
  const sessionKey = sessionId ?? `${keyId}:${traceId}`;
  const agentSource = "workbuddy";
  const isStream = body.stream !== false;
  const callerUserKey = apiKey || null;

  const turnSeq = countHumanTurnsWorkbuddy(body.input);
  const userQuery = workbuddyAdapter.extractUserText(body.input) ?? "";
  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(sessionKey, turnSeq),
    turnSeq,
    traceName: `${modelId} / ${keyId}`,
    userId: keyId,
    sessionId: sessionKey,
    tags: [
      `agent_source:${agentSource}`,
      "protocol:responses",
      isStream ? "stream" : "non-stream",
      `session:${sessionKey}`,
    ],
    routeTags: [],
    userQuery,
  };

  // ── 7. Session-init state machine (reuses CB with agentSource="codex") ───
  //
  // WorkBuddy and codex share the same Responses API wire; the modal skeleton directly reuses
  // codex/form.ts's buildFormResponse + the CB state machine (handleSessionInit +
  // agentSource="codex"). agentSource here is "codex" rather than "workbuddy" — the state machine
  // internally decides by source:
  //   - whether to use two-step paging (codex-only)
  //   - Default gate string recognition
  //   - whether formData.{teamPage,agentPage,taskPage} get filled
  // All three are codex-client-specific behaviors, and WorkBuddy behaves the same. The
  // agent_source in langfuse tags / logs stays "workbuddy", unaffected.
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("./injection/types.js").AssetCapabilityFlags | undefined;
  let injectionSkipped = false;
  let cachedAgentDetail: unknown = null;
  let cachedTaskDetail: unknown = null;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;

  const input = Array.isArray(body.input) ? body.input : [];

  // ── mem:session-reset pre-hook ──
  if (config.memCommand?.enabled) {
    const { isSessionResetCommand } = await import("./mem-command/pre-intercept.js");
    if (isSessionResetCommand(body as Record<string, unknown>, agentSource)) {
      const { parseCommandFromText, isMemCommandAllowed } = await import("./mem-command/index.js");
      const { workbuddyAdapter } = await import("./agent-adapters/workbuddy.js");
      const userText = workbuddyAdapter.extractUserText(input) ?? "";
      const memCmd = parseCommandFromText(userText);
      if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
        const { getSessionStore } = await import("./session/store.js");
        const store = getSessionStore();
        const compositeKey = `codex:${sessionKey}`;
        store.bind(compositeKey, { userId: userId || "anonymous", agentSource, sessionId: sessionKey, spaceId });

        // ── Force-archive the old agent's skill buffer (best-effort) ──
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

  if (config.sessionInit?.enabled && sessionId) {
    try {
      const { getSessionStore, handleSessionInit, parsePresetIdentity } = await import(
        "./session/index.js"
      );
      const { getMetadataClient } = await import("./meta/client.js");
      const store = getSessionStore();
      // The kernel-side auth x-tdai-user-key is taken directly from the client request bearer
      // (aligned with codexHandler / anthropicHandler). The bearer carried by the WorkBuddy /
      // Codex / Claude Code desktop clients is the user key itself, which the kernel recognizes;
      // no config.tdai.apiKey fallback is needed (otherwise "local" from the config would override
      // the real user key and cause a 401).
      const metadataClient = getMetadataClient(config.coreSkill, spaceId, apiKey);
      const presetIdentity = parsePresetIdentity(config.sessionInit, headers);

      const compositeKey = `codex:${sessionKey}`;
      const identity = {
        userId: userId || "anonymous",
        agentSource: "codex" as const,
        sessionId: sessionKey,
        spaceId,
      };
      const recovered = await store.getOrRecover(compositeKey, identity, {
        metadataClient,
        // Responses API clients don't use messages[]; pass empty so the store recovers via the
        // header/no-message path
        messages: [],
      });

      let initResult: Awaited<ReturnType<typeof handleSessionInit>>;
      const isTerminalState = recovered?.status === "initialized";
      // The recovery hit source decides whether prewarm is needed (see the mirrored comment spot
      // in handler.ts).
      const needsPrewarm =
        recovered?.__recoverySource === "l2b" ||
        recovered?.__recoverySource === "history-scan";

      if (recovered && isTerminalState) {
        // Recovered from L2b/L2a — skip form, apply context
        const { buildSessionContextBlockWithToggles } = await import(
          "./session/context-injector.js"
        );
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
        // Run the state machine — reuses CB's handleSessionInit with
        // agentSource="codex". CB parses picks from `messages[]`, but codex/workbuddy
        // clients send them as `function_call_output.output` items in body.input[].
        // We use codexFormAnswersAsMessages to synthesize the outputs into minimal messages[]
        // for CB's extractor (the extractor only looks at the last user/tool message text).
        const synthesizedMessages = codexFormAnswersAsMessages(input);
        const rawOutputs = input
          .filter((it: any) => it?.type === "function_call_output")
          .map((it: any) => ({
            call_id: it.call_id,
            output_preview: String(it.output ?? "").slice(0, 200),
          }));
        if (rawOutputs.length > 0) {
          console.log(
            `[workbuddy-debug] session=${sessionKey} function_call_outputs=${JSON.stringify(rawOutputs)} synth_msgs=${JSON.stringify(synthesizedMessages).slice(0, 500)}`,
          );
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
            // Hand the raw input[] to the CB state machine to recognize the Default gate and MORE paging
            codexAnswerInput: input,
          },
          "codex", // ← state machine source: reuse the codex branch
          metadataClient,
          apiKey,
          spaceId,
          presetIdentity,
        );
      }

      if (initResult.intercepted) {
        // CB state machine interrupted → render the Responses API SSE modal with the codex form builder
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
            stream: isStream,
            modelId: initResult.formData.modelId ?? (modelId as string),
          });
        }
        // Defensive fallback
        if (initResult.response) return initResult.response;
      }

      // Default gate first hit → return a Plan-mode notice once; later turns of the same session
      // recover with bypassed=true
      if ((initResult as any).bypassReason === "default-gate") {
        pipe.info("WORKBUDDY_GATE", "Default mode gate detected → notify user (first hit)");
        const { buildMemResponse } = await import("./mem-command/response-builder.js");
        // reset-scenario gate: use tailored copy; see the same-named section in codexHandler
        const gateText = (initResult as any).resetFlow
          ? "⚠️ mem:session-reset requires Plan mode support.\n\n"
            + "The workbuddy client is not currently in Plan mode, so the asset selection form "
            + "cannot be shown. Switch to Plan mode and run mem:session-reset again."
          : "Plan mode was not enabled; asset injection is skipped for this session. "
            + "To manage Skill / Task / Agent, switch to Plan mode and start a new session."
            + "This message will be answered directly by the LLM.";
        return buildMemResponse(gateText, {
          protocol: "responses",
          stream: isStream,
          requestId: `workbuddy-gate-${Date.now()}`,
        });
      }

      if (initResult.bypassed) {
        injectionSkipped = true;
        console.log(
          `[workbuddy] session=${sessionKey} bypassed (reason=${(initResult as any).bypassReason ?? "unknown"}) → skipping injection`,
        );
        if (initResult.resetFlow) {
          _resetFlowResult = { agentName: "", agentIdShort: "", teamId: "", bypassed: true };
        }
      }

      if (!initResult.bypassed && initResult.sessionInfo) {
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
          console.warn(
            `[workbuddy] asset-capability resolve failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Prewarm pre-short-circuit: turns that hit a mem-command never forward or consume the
      // hook-cache, so prewarming anyway would waste 2-3s + 3 network requests (see handler.ts).
      let memCommandPending = false;
      if (config.memCommand?.enabled) {
        try {
          const userTextPeek = workbuddyAdapter.extractUserText(input);
          if (userTextPeek) {
            const { parseCommandFromText, isMemCommandAllowed } = await import("./mem-command/index.js");
            const peek = parseCommandFromText(userTextPeek);
            if (peek && isMemCommandAllowed(config.memCommand, peek.command)) {
              memCommandPending = true;
              console.log(`[workbuddy] prewarm skipped: mem-command pending (cmd=${peek.command}) session=${sessionKey}`);
            }
          }
        } catch (err) {
          console.warn(
            "[workbuddy] pre-prewarm peek failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

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
          console.warn(
            "[workbuddy] prewarm error:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      if (sessionInfo && !sessionInfo.space_id && spaceId) {
        sessionInfo.space_id = spaceId;
      }
      cachedAgentDetail = initResult.agentDetail ?? null;
      cachedTaskDetail = initResult.taskDetail ?? null;

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
      console.error(
        "[workbuddy] session-init error:",
        err instanceof Error ? err.message : String(err),
      );
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

  // ── 8. mem-command intercept ────────────────────────────────────────────
  if (config.memCommand?.enabled) {
    const userText = workbuddyAdapter.extractUserText(input);
    if (userText) {
      const { parseCommandFromText, isMemCommandAllowed, executeMemCommand, buildMemResponse, extractSimpleMessages, truncateArgs } =
        await import("./mem-command/index.js");
      // ⚠️ Don't use parseMemCommand(body, "workbuddy") — it only parses body.messages[]
      // (the CC/CB shape). WorkBuddy uses the Responses API (body.input[]), so it always returns
      // null → the command silently passes through to the LLM. Instead, parse userText directly
      // with parseCommandFromText, matching codexHandler.
      let memCmd = parseCommandFromText(userText);
      // session-reset is already handled by the pre-hook; skip it here to avoid double execution
      if (memCmd?.command === "session-reset") memCmd = null;
      if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
        if (!sessionInfo || injectionSkipped) {
          const errText = `⚠️ Session not initialized; the command is unavailable. Please finish session initialization (choose a Team/Agent) and retry.`;
          const errResponse = buildMemResponse(errText, {
            protocol: "responses",
            stream: isStream,
            requestId: `mem-cmd-${Date.now()}`,
          });
          console.log(
            `[workbuddy] mem-command cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} blocked: session not initialized`,
          );
          return errResponse;
        }
        pipe.info("WORKBUDDY_MEM_CMD", `mem command intercepted: ${memCmd.command}`);
        const memResult = await executeMemCommand(memCmd, {
          sessionKey,
          agentSource: "workbuddy",
          config,
          spaceId,
          userId: userId || "",
          apiKey: apiKey || "",
          sessionInfo: sessionInfo as Record<string, unknown>,
          // ⚠️ WorkBuddy uses the Responses API, same protocol as codex. Pass "responses" so
          // executeMemCommand renders the command response with the matching responses SSE skeleton.
          protocol: "responses",
          stream: isStream,
          args: memCmd.args,
          // The task command family drafts from the recent conversation. Responses API body.input[]
          // shape: { type:"message", role, content:[{type:"input_text"|"output_text", text}] }
          // extractSimpleMessages already recognizes this shape and flattens it to {role, content}.
          bodyMessages: extractSimpleMessages(input),
        });

        // ── TDAI L0 write + Skill extraction (fire-and-forget) ──
        // Aligned with codexHandler's post-mem-command archiving: the command result doesn't
        // block the response; L0 write + skill extraction + langfuse reporting fire asynchronously.
        //
        // assistantText uses memResult.messageText (the proxy's command response to the user),
        // not userText (the command the user typed). L0 write pairs "what the user asked / what
        // the system answered"; using userText as the assistant would invert the semantics.
        const memArchiveCtx = buildWorkbuddyArchiveCtx({
          config,
          sessionInfo,
          injectionSkipped,
          input,
          sessionKey,
          userId: userId || "",
          callerUserKey,
          assetCapabilities,
        });
        if (memArchiveCtx) {
          void triggerWorkbuddyArchiveHooks(memArchiveCtx, memResult.messageText ?? "").catch((err: unknown) => {
            pipe.info(
              "WORKBUDDY_MEM_ARCHIVE_ERR",
              err instanceof Error ? err.message : String(err),
            );
          });
        }

        // ── Langfuse report for mem-command ──
        const endTime = new Date().toISOString();
        try {
          langfuseReportGeneration({
            traceId: lf.traceId,
            name: `workbuddy:${modelId}:mem-${memCmd.command}`,
            model: modelId,
            startTime: startTime,
            endTime,
            input: userText ?? undefined,
            output: memResult.messageText ?? "OK",
            usage: undefined,
            traceName: lf.traceName,
            userId: lf.userId,
            sessionId: lf.sessionId,
            tags: [...lf.tags, `mem_cmd:${memCmd.command}`],
            traceInput: userText ?? undefined,
            traceOutput: memResult.messageText ?? "OK",
            observationMetadata: {
              mem_command: memCmd.command,
              protocol: "responses",
            },
          });
        } catch (err: unknown) {
          pipe.info(
            "WORKBUDDY_MEM_LANGFUSE_ERR",
            err instanceof Error ? err.message : String(err),
          );
        }

        console.log(
          `[workbuddy] mem-command cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} success=${memResult.success}`,
        );
        return memResult.response;
      }
    }
  }

  // ── 9. Asset injection (runs every turn) ─────────────────────────────────
  if (
    !injectionSkipped &&
    sessionInfo &&
    config.injection?.enabled &&
    (config.injection.injectors?.length ?? 0) > 0
  ) {
    try {
      const { getInjectionPipeline } = await import("./injection/index.js");
      const pipeline = getInjectionPipeline(config);
      const { buildSessionContextBlockWithToggles } = await import(
        "./session/context-injector.js"
      );
      const sessionContextBlock = buildSessionContextBlockWithToggles(
        cachedAgentDetail as import("./session/types.js").AgentDetail | null,
        cachedTaskDetail as import("./session/types.js").TaskDetail | null,
        config.sessionInit,
        sessionKey,
      );

      // Build a synthetic OpenAI body for the generic pipeline to process
      const syntheticBody: Record<string, unknown> = {
        messages: [
          { role: "system", content: sessionContextBlock ?? "" },
          { role: "user", content: userQuery || "." },
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
        turnSeq,
        requestPath: path,
        custom: {
          session: sessionInfo,
          userKey: callerUserKey ?? undefined,
          assetCapabilities,
        },
      });

      const injectedMessages = injectedBody.messages as
        | Array<Record<string, unknown>>
        | undefined;
      const sysMsg = injectedMessages?.[0];
      const injectedText = typeof sysMsg?.content === "string" ? sysMsg.content : "";

      if (injectedText.length > 0) {
        body = injectWorkbuddyAssets(body, { raw: injectedText });
      }
    } catch (err: unknown) {
      console.error(
        "[workbuddy] injection pipeline error:",
        err instanceof Error ? err.message : String(err),
      );
      // Degrade gracefully: forward without injection
    }
  }

  // ── 10. Forward ──────────────────────────────────────────────────────────
  const archiveCtx = buildWorkbuddyArchiveCtx({
    config,
    sessionInfo,
    injectionSkipped,
    input,
    sessionKey,
    userId: userId || "",
    callerUserKey,
    assetCapabilities,
  });
  return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, lf, archiveCtx);
}
