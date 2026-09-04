/**
 * Anthropic Messages API handler.
 * Supports /v1/messages endpoint with streaming (SSE) and non-streaming modes.
 * Integrates with routing module, Opik observability, and JSONL logging.
 *
 * This handler uses ForwardTarget opaquely — no routing semantics
 * leak into the handler. All routing logic is encapsulated in the private module.
 */

import type { Context } from "hono";
import { createHash } from "node:crypto";
import { writeLog, createPipeline } from "./logger.js";
import {
  apiKeyToKeyId,
  opikCreateLlmSpan,
  opikCreateTrace,
  uuidv7,
} from "./opik.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "./langfuse.js";
import { countHumanTurns } from "./turnSeq.js";
import type { ProxyConfig } from "./types.js";
import {
  resolveForwardTarget,
  resolveSessionKey,
  resolveLatestUserQuery,
  reportAnalyzerTrace,
  type ForwardTarget,
} from "./guard-adapter.js";
import { hasCostGuardMarker, matchWhitelistEndpoint } from "./routes/whitelist.js";
import { writeRequestLog } from "./requestLog.js";
import { prepareUpstreamRequest, notifyUpstreamResponse } from "./request-prepare-adapter.js";
import { tryReportCreditFromPath, extractSpaceIdFromPath } from "./credit-reporter.js";
import { resolveModelId, isModelInPricing } from "./pricing.js";
import { inspectAndRecord } from "./identity.js";
import { writeFailedReportRaw } from "./clickhouse.js";
import { verifyUserKey } from "./auth.js";
import { matchSystemUserByUserId, hasSystemUsers } from "./systemUser.js";
import { handleSystemUserPassthrough } from "./systemUserPassthrough.js";
import { TdaiClient } from "./tdai/client.js";
import { deriveTdaiIdentity } from "./tdai/identity.js";
import { extractLatestUserMessage, recordTdaiTurn } from "./tdai/recorder.js";
import { trackWrite, withL0Retry } from "./tdai/pending-writes.js";
import type { TdaiIdentity, TdaiMessage } from "./tdai/types.js";
import { triggerSkillExtractIfReady } from "./skill/handler-glue.js";
import { emitModelIntentTelemetry } from "./session/model-intent-telemetry.js";
import { isExtractionAllowed, logExtractionSkipped } from "./extraction-gate.js";
import type { CcRequestKind } from "./common/cc-request-classifier.js";
import { buildRequestDebugMetadata } from "./common/langfuse-debug.js";
import { resolveAgentAdapter } from "./agent-adapters/index.js";
import {
  enforceRateLimit,
  isRateLimitExceededError,
  recordInputTokenUsage,
} from "./rate-limit/guard.js";

const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  // Internal identity header is only used by proxy/session-init and must not be forwarded upstream.
  "x-tdai-user-key",
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);

/**
 * Build a per-request TdaiClient. `spaceId` (extracted from the request path
 * `/{agent}/{spaceId}/...`) overrides `config.tdai.serviceId` so writes/recalls
 * land on the correct kernel tenant. Falls back to config when the request
 * carries no spaceId (older single-tenant deployments).
 */
function createTdaiClient(config: ProxyConfig, spaceId?: string): TdaiClient | null {
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
 * Normalize Anthropic top-level `system` field into a plain string for
 * observability. Anthropic accepts either a string or an array of content
 * blocks; here we join `text` blocks' text with "\n" and JSON-stringify
 * anything else. Returns "" when nothing textual is present.
 */
function stringifyAnthropicSystem(system: unknown): string {
  if (system === undefined || system === null) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const block of system) {
      const b = block as Record<string, unknown>;
      if (b && b.type === "text" && typeof b.text === "string" && b.text) {
        parts.push(b.text);
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(system);
}

/**
 * Build the `input` payload for Langfuse / Opik. Two modes:
 *
 * - Normal mode (default): calls `flattenAnthropicMessagesForOpik` — content
 *   arrays are stringified for compact display. Loses `cache_control` markers,
 *   `thinking` blocks with signatures, native `tool_use`/`tool_result` shape.
 *
 * - Debug mode (`langfuse.debug=true`): passes the raw Anthropic body straight
 *   through, preserving every native structure. Use when investigating cache
 *   markers, thinking-signature issues, or request classification. Costs 2-5x
 *   more upload bandwidth + Langfuse storage — leave off in production.
 */
export function buildLangfuseInput(
  messages: unknown[],
  system: unknown,
  debug: boolean,
): unknown {
  if (debug) {
    // Preserve original shape end-to-end. Prepend a synthetic system message
    // when it's non-empty so the display order matches other consumers.
    const out: unknown[] = [];
    if (system !== undefined && system !== null && system !== "") {
      out.push({ role: "system", content: system });
    }
    return out.concat(messages);
  }
  return flattenAnthropicMessagesForOpik(messages, system);
}

/**
 * Flatten Anthropic messages for Opik / Langfuse display.
 *
 * Anthropic puts the system prompt on `body.system` (not inside `messages`),
 * so callers should pass it explicitly — otherwise the reported input omits
 * the system prompt entirely. When provided and non-empty, a synthetic
 * `{role:"system", content}` message is prepended to the result.
 */
export function flattenAnthropicMessagesForOpik(
  messages: unknown[],
  system?: unknown,
): unknown[] {
  const result: unknown[] = [];
  const systemText = stringifyAnthropicSystem(system);
  if (systemText) {
    result.push({ role: "system", content: systemText });
  }
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    if (typeof content === "string") {
      result.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      result.push({ role, content: JSON.stringify(content) });
      continue;
    }

    if (role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_use") {
          toolCalls.push(b);
        } else if (b.type === "thinking" && b.thinking) {
          textParts.push(`[thinking] ${(b.thinking as string).slice(0, 200)}`);
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "assistant", content: textParts.join("\n") });
      }
      for (const tc of toolCalls) {
        const t = tc as Record<string, unknown>;
        const inputStr = typeof t.input === "string" ? t.input : JSON.stringify(t.input);
        result.push({
          role: "assistant",
          content: JSON.stringify({ tool_call_id: t.id, tool_name: t.name, input: inputStr }, null, 2),
        });
      }
    } else if (role === "user") {
      const textParts: string[] = [];
      const toolResults: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_result") {
          toolResults.push(b);
        } else {
          textParts.push(JSON.stringify(b));
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }
      for (const tr of toolResults) {
        const t = tr as Record<string, unknown>;
        let resultContent: string;
        if (typeof t.content === "string") {
          resultContent = t.content;
        } else if (Array.isArray(t.content)) {
          resultContent = (t.content as Record<string, unknown>[])
            .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
        } else {
          resultContent = JSON.stringify(t.content);
        }
        result.push({
          role: "tool",
          content: JSON.stringify({ tool_call_id: t.tool_use_id, is_error: t.is_error ?? false, result: resultContent }, null, 2),
        });
      }
    } else {
      const merged = content.map((b: unknown) => {
        const block = b as Record<string, unknown>;
        if (block.type === "text") return block.text as string;
        return JSON.stringify(block);
      }).join("\n");
      result.push({ role, content: merged });
    }
  }
  return result;
}

/** Extract Anthropic API key from request headers (x-api-key or Authorization Bearer). */
function extractApiKey(c: Context): string {
  const xApiKey = c.req.header("x-api-key");
  if (xApiKey) return xApiKey;

  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return "";
}

/**
 * Heuristically decide whether a `thinking` block carries a valid native
 * Anthropic/Bedrock signature.
 */
function hasValidThinkingSignature(block: Record<string, unknown>): boolean {
  const sig = block.signature;
  if (typeof sig !== "string" || sig.length < 40) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sig)) {
    return false;
  }
  return /^[A-Za-z0-9+/=]+$/.test(sig);
}

/**
 * Sanitize `thinking` blocks across all assistant messages.
 *
 * Exported for unit testing.
 */
export function sanitizeThinkingBlocks(
  body: Record<string, unknown>,
): { body: Record<string, unknown>; removed: number } {
  const messages = body.messages;
  if (!Array.isArray(messages)) return { body, removed: 0 };

  let removed = 0;
  let changed = false;

  const newMessages = messages.map((msg) => {
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant" || !Array.isArray(m.content)) return msg;

    let msgChanged = false;
    const newContent = (m.content as unknown[]).filter((block) => {
      const b = block as Record<string, unknown>;
      const isThinking = b.type === "thinking" || b.type === "redacted_thinking";
      if (!isThinking) return true;
      if (hasValidThinkingSignature(b)) return true;
      removed += 1;
      msgChanged = true;
      return false;
    });

    if (!msgChanged) return msg;
    changed = true;
    return { ...m, content: newContent };
  });

  if (!changed) return { body, removed: 0 };
  return { body: { ...body, messages: newMessages }, removed };
}

/**
 * Build upstream body from original body + cost guard overrides.
 */
function buildUpstreamBody(
  body: Record<string, unknown>,
  target: ForwardTarget,
): { body: Record<string, unknown>; sanitizedCount: number } {
  let result = body;
  if (target.bodyOverrides) {
    result = { ...result, ...target.bodyOverrides };
  }
  const sanitized = sanitizeThinkingBlocks(result);
  return { body: sanitized.body, sanitizedCount: sanitized.removed };
}

/**
 * Build upstream headers from request headers + cost guard auth overrides.
 */
function buildUpstreamHeaders(
  c: Context,
  _config: ProxyConfig,
  target: ForwardTarget,
  sessionKey?: string,
  effectiveApiKey?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  headers["content-type"] = "application/json";

  // `effectiveApiKey` is pre-resolved by the caller according to the
  // per-agent fallback rule (see the resolveEffectiveApiKey call site).
  //   - non-empty string → inject as server-side key, drop client's own
  //   - empty/undefined  → passthrough: keep whatever the client sent
  // The cost-guard extension can still fully override via target.authHeaders.
  if (effectiveApiKey && !target.authHeaders) {
    headers["x-api-key"] = effectiveApiKey;
    delete headers["authorization"];
  }

  if (target.authHeaders) {
    for (const [k, v] of Object.entries(target.authHeaders)) {
      headers[k] = v;
      if (k === "x-api-key") delete headers["authorization"];
      if (k === "authorization") delete headers["x-api-key"];
    }
  }

  if (sessionKey) {
    headers["x-vertex-ai-session-id"] = sessionKey;
  }
  return headers;
}

/**
 * Forward request to upstream and handle retry if retryTarget is set.
 */
async function forwardWithRetry(
  target: ForwardTarget,
  upstreamHeaders: Record<string, string>,
  upstreamBody: Record<string, unknown>,
  originalBody: Record<string, unknown>,
  originalHeaders: Record<string, string>,
  pipe: ReturnType<typeof createPipeline>,
  forwardTimeoutMs: number,
  sessionKeyForDebug?: string,
  rateLimitContext?: { config: ProxyConfig; instanceId?: string },
): Promise<{ resp: Response; retried: boolean }> {
  let upstreamResp: Response | undefined;
  let forwardFailed = false;

  // ── Optional outbound body md5 debug log ───────────────────────────────
  // Used for long-term stability observation: Anthropic KV cache hit requires
  // "all bytes from body header up to the cache_control anchor must be identical".
  // Therefore, three MD5 segments are computed separately:
  //   1. sysFullMd5    — md5(JSON.stringify(body.system))  Full system serialization
  //   2. sysStrMd5     — md5(flattened system string)       Text content only (for comparison)
  //   3. msgsPrefixMd5 — Find index N of the last message containing cache_control,
  //                      md5(JSON.stringify(messages[0..N])), which is the actual cache prefix
  //   4. msgsAnchorIdx — The index N above (helps locate the hit length)
  //
  // Any change in these MD5 values implies an Anthropic cache miss.
  //
  // Enable via: PROXY_DEBUG_DUMP_OUTBOUND_MD5=1 node ...
  if (process.env.PROXY_DEBUG_DUMP_OUTBOUND_MD5) {
    try {
      const sys = (upstreamBody as { system?: unknown }).system;
      // Anthropic system prompt is usually a string (CC) or an array of blocks (some SDKs)
      const sysFullStr = sys === undefined ? "" : JSON.stringify(sys);
      const sysTextStr = typeof sys === "string"
        ? sys
        : Array.isArray(sys)
          ? sys.map((b) => (b as { text?: string }).text ?? "").join("\n")
          : "";

      const msgs = (upstreamBody as { messages?: Array<Record<string, unknown>> }).messages ?? [];
      // Find the index of the last message containing "cache_control" in content
      let anchorIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const content = msgs[i]?.content;
        if (Array.isArray(content)) {
          const hasCache = content.some((b) => b && typeof b === "object" && "cache_control" in (b as object));
          if (hasCache) { anchorIdx = i; break; }
        }
      }
      // cache prefix = serialization of all messages from body start up to anchor (inclusive)
      const prefixEnd = anchorIdx >= 0 ? anchorIdx + 1 : msgs.length;
      const msgsPrefixStr = JSON.stringify(msgs.slice(0, prefixEnd));

      const sysFullMd5 = createHash("md5").update(sysFullStr).digest("hex").slice(0, 12);
      const sysTextMd5 = createHash("md5").update(sysTextStr).digest("hex").slice(0, 12);
      const msgsPrefixMd5 = createHash("md5").update(msgsPrefixStr).digest("hex").slice(0, 12);

      // eslint-disable-next-line no-console
      console.log(
        `[outbound-md5] session=${sessionKeyForDebug ?? "?"} sysBytes=${sysFullStr.length} sysFullMd5=${sysFullMd5} sysTextMd5=${sysTextMd5} msgsCount=${msgs.length} msgsAnchorIdx=${anchorIdx} msgsPrefixBytes=${msgsPrefixStr.length} msgsPrefixMd5=${msgsPrefixMd5}`,
      );
    } catch (e) {
      // Best-effort; debug logging should not crash the flow
      // eslint-disable-next-line no-console
      console.log(`[outbound-md5] session=${sessionKeyForDebug ?? "?"} <error: ${(e as Error).message}>`);
    }
  }

  if (rateLimitContext) {
    await enforceRateLimit({
      config: rateLimitContext.config,
      instanceId: rateLimitContext.instanceId,
      modelId: target.model,
      protocol: "anthropic",
    });
  }
  try {
    upstreamResp = await fetch(target.url, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(forwardTimeoutMs),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      pipe.error("FORWARD", `Timeout after ${forwardTimeoutMs / 1000}s`);
    } else {
      pipe.error("FORWARD", err);
    }
    forwardFailed = true;
  }

  if (upstreamResp) {
    pipe.forwardDone(upstreamResp.status);
  }

  const shouldRetry = target.retryTarget &&
    (forwardFailed || (upstreamResp && upstreamResp.status >= 400 && upstreamResp.status < 500));

  if (shouldRetry && target.retryTarget) {
    const reason = forwardFailed ? "timeout/error" : `${upstreamResp!.status}`;
    pipe.info("RETRY", `Routed model failed (${reason}), retrying with ${target.retryTarget.model}`);

    const retryHeaders: Record<string, string> = { ...originalHeaders };
    retryHeaders["content-type"] = "application/json";
    if (sessionKeyForDebug) {
      retryHeaders["x-vertex-ai-session-id"] = sessionKeyForDebug;
    }

    try {
      if (rateLimitContext) {
        await enforceRateLimit({
          config: rateLimitContext.config,
          instanceId: rateLimitContext.instanceId,
          modelId: target.retryTarget.model,
          protocol: "anthropic",
        });
      }
      upstreamResp = await fetch(target.retryTarget.url, {
        method: "POST",
        headers: retryHeaders,
        body: JSON.stringify(originalBody),
        signal: AbortSignal.timeout(forwardTimeoutMs),
      });
      if (upstreamResp.ok) {
        pipe.info("RETRY_SUCCESS", `Retry returned ${upstreamResp.status}`);
      } else {
        pipe.error("RETRY_FAILED", `Retry returned ${upstreamResp.status}`);
      }
      return { resp: upstreamResp, retried: true };
    } catch (retryErr: unknown) {
      if (isRateLimitExceededError(retryErr)) throw retryErr;
      if (retryErr instanceof DOMException && retryErr.name === "TimeoutError") {
        pipe.error("RETRY_FORWARD", `Timeout after ${forwardTimeoutMs / 1000}s`);
      } else {
        pipe.error("RETRY_FORWARD", retryErr);
      }
      throw new Error("Upstream request failed");
    }
  }

  if (forwardFailed && !shouldRetry) {
    throw new Error("Upstream request failed");
  }

  if (!upstreamResp) {
    throw new Error("No upstream response available");
  }

  return { resp: upstreamResp, retried: false };
}

/** Main handler for POST /v1/messages (Anthropic Messages API). */
export async function handleAnthropicMessages(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const startTime = new Date().toISOString();
  const traceId = uuidv7();

  // ── Early auth ──────────────────────────────────────────────────────────
  // Verify BEFORE parsing the body so a rejected caller never triggers body
  // parsing or the alias-gate. `earlyVerify.userId` is reused later for
  // both the systemUser short-circuit and the normal pipeline.
  const earlyApiKey = extractApiKey(c);
  const earlySpaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const earlyVerify = await verifyUserKey(earlyApiKey, earlySpaceId);
  if (earlyVerify.rejected) {
    return c.json({ type: "error", error: { type: "authentication_error", message: `Authentication failed: ${earlyVerify.rejectReason ?? "unknown"}` } }, 401);
  }

  // ── Parse body ──────────────────────────────────────────────────────────
  // Body is parsed BEFORE the systemUser short-circuit so the alias-gate and
  // `resolveModelId` fire uniformly for internal AND external callers. The
  // parsed object is later handed to `handleSystemUserPassthrough` (which
  // serialises it) so we never double-read `c.req`.
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // ── CC request classification (feature-gated, per-agent) ─────────────────
  // Classify request via agentAdapter — each client has its own rules:
  //   - claude-code: Three-way split based on cache_control marker + tools/thinking
  //   - codebuddy / unknown: Always main (unadapted, equivalent to current behavior)
  //
  // When ccRequestRouting.enabled is off, force as main and follow legacy pipeline.
  // See docs/design/2026-07-30-cc-request-routing-plan.md for details.
  const _pathPartsEarly = c.req.path.split("/").filter(Boolean);
  const _agentFromPathEarly = _pathPartsEarly[0]
    && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(_pathPartsEarly[0])
    ? _pathPartsEarly[0] : undefined;
  const agentAdapter = resolveAgentAdapter(_agentFromPathEarly ?? "claude-code");
  const ccRoutingEnabled = config.ccRequestRouting?.enabled === true;
  const requestKind: CcRequestKind = ccRoutingEnabled ? agentAdapter.classifyRequest(body) : "main";

  // ── Model gate: reject requests whose `model` is not a registered display name ──
  // When pricing table is configured, client `model` must match the `modelName`
  // (display name, case-insensitive) of an entry. Real model_id is an internal detail
  // and not exposed to clients. Mismatches return 400 immediately to avoid unbilled
  // requests. Skipped when pricing table is empty (backwards compatible).
  //
  // Internal/external users are treated equally — internal callers must also request by
  // `modelName`, ensuring upstream ids and billing/observability keys align
  // across all traffic.
  const requestedModel = typeof body.model === "string" ? body.model : "unknown";
  if (!isModelInPricing(config.creditPricing, requestedModel)) {
    return c.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Model '${requestedModel}' is not a registered display name in the credit pricing table`,
        },
      },
      400,
    );
  }

  // ── Model alias: rewrite client-facing modelName → real model_id ──────────
  // Clients may put a human-readable name (e.g. "claude-opus-4.7") in `model`;
  // resolve it back to the real upstream model_id (e.g. "ep-pksklwtb") BEFORE
  // routing / logging / forwarding, so model_id stays the canonical identity
  // across the whole pipeline. No-op when `model` is already a real id/unknown.
  const modelId = resolveModelId(config.creditPricing, requestedModel);
  const modelAliasApplied = typeof body.model === "string" && modelId !== requestedModel;
  if (modelAliasApplied) body.model = modelId;

  // ── System-user short-circuit ────────────────────────────────────────────
  // Internal service accounts (see `systemUsers` config) bypass the entire
  // pipeline: no session-init, no injection, no routing. Matching key is
  // the userId resolved by verifyUserKey — NOT the raw apiKey. Auth-disabled
  // requests (userId == "") never match, so the short-circuit is inert unless
  // auth is on.
  //
  // We hand the already-parsed+alias-resolved `body` to the passthrough so
  // upstream sees the canonical model_id, aligning internal traffic with
  // external.
  if (hasSystemUsers()) {
    const sysMatch = matchSystemUserByUserId(earlyVerify.userId);
    if (sysMatch) {
      return handleSystemUserPassthrough(c, config, sysMatch, body);
    }
  }

  let messages = Array.isArray(body.messages) ? body.messages : [];
  const isStream = body.stream === true;
  let hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // ── Resolve agent source from URL path (e.g. /claude-code/v1/messages) ──
  const pathParts = c.req.path.split("/").filter(Boolean);
  const agentFromPath = pathParts[0] && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(pathParts[0])
    ? pathParts[0] : undefined;
  const agentSource = agentFromPath ?? "claude-code";

  // ── Identity inspection ──────────────────────────────────────────────────
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    reqHeaders[k] = v;
  }
  inspectAndRecord("POST", c.req.path, reqHeaders, body as Record<string, unknown>, agentSource);

  // ── Resolve apiKey → project name ──────────────────────────────────────
  const apiKey = extractApiKey(c);
  let keyId = apiKey ? apiKeyToKeyId(apiKey) : "unknown";

  // ── Lowercased headers for agent profile detection + session key ──────────
  const lcHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    lcHeaders[k.toLowerCase()] = v;
  }

// ── Session key: prefer conversation header, fallback to agent profile ───────────
  const { resolveConversationId } = await import("./session/session-key.js");
  const conversationId = resolveConversationId(c);
  const sessionKey = conversationId ?? resolveSessionKey(config, lcHeaders, c.req.path, body, keyId);

  // ── Auth verification (user_key → user_id) ──────────────────────────────────────
  // Reuse the early verify result — it ran before body parse to decide the
  // system-user short-circuit; running verify again here would double the
  // network round-trip for every request.
  const spaceId = earlySpaceId;
  const userId = earlyVerify.userId
    || c.req.header("x-user-id")
    || c.req.header("x-cb-user-id")
    || c.req.header("x-tdai-user-token")
    || "";
  if (userId) keyId = userId;

  // sk-mem key (used as x-tdai-user-key for TDAI ACL / MetadataClient) is the incoming apiKey.
  const callerUserKey = apiKey || null;

  // Activate Redis storage early — must run BEFORE session init.
  if (config.redis?.enabled) {
    const { getInjectionPipeline } = await import("./injection/index.js");
    getInjectionPipeline(config);
  }

  // ── mem:session-reset pre-hook ──
  let _isSessionResetFlow = false;
  if (config.memCommand?.enabled && requestKind === "main") {
    const { isSessionResetCommand } = await import("./mem-command/pre-intercept.js");
    if (isSessionResetCommand(body as Record<string, unknown>, agentSource)) {
      const { isMemCommandAllowed, parseMemCommand } = await import("./mem-command/index.js");
      const memCmd = parseMemCommand(body as Record<string, unknown>, agentSource);
      if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
        const { getSessionStore } = await import("./session/store.js");
        const store = getSessionStore();
        const compositeKey = `${agentSource}:${sessionKey}`;
        store.bind(compositeKey, { userId: userId || "anonymous", agentSource, sessionId: sessionKey, spaceId });

        // ── Force-archive skill buffer for old agent (best-effort) ──
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
        _isSessionResetFlow = true;
        console.log(`[mem-command:pre] session-reset session=${sessionKey} → falling through to pop form`);
      }
    }
  }

  // ── Session Init (before injection pipeline) ─────────────────────────────
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("./injection/types.js").AssetCapabilityFlags | undefined;
  let injectedSkipped = !conversationId;
  let sessionJustRegistered = false;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;
  console.log(`[injection-debug] conversationId=${conversationId} sessionKey=${sessionKey} userId=${userId} agentSource=${agentSource} sessionInitEnabled=${config.sessionInit?.enabled} injectionEnabled=${config.injection?.enabled} injectors=${JSON.stringify(config.injection?.injectors)} injectedSkipped=${injectedSkipped}`);
  // CC traffic split: SIDEQUERY completely skips session-init (isolated small request without session concept).
  //                   FORK allows running L2b recovery to reuse MAIN's established session, but does not enter form interaction
  //                   (borrows MAIN's sessionInfo, see kind === 'fork' branch protection below).
  const skipSessionInit = requestKind === "sidequery";
  if (config.sessionInit?.enabled && conversationId && !skipSessionInit) {
    try {
      const { getSessionStore, handleSessionInit, parsePresetIdentity } = await import("./session/index.js");
      const { getMetadataClient } = await import("./meta/client.js");
      const store = getSessionStore();
      const metadataClient = getMetadataClient(config.coreSkill, spaceId, apiKey);
      const presetIdentity = parsePresetIdentity(config.sessionInit, lcHeaders);

      // ── Session Recovery: try L2b binding before falling into session-init form ──
      const compositeKey = `${agentSource}:${sessionKey}`;
      // Identity for repo/binding writes. Fallback to `anonymous` composite key
      // when userId is missing, ensuring valid key path segments (see §4.4 edge cases).
      const identity = {
        userId: userId || "anonymous",
        agentSource,
        sessionId: sessionKey,
        spaceId,
      };
      const recovered = await store.getOrRecover(compositeKey, identity, {
        metadataClient,
        messages: body.messages as Array<Record<string, unknown>> ?? [],
        presetIdentity,
      });

      let initResult: Awaited<ReturnType<typeof handleSessionInit>>;
      // Only treat the session as "recovered" when it's in a terminal state
      // (initialized or bypassed). Pending / mid-form states MUST fall through
      // to handleSessionInit so the state machine can advance to the next form.
      const isTerminalState = recovered?.status === "initialized";
      // Tracks whether this turn executed the handleSessionInit state machine — used to precisely determine
      // `sessionJustRegistered` semantics ("session init state machine reached terminal state transition in this turn").
      // Covers two terminal states:
      //   - Normal registration complete (justRegistered=true set by completeRegistration)
      //   - Bypass (branches like user selecting "No", maxRetries, no-agent, also carry justRegistered=true)
      // This allows the mem-command interceptor at turn N asset-confirm to inspect the first user message via checkFirst fallback,
      // recognizing the initial mem: command (where sessionInfo=null → takes "uninitialized" fallback response),
      // preventing it from being passed through to the LLM.
      // Safeguard: Case 3 (stable initialized+bypassed state) regular returns do NOT carry justRegistered,
      // so subsequent turns will not repeatedly check the first history item; L2b recovery branch borrowing
      // justRegistered=true is only to trigger downstream prewarm, unrelated to state machine, where
      // wentThroughSessionInitStateMachine=false naturally filters it out.
      let wentThroughSessionInitStateMachine = false;
      // Recovery hit source determines whether prewarm is needed (see detailed note at symmetric location in handler.ts).
      const needsPrewarm =
        recovered?.__recoverySource === "l2b" ||
        recovered?.__recoverySource === "history-scan";
      if (recovered && isTerminalState) {
        // Recovery hit: keep original messages, only re-inject <session_context>
        // so this turn's system prompt carries agent/task context again.
        // User conversation is always preserved as-is, including session_init form interactions — no deletions.
        // Anthropic protocol: system lives on body.system (not in messages),
        // so we hand systemAppend back through the initResult and let the
        // shared apply-block below merge it into body.system.
        const { buildSessionContextBlockWithToggles } = await import("./session/context-injector.js");
        const inMsgs = (body.messages as Array<Record<string, unknown>>) ?? [];
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
          messages: inMsgs as Record<string, unknown>[],
          systemAppend,
          sessionInfo: recovered.sessionInfo,
          agentDetail: recovered.agentDetail,
          taskDetail: recovered.taskDetail,
          bypassed: recovered.bypassed,
          justRegistered: needsPrewarm, // Trigger prewarm only on L2b / history-scan recovery
        };
      } else if (requestKind === "fork") {
        // FORK borrows MAIN's established session. An L2b miss indicates MAIN hasn't completed init yet — rare case.
        // Conservatively treat fork request as no-op (no intercept, no message modification), passing raw request to upstream.
        // The worst outcome is MAIN missing sessionInfo (equivalent to disabling session-init), no worse.
        console.log(`[session-init:cc:fork] session=${compositeKey} L2b miss on fork request → passthrough`);
        initResult = { intercepted: false, messages: body.messages as Record<string, unknown>[] };
      } else {
        wentThroughSessionInitStateMachine = true;
        initResult = await handleSessionInit(
          sessionKey,
          userId || null,
          body.messages as Array<Record<string, unknown>> ?? [],
          config.sessionInit,
          store,
          { stream: isStream, modelId: modelId as string, protocol: "anthropic" },
          agentSource,
          metadataClient,
          apiKey,
          spaceId,
          presetIdentity,
        );
      }

      if (initResult.intercepted && initResult.response) {
        return initResult.response;
      }

      console.log(`[injection-debug] initResult session=${sessionKey} intercepted=${initResult.intercepted} bypassed=${initResult.bypassed} justRegistered=${initResult.justRegistered} resetFlow=${initResult.resetFlow} hasSessionInfo=${!!initResult.sessionInfo} hasAgentDetail=${!!initResult.agentDetail}`);
      // sessionJustRegistered is used by mem-command checkFirst fallback (in the turn of the last session init
      // step "pending_task_select → initialized", executing the user's original mem: command).
      // **CRITICAL**: Only branches executing the handleSessionInit state machine inherit justRegistered;
      // L2b recovery branch's justRegistered=true is merely a rebuild signal for downstream prewarm, not session init,
      // so sessionJustRegistered is not set here — otherwise mem-command would inspect the first history user message
      // every turn, executing the initial mem:help repeatedly.
      if (wentThroughSessionInitStateMachine && initResult.justRegistered) sessionJustRegistered = true;
      if (initResult.bypassed) {
        injectedSkipped = true;
        console.log(`[session-init] session=${sessionKey} bypassed → skipping all injection`);
        // User chose "skip" in reset flow → also return confirmation message instead of forwarding to LLM
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
          console.log(`[asset-capability] user=${(initResult.sessionInfo as { user_id?: string }).user_id ?? "-"} flags=${JSON.stringify(assetCapabilities)}`);
        } catch (err) {
          console.warn(`[asset-capability] resolve failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Prewarm early short-circuit: Turns matching mem-command do not forward upstream nor consume
      // hook-cache; prewarming as usual would waste 2-3s + 3 network requests. See detailed note at symmetric location in handler.ts.
      // fork/sidequery are not short-circuited (only effective when requestKind === "main").
      let memCommandPending = false;
      if (config.memCommand?.enabled && requestKind === "main") {
        try {
          const { parseMemCommand, isMemCommandAllowed } = await import("./mem-command/index.js");
          let peek = parseMemCommand(body as Record<string, unknown>, agentSource);
          if (!peek && sessionJustRegistered) {
            peek = parseMemCommand(body as Record<string, unknown>, agentSource, { checkFirst: true });
          }
          if (peek && isMemCommandAllowed(config.memCommand, peek.command)) {
            memCommandPending = true;
            console.log(`[hook-cache] prewarm skipped: mem-command pending (cmd=${peek.command}) session=${sessionKey}`);
          }
        } catch (err) {
          console.warn(
            "[mem-command] pre-prewarm peek failed (anthropic):",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Await prewarm so the first-turn pipeline always hits the cache.
      // A fire-and-forget void() here caused the bug where the pipeline
      // ran before the cache was populated, silently injecting zero
      // blocks for the entire first turn.
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
          // When resetFlow=true, agent is switched during clearBefore:session-reset;
          // old agent's skill/wiki/knowledge cache must be cleared before writing new cache to avoid stale injections.
          // Always clearBefore: initial init cache is empty so clearing is a no-op;
          // clearing old agent cache during reset-flow is essential. Unified semantics are safer.
          await mod.prewarmFromConfig(config, {
            keyId: sessionKey,
            userId: userId || "anonymous",
            agentSource,
            spaceId,
            sessionInfo: initResult.sessionInfo as import("./session/types.js").SessionInfo,
            agentDetail: initResult.agentDetail ?? null,
            taskDetail: initResult.taskDetail ?? null,
            assetCapabilities,
            // Pass through caller's sk-mem key for TDAI ACL verification during prewarm (x-tdai-user-key)
            callerUserKey: callerUserKey ?? undefined,
          }, { clearBefore: true });
        } catch (err) {
          console.warn(
            "[hook-cache] handler prewarm error (anthropic):",
            err instanceof Error ? err.message : String(err),
          );
          // Don't re-throw: the pipeline's resolveHookBlocks has its own
          // cache-miss → execute() fallback as a safety net (see pipeline.ts).
        }
      }

      if (initResult.messages) {
        body = { ...body, messages: initResult.messages };
        messages = initResult.messages as unknown[];
      }

      // Anthropic: apply the session-context block onto body.system. The init
      // module cannot see body.system (it's a handler-layer concern), so it
      // hands the pre-built block back through `systemAppend` and we merge it
      // here with the same append helper used by the direct-inject path.
      if (initResult.systemAppend) {
        const { appendBlockToAnthropicSystem } = await import("./session/context-injector.js");
        body = { ...body, system: appendBlockToAnthropicSystem(body.system, initResult.systemAppend) };
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      // Legacy sessions persisted before space_id was tracked will hydrate
      // with an empty space_id. Restore it from the URL each request so
      // downstream skill / knowledge / injection paths route to the correct
      // kernel tenant instead of falling back to `context-proxy` (500).
      if (sessionInfo && !sessionInfo.space_id && spaceId) {
        sessionInfo.space_id = spaceId;
      }

      // Record resetFlow to outer scope for returning confirmation response
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
      console.error("[session-init] Error in handleSessionInit (anthropic):", err instanceof Error ? err.message : String(err));
      sessionInfo = undefined;
      injectedSkipped = true;
    }
  }

  // ── mem:session-reset completion confirmation ─────────────────────────────
  // session-reset interaction flow: pre-hook changes state → form pops up → user submits form →
  // completeRegistration → prewarm → reached here. The user's original message "mem:session-reset"
  // is still in body.messages; if not intercepted, it would be forwarded to LLM causing uncontrolled output.
  // Command execution is complete (new agent bound, cache refreshed) → return confirmation text without hitting LLM.
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
    const thinkingEnabled = !!(body as Record<string, unknown>).thinking;
    console.log(`[mem-command:session-reset] completed: bypassed=${!!bypassed} agent=${agentName} (${agentIdShort})`);
    return buildMemResponse(text, {
      protocol: "anthropic",
      stream: isStream,
      requestId: `mem-reset-${Date.now()}`,
      thinking: thinkingEnabled,
    });
  }

  // ── mem: command intercept ────────────────────────────────────────────────
  // Intercept after session init completes and before injection pipeline.
  // On hit: execute command → write L0 → trigger skill extract → return synthetic response.
  // Skips injection (preserves KV cache) and upstream forwarding (zero token cost).
  // When memCommand.enabled is false, this section is skipped entirely, taking the normal path.
  //
  // parseMemCommand uses agentAdapter.extractUserText to extract user input according to client rules:
  //   - claude-code: takes the last text block (skipping <system-reminder> prefix metadata)
  //   - codebuddy / unknown: falls back to conservative "concatenate all text" logic
  //
  // CC split: FORK/SIDEQUERY are internally constructed requests by CC client; last_user won't start with `mem:`,
  //           and synthetic responses would break fork requests' cache assumptions depending on MAIN. Skip interception.
  if (config.memCommand?.enabled && requestKind === "main") {
    const { parseMemCommand, isMemCommandAllowed, executeMemCommand, buildMemResponse, extractSimpleMessages, truncateArgs } = await import("./mem-command/index.js");
    // Normal check: last user message
    let memCmd = parseMemCommand(body as Record<string, unknown>, agentSource);
    // When session init state machine reaches terminal state (initialized or bypass) in this turn,
    // the last user message is the form response (e.g. "No"). Check first user message additionally
    // — the user's initial intent. In bypass scenarios, sessionInfo=null takes the "uninitialized"
    // fallback response, preventing the initial mem: command from being swallowed into history and passed to LLM.
    if (!memCmd && sessionJustRegistered) {
      memCmd = parseMemCommand(body as Record<string, unknown>, agentSource, { checkFirst: true });
    }
    // session-reset was already handled in pre-hook (state set to uninitialized → session-init form pops up
    // → user submits form → completeRegistration triggers _resetFlowResult return confirmation).
    // checkFirst=true matches original "mem:session-reset" in history; if not skipped, executeMemCommand
    // would execute reset again, resetting state back to uninitialized and causing an infinite "reset → form → reset → form" loop.
    if (memCmd?.command === "session-reset") memCmd = null;
    if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
      // bypass optimization: when session is not initialized, commands are unavailable
      if (!sessionInfo || injectedSkipped) {
        const thinkingEnabled = !!(body as Record<string, unknown>).thinking;
        const errText = `⚠️ Session not initialized. Commands unavailable. Please complete session initialization (select Team/Agent) and try again.`;
        const errResponse = buildMemResponse(errText, {
          protocol: "anthropic",
          stream: isStream,
          requestId: `mem-cmd-${Date.now()}`,
          thinking: thinkingEnabled,
        });
        console.log(`[mem-command] cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} blocked: session not initialized`);
        return errResponse;
      }
      // Check whether request enables extended thinking (Anthropic protocol)
      const thinkingEnabled = !!(body as Record<string, unknown>).thinking;
      const memResult = await executeMemCommand(memCmd, {
        sessionKey,
        agentSource,
        config,
        spaceId,
        userId,
        apiKey: apiKey || "",
        sessionInfo: sessionInfo as Record<string, unknown>,
        protocol: "anthropic",
        stream: isStream,
        args: memCmd.args,
        thinking: thinkingEnabled,
        // task command family uses recent conversation to generate drafts. Anthropic message content may be an array,
        // extractSimpleMessages concatenates all text segments.
        bodyMessages: extractSimpleMessages((body as Record<string, unknown>).messages),
      });

      // Step 20: L0 write — ensure complete conversation timeline.
      //   Synchronous await ensures L0 is persisted before returning, avoiding loss if process exits before flush.
      //   Note: For mem commands, this is the only persistence opportunity, unlike main conversation path
      //   (which has SIGTERM trackWrite fallback + withL0Retry); explicit wait is required here.
      const tdaiClientForMem = createTdaiClient(config, spaceId);
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
          console.error("[mem-command] L0 write error:", err);
        }
      }

      // Step 19: skill extract — accumulate turn counter normally
      //   Bug: Previously used wrong access path `config.extraction?.skill?.enabled`
      //        (extraction structure is { enabled, extractors: [...] }, without .skill),
      //        causing mem commands to **never** write to skill buffer. Switched to isExtractionAllowed
      //        to align with main conversation pipeline.
      //   Bug: Fire-and-forget without await caused response to return early and write interrupted. Changed to synchronous await
      //        to guarantee buffer persistence before returning response.
      if (isExtractionAllowed(config, "skill")) {
        try {
          const assistantMsg = { role: "assistant", content: [{ type: "text", text: memResult.messageText }] };
          await triggerSkillExtractIfReady({
            config,
            sessionKey,
            agentSource,
            sessionInfo: sessionInfo as Record<string, unknown>,
            inputMessages: messages as unknown[],
            assistantMessage: assistantMsg,
            protocol: "anthropic",
            assetCapabilities,
          });
        } catch (err: unknown) {
          console.warn("[mem-command] skill extract trigger error:", err instanceof Error ? err.message : String(err));
        }
      }

      // Step 18: observability
      console.log(`[mem-command] cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} success=${memResult.success}`);

      // Step 17: Langfuse — report mem-command as a generation observation.
      //   mem command interception happens before Langfuse context construction; here we
      //   compute turnSeq → traceId inline to ensure complete trace in Langfuse for this turn.
      const memTurnSeq = countHumanTurns(messages, "anthropic");
      const memTraceId = langfuseTurnTraceId(sessionKey, memTurnSeq);
      langfuseReportGeneration({
        traceId: memTraceId,
        name: "memory-proxy",
        model: "memory-proxy",
        startTime,
        endTime: new Date().toISOString(),
        input: memCmd.rawMessage,
        output: memResult.messageText,
        usage: { input_tokens: 0, output_tokens: 0 },
        traceName: `memory-proxy / ${keyId}`,
        userId: keyId,
        sessionId: sessionKey,
        tags: [
          `agent_source:${agentSource}`,
          "protocol:anthropic",
          isStream ? "stream" : "non-stream",
          `session:${sessionKey}`,
          "mem-command",
        ],
        traceInput: memCmd.rawMessage,
        traceOutput: memResult.messageText,
      });

      return memResult.response;
    }
  }

  const tdaiClient = assetCapabilities?.chat_memory === false ? null : createTdaiClient(config, spaceId);
  const tdaiIdentity = injectedSkipped
    ? null
    : deriveTdaiIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
        userKey: callerUserKey,
      });
  const tdaiUserMessage = extractLatestUserMessage(messages);

  // ── Context injection (before cost guard) ────────────────────────────────
  // CC split:
  //   - SIDEQUERY: Completely skip injection (self-contained short prompt, no cache sharing)
  //   - FORK: Run pipeline with readOnly=true (do not self-heal write cache on miss to avoid invalidating main cache)
  //   - MAIN: Run full pipeline (including self-heal)
  const skipInjection = requestKind === "sidequery";
  if (!injectedSkipped && !skipInjection && config.injection?.enabled && config.injection.injectors.length > 0) {
    try {
      console.log(`[injection-debug] entering injection pipeline session=${sessionKey} turnSeq=${countHumanTurns(messages, "anthropic")} injectors=${config.injection.injectors} kind=${requestKind}`);
      const injectionTurnSeq = countHumanTurns(messages, "anthropic");
      const { getInjectionPipeline } = await import("./injection/index.js");
      const pipeline = getInjectionPipeline(config);
      const injectedBody = await pipeline.process(body, {
        protocol: "anthropic",
        traceId,
        keyId,
        modelId: modelId as string,
        stream: isStream,
        agentSource,
        userId: userId || "anonymous",
        spaceId,
        sessionKey,
        turnSeq: injectionTurnSeq,
        // Pass through original request path — AssetReflectionInjector uses it to identify `/analyse` marker.
        // Other injectors do not depend on this field.
        requestPath: c.req.path,
        custom: sessionInfo ? { session: sessionInfo, userKey: callerUserKey ?? undefined, assetCapabilities } : undefined,
        readOnly: requestKind === "fork",
      });
      body = injectedBody;
      messages = Array.isArray(injectedBody.messages) ? injectedBody.messages : messages;
      hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    } catch (err: unknown) {
      console.error("[injection] anthropic pipeline error:", err instanceof Error ? err.message : String(err));
    }
  } else if (skipInjection) {
    console.log(`[injection-debug] skipping injection for kind=sidequery session=${sessionKey}`);
  }

  // ── Cost guard: resolve forward target (opaque — no routing logic here) ──
  // upstream.agents[agent] is a single map keyed by agent name (URL path
  // prefix); both url and apiKey may be overridden per agent. When there's
  // no entry, we fall through to the Anthropic-specific global (costGuard
  // .anthropicUpstream) and finally to upstream.url — exactly as before.
  const agentUpstreamEntry = agentFromPath ? config.upstream.agents?.[agentFromPath] : undefined;
  const defaultUpstreamUrl =
    agentUpstreamEntry?.url ||
    config.costGuard.anthropicUpstream?.url ||
    config.upstream.url;
  // Normalize the request path to the canonical upstream endpoint so the
  // extension's URL joining matches the host whitelist behavior.
  const forwardEndpoint = matchWhitelistEndpoint(c.req.path)?.upstreamEndpoint ?? "/messages";
  // Isolation key is user-namespaced (`${user}:${session}`) so two users that
  // share the same client session id can't contaminate each other's state /
  // turn counting. ClickHouse keeps the raw session_key (it has its own
  // user_id column); this composite is internal to the extension only.
  const target: ForwardTarget = await resolveForwardTarget(config, {
    keyId: `${keyId}:${sessionKey}`,
    messages,
    protocol: "anthropic",
    hasTools,
    body,
    modelId,
    defaultUpstreamUrl,
    requestPath: forwardEndpoint,
    headers: lcHeaders,
    traceId,
    startTime,
    spaceId,
    // markerOptIn=false (default/prod): every request goes through the router
    //   regardless of the URL (`/cost-guard` routes are 404 in this mode).
    // markerOptIn=true (test env): only requests with the `/cost-guard`
    //   segment activate the router; bare paths passthrough.
    useGuard: config.costGuard.markerOptIn ? hasCostGuardMarker(c.req.path) : true,
    agentName: agentFromPath,
  });

  // ── Create pipeline logger ──────────────────────────────────────────────
  const pipe = createPipeline(config, traceId, target.model);
  pipe.requestReceived(messages.length, isStream);
  if (target.logLine) pipe.info("COST_GUARD", target.logLine);
  if (target.logLineExtra) pipe.info("COST_GUARD_DETAIL", target.logLineExtra);
  if (ccRoutingEnabled) {
    console.log(`[cc-routing] session=${sessionKey} kind=${requestKind} msgs=${messages.length}`);
  }



  // ── Trace-level tags ──
  // agent_source specifies client family (codebuddy / claude-code / codex / …) for
  // filtering traces in Langfuse by client; protocol only distinguishes wire format,
  // where one wire format may map to multiple clients.
  const traceTags: string[] = [
    `agent_source:${agentSource}`,
    "protocol:anthropic",
    isStream ? "stream" : "non-stream",
    `session:${sessionKey}`,
  ];

  // ── Langfuse turn context: one trace = one turn (deterministic traceId) ──
  // Same (sessionKey, turnSeq) across a turn's tool-loop requests → same trace.
  // Prefer the extension's monotonic per-session turnSeq (survives context
  // compaction); fall back to the stateless count when it's not tracked
  // (extension disabled/unavailable, or no-tools auxiliary request).
  const turnSeq = target.turnSeq > 0 ? target.turnSeq : countHumanTurns(messages, "anthropic");
  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(sessionKey, turnSeq),
    turnSeq,
    traceName: `${target.model} / ${keyId}`,
    userId: keyId,
    sessionId: sessionKey,
    tags: traceTags,
    routeTags: target.tags,
    userQuery: resolveLatestUserQuery(config, lcHeaders, c.req.path, body, messages),
  };
  if (target.analyzerTrace) {
    reportAnalyzerTrace(config, target.analyzerTrace, {
      traceId,
      langfuseTraceId: lf.traceId,
      traceName: lf.traceName,
      traceTags: lf.tags,
      keyId: `${keyId}:${sessionKey}`,
      sessionKey,
      turnSeq,
      startTime,
      spaceId,
    });
  }

  // ── Langfuse debug metadata (only when config.langfuse.debug=true) ────────
  // Used for capturing CB / CC client fingerprints; returns {} when disabled to avoid polluting production metadata.
  // See common/langfuse-debug.ts for details.
  const langfuseDebug = config.langfuse.debug === true;
  const debugMetadata = buildRequestDebugMetadata({
    debug: langfuseDebug,
    body: body as Record<string, unknown>,
    headers: reqHeaders,
    agentSource,
    requestKind,
    spaceId,
    turnSeq,
    requestPath: c.req.path,
    protocol: "anthropic",
  });

  // ── Opik: create trace ───────────────────────────────────────────────────
  const forkTraceId = opikCreateTrace(config, {
    traceId,
    projectName: keyId,
    name: `${target.model} / ${keyId}`,
    startTime,
    input: { messages: flattenAnthropicMessagesForOpik(messages, body.system) },
    tags: [...traceTags, ...target.tags],
    forkProjectName: "request_log",
    forkMetadata: {
      keyId,
      modelId: target.model,
      stream: isStream,
      upstreamUrl: target.url,
    },
  });

  // ── Request debug log ────────────────────────────────────────────────────
  writeRequestLog(config, body);

  // ── Build upstream request ───────────────────────────────────────────────
  // Per-agent apiKey resolution — three cases:
  //   (a) no entry in agents map           → global upstream.apiKey (fallback)
  //   (b) entry present, apiKey empty      → "" (passthrough, keep client key)
  //   (c) entry present, apiKey non-empty  → agent.apiKey (server-side key)
  // The presence of an entry (case b/c) is what cuts the global fallback —
  // this is the switch that lets one proxy serve mixed server-key / client-key
  // agents from a single config.
  const effectiveApiKey = agentUpstreamEntry
    ? (agentUpstreamEntry.apiKey ?? "")
    : config.upstream.apiKey;
  const upstreamHeaders = buildUpstreamHeaders(c, config, target, sessionKey, effectiveApiKey);

  // Optional private preparation stage. It rewrites `body` / `messages` in
  // place, so it has to land after every host-side mutation (injection, agent
  // overrides) and before the upstream body is assembled below. The host does
  // not interpret the returned stats — see request-prepare-adapter.ts.
  const preparedStats = await prepareUpstreamRequest({
    config,
    protocol: "anthropic",
    body,
    messages,
    sessionKey,
    pipe,
    upstreamCall: {
      upstreamUrl: target.url,
      headers: upstreamHeaders,
      model: target.model,
      tools: body.tools,
      system: body.system,
      bodyOverrides: target.bodyOverrides ?? undefined,
    },
    userQuery: lf.userQuery,
    spaceId,
    lf,
  });

  const { body: upstreamBody, sanitizedCount } = buildUpstreamBody(body, target);
  if (sanitizedCount > 0) {
    pipe.info(
      "FORWARD",
      `stripped ${sanitizedCount} invalid thinking block(s) from history`,
    );
  }

  // Retry headers: preserve original client headers (x-request-id, user-agent,
  // etc.), then force the primary upstream's auth — retry always goes to the
  // default upstream (never the alternate route), so its apiKey must be applied
  // just like the first-attempt path. Without this, retry sends the
  // client's raw auth to tokenhub and gets 401.
  const originalHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      originalHeaders[k] = v;
    }
  }
  // Retry uses the same effective key as the primary path — same three
  // cases as above. When it resolves to "" (agent entry present but no
  // apiKey), retry also runs on the client's own key: preserves the
  // "passthrough on this agent" intent even across retries.
  if (effectiveApiKey) {
    originalHeaders["x-api-key"] = effectiveApiKey;
    delete originalHeaders["authorization"];
  }

  const retryBody = sanitizeThinkingBlocks(body).body;

  // ── Forward to upstream (with automatic retry if configured) ──────────────
  const forwardTimeoutMs = config.server.forwardTimeoutMs ?? 600_000;
  pipe.forwardStart();
  let upstreamResp: Response;
  let retried = false;

  try {
    const result = await forwardWithRetry(
      target, upstreamHeaders, upstreamBody,
      retryBody, originalHeaders,
      pipe, forwardTimeoutMs,
      sessionKey,
      { config, instanceId: spaceId || undefined },
    );
    upstreamResp = result.resp;
    retried = result.retried;
  } catch (err: unknown) {
    if (isRateLimitExceededError(err)) {
      pipe.info("RATE_LIMIT", "TPM/QPM exceeded");
      return err.response;
    }
    langfuseReportFailure({
      lf,
      model: target.model,
      startTime,
      endTime: new Date().toISOString(),
      input: buildLangfuseInput(messages, body.system, langfuseDebug),
      statusMessage: err instanceof Error ? err.message : "Upstream request failed",
      extraTags: ["error"],
      observationMetadata: { stage: "forward", ...debugMetadata },
    });
    return c.json({ error: "Upstream request failed" }, 502);
  }

  // Build response headers
  const respHeaders = new Headers();
  for (const [k, v] of upstreamResp.headers.entries()) {
    if (!SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) {
      respHeaders.set(k, v);
    }
  }

  // Upstream request id from response header (tokenhub / Anthropic set
  // `x-request-id`). Used for cross-system tracing/audit.
  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";

  const effectiveModel = retried && target.retryTarget
    ? target.retryTarget.model
    : target.model;

  // A retry falls back to the model the client asked for, so the request ends
  // up costing what it would have cost unrouted — no saving to attribute.
  const routedFrom = retried ? "" : target.routedFrom;
  const { routedFrom: _ignoredRoutedFrom, ...routeLogMeta } = target.logMeta;
  const responseLogMeta = {
    ...routeLogMeta,
    ...(retried ? { retrySuccess: true } : {}),
  };

  // ── Streaming response (Anthropic SSE) ──────────────────────────────────
  if (isStream) {
    if (!upstreamResp.body) {
      pipe.streamDone(null);
      return new Response(null, { status: upstreamResp.status, headers: respHeaders });
    }

    // Log error body for 4xx
    if (!retried && upstreamResp.status >= 400 && upstreamResp.status < 500) {
      const [errStream, clientStream] = upstreamResp.body.tee();
      const errText = await new Response(errStream).text();
      pipe.error("UPSTREAM_4xx", `status=${upstreamResp.status} body=${errText.slice(0, 1000)}`);
      writeLog(config, {
        timestamp: new Date().toISOString(),
        event: "usage",
        modelId: target.model,
        keyId,
        sessionKey,
        upstreamUrl: target.url,
        stream: true,
        usage: { error: true, status: upstreamResp.status, body: errText.slice(0, 500) },
        ...responseLogMeta,
        routedFrom,
        spaceId,
        upstreamRequestId,
      });
      langfuseReportFailure({
        lf,
        model: effectiveModel,
        startTime,
        endTime: new Date().toISOString(),
        input: buildLangfuseInput(messages, body.system, langfuseDebug),
        status: upstreamResp.status,
        statusMessage: errText.slice(0, 500),
        extraTags: ["error"],
        observationMetadata: { stage: "upstream", stream: true, ...debugMetadata },
      });
      pipe.streamDone(null);
      return new Response(clientStream, { status: upstreamResp.status, headers: respHeaders });
    }

    const [rawClientStream, tapStream] = upstreamResp.body.tee();
    pipe.streamStart();

    // Background: consume tap stream for Anthropic SSE → extract usage
    consumeAnthropicStream(tapStream, {
      config,
      modelId: effectiveModel,
      keyId,
      sessionKey,
      upstreamUrl: target.url,
      requestPath: c.req.path,
      traceId,
      forkTraceId,
      startTime,
      inputMessages: messages,
      system: body.system,
      retried,
      logMeta: responseLogMeta,
      routedFrom,
      pipe,
      sessionKeyForSkill: sessionKey,
      agentSource,
      sessionInfo,
      tdaiClient,
      tdaiIdentity,
      tdaiUserMessage,
      assetCapabilities,
      lf,
      spaceId,
      upstreamRequestId,
      requestKind,
      langfuseDebug,
      debugMetadata,
      preparedStats,
    });

    const clientStream = rawClientStream.pipeThrough(createSseThinkingFixStream(pipe));

    return new Response(clientStream, { status: upstreamResp.status, headers: respHeaders });
  }

  // ── Non-streaming response ───────────────────────────────────────────────
  let respText = await upstreamResp.text();
  const endTime = new Date().toISOString();

  let usage: Record<string, unknown> | null = null;
  let outputContent: string | null = null;
  let assistantMessage: Record<string, unknown> | null = null;
  try {
    const respJson = JSON.parse(respText) as Record<string, unknown>;
    if (respJson.usage && typeof respJson.usage === "object") {
      usage = respJson.usage as Record<string, unknown>;
    }
    const content = respJson.content;
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      let thinkingPatched = false;
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === "text") textParts.push(block.text as string);
        // Fix thinking blocks with missing/null `thinking` field.
        // Some models (e.g. DeepSeek) emit `type: "thinking"` blocks
        // without a valid `thinking` string, causing Claude Code to crash
        // with "undefined is not an object (evaluating 's.thinking.length')".
        if (block.type === "thinking") {
          if (block.thinking === undefined || block.thinking === null) {
            block.thinking = "";
            thinkingPatched = true;
          } else if (typeof block.thinking !== "string") {
            block.thinking = String(block.thinking);
            thinkingPatched = true;
          }
        }
      }
      if (thinkingPatched) {
        respText = JSON.stringify(respJson);
        pipe.info("NONSTREAM_THINKING_FIX", "patched thinking block(s) with missing 'thinking' field");
      }
      outputContent = textParts.join("\n");
      // Preserve full content array (incl. tool_use blocks) for skill trigger.
      assistantMessage = { role: "assistant", content };

      // Report the completed response to the extension (same signal the
      // streaming path emits). Fire-and-forget.
      void notifyUpstreamResponse(
        config,
        {
          protocol: "anthropic",
          sessionKey,
          model: effectiveModel,
          stream: false,
          turnSeq: lf.turnSeq,
          text: outputContent,
          toolCalls: (content as Record<string, unknown>[])
            .filter((b) => b?.type === "tool_use")
            .map((b) => ({
              id: (b.id as string) ?? "",
              name: (b.name as string) ?? "",
              arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? ""),
            }))
            .filter((tc) => tc.id && tc.arguments),
          usage: usage ?? {},
        },
        pipe,
      );

      // Internal telemetry: record model_intent individually for each tool_use block in non-streaming responses.
      try {
        const intents = (content as Record<string, unknown>[])
          .filter((b) => b?.type === "tool_use")
          .map((b) => {
            const name = (b.name as string) ?? "";
            const input = b.input;
            const argsStr = typeof input === "string" ? input : JSON.stringify(input ?? "");
            return { name, arguments: argsStr };
          })
          .filter((i) => i.name);
        if (intents.length > 0) {
          emitModelIntentTelemetry({
            // Align compositeKey format with session_init_logs
            sessionKey: `${agentSource}:${sessionKey}`,
            turnSeq: lf.turnSeq,
            spaceId,
            userId: keyId,
            agentSource,
            intents,
          });
        }
      } catch {
        // Telemetry must never block business logic
      }
    }
  } catch {
    // non-JSON response
  }

  const logMeta = responseLogMeta;

  if (usage) {
    await recordInputTokenUsage({
      config,
      instanceId: spaceId || undefined,
      modelId: effectiveModel,
      usage,
      protocol: "anthropic",
    });
    writeLog(config, {
      timestamp: endTime,
      event: "usage",
      modelId: effectiveModel,
      keyId,
      sessionKey,
      turnSeq: lf.turnSeq,
      userInput: lf.userQuery || undefined,
      upstreamUrl: target.url,
      stream: false,
      usage,
      extensionStats: preparedStats ?? undefined,
      ...logMeta,
      routedFrom,
      spaceId,
      upstreamRequestId,
    });

    opikCreateLlmSpan(config, {
      traceId,
      projectName: keyId,
      name: effectiveModel,
      startTime,
      endTime,
      inputMessages: flattenAnthropicMessagesForOpik(messages, body.system),
      outputMessage: outputContent ? { role: "assistant", content: outputContent } : null,
      model: effectiveModel,
      usage,
      tags: retried ? ["retry"] : undefined,
      forkProjectName: "request_log",
      forkTraceId,
      forkMetadata: {
        keyId,
        modelId: effectiveModel,
        stream: false,
        upstreamUrl: target.url,
      },
    });

    // Langfuse: report this LLM call as a generation under the turn trace
    // When debug=true, output uses raw assistantMessage array (including tool_use / thinking /
    // raw stop_reason); when false, falls back to text concatenation to save storage.
    const langfuseOutput = langfuseDebug && assistantMessage
      ? assistantMessage
      : outputContent
      ? { role: "assistant", content: outputContent }
      : undefined;
    langfuseReportGeneration({
      traceId: lf.traceId,
      name: effectiveModel,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInput(messages, body.system, langfuseDebug),
      output: langfuseOutput,
      usage,
      traceName: lf.traceName,
      userId: lf.userId,
      sessionId: lf.sessionId,
      tags: lf.tags,
      traceInput: lf.userQuery || undefined,
      traceOutput: langfuseOutput,
      traceMetadata: { stream: false, retried, upstreamUrl: target.url, ...logMeta, ...debugMetadata },
      observationMetadata: { retried, ...logMeta, ...debugMetadata },
    });
  } else if (upstreamResp.status >= 400) {
    pipe.error("UPSTREAM_4xx", `status=${upstreamResp.status} body=${respText.slice(0, 1000)}`);
    langfuseReportFailure({
      lf,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInput(messages, body.system, langfuseDebug),
      status: upstreamResp.status,
      statusMessage: respText.slice(0, 500),
      extraTags: ["error"],
      observationMetadata: { stage: "upstream", stream: false, ...debugMetadata },
    });
  }

  pipe.responseDone(usage);

  // CC split: FORK/SIDEQUERY are background auto-invocations by CC client, not real user turns;
  //           skip skill/L0 side effects. Credit is still reported (real token consumption).
  const isMainDialog = requestKind === "main";

  // Skill extract trigger — count tool_use blocks + buffer conversation.
  // Synchronous await: continue only after store persistence to ensure cross-node data consistency in next turn.
  if (isMainDialog && isExtractionAllowed(config, "skill")) {
    await triggerSkillExtractIfReady({
      config,
      sessionKey,
      agentSource,
      sessionInfo,
      inputMessages: messages,
      assistantMessage,
      protocol: "anthropic",
      assetCapabilities,
    });
  } else if (isMainDialog) {
    logExtractionSkipped(config, "skill", sessionKey);
  } else {
    console.log(`[cc-routing] skip skill buffer for kind=${requestKind} session=${sessionKey}`);
  }

  // TDAI L0 write (non-streaming).
  //
  // Symmetric with stream branch (1476-1481): write user_query + assistant response to L0
  // short-term memory. **Previously only stream=true was writing**, non-stream requests (like tool/test scripts
  // using stream:false) silently dropped writes. Missing this call meant CC non-stream scenarios
  // had zero L0 memory writes.
  if (isMainDialog && tdaiClient && isExtractionAllowed(config, "tdai-memory")) {
    recordTdaiTurn(tdaiClient, tdaiIdentity, tdaiUserMessage, outputContent)
      .catch((err: unknown) => pipe.error("TDAI_L0", err));
  } else if (isMainDialog && tdaiClient) {
    logExtractionSkipped(config, "tdai-memory", sessionKey);
  } else if (!isMainDialog) {
    console.log(`[cc-routing] skip L0 write for kind=${requestKind} session=${sessionKey}`);
  }

  // Credit usage reporting (non-streaming). Failures are surfaced to the client
  // via the `x-credit-report-error` response header but never replace the
  // upstream LLM response body — the user-facing answer is preserved.
  const creditOutcome = await tryReportCreditFromPath(
    config.creditReport,
    c.req.path,
    usage,
    config.creditPricing,
    effectiveModel,
    target.url,
    "usage",
  );
  if (creditOutcome.attempted && !creditOutcome.ok) {
    pipe.error("CREDIT_REPORT", creditOutcome.errorMessage ?? "unknown");
    if (creditOutcome.errorHeader) {
      respHeaders.set("x-credit-report-error", creditOutcome.errorHeader);
    }
    // Persist the failed report as a raw record for auditing / retry pipelines.
    writeFailedReportRaw(
      {
        timestamp: new Date().toISOString(),
        event: "usage",
        modelId: effectiveModel,
        keyId,
        sessionKey,
        upstreamUrl: target.url,
        stream: false,
        usage: usage === null ? undefined : usage,
        routedFrom,
        upstreamRequestId,
        pricingConfig: config.creditPricing,
      },
      creditOutcome.errorMessage ?? "unknown",
    );
  }

  return new Response(respText, { status: upstreamResp.status, headers: respHeaders });
}


/**
 * Create a TransformStream that patches Anthropic SSE events in-band.
 */
function createSseThinkingFixStream(
  pipe: ReturnType<typeof createPipeline>,
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let sseBuf = "";
  let patchedCount = 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sseBuf += decoder.decode(chunk, { stream: true });

      const parts = sseBuf.split("\n\n");
      sseBuf = parts.pop() ?? "";

      for (const part of parts) {
        const lines = part.split("\n");
        let dataLine = "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            dataLine = line;
          }
        }

        if (!dataLine) {
          controller.enqueue(encoder.encode(part + "\n\n"));
          continue;
        }

        const dataStr = dataLine.slice(6);
        if (!dataStr || dataStr === "[DONE]") {
          controller.enqueue(encoder.encode(part + "\n\n"));
          continue;
        }

        try {
          const evt = JSON.parse(dataStr) as Record<string, unknown>;
          let patched = false;

          if (evt.type === "content_block_start") {
            const block = evt.content_block as Record<string, unknown> | undefined;
            if (block?.type === "thinking") {
              if (block.thinking === undefined || block.thinking === null) {
                block.thinking = "";
                patched = true;
              } else if (typeof block.thinking !== "string") {
                block.thinking = String(block.thinking);
                patched = true;
              }
            }
          }

          // Fix content_block_delta with type=thinking_delta but missing thinking field.
          // Claude Code does `contentBlock.thinking += delta.thinking` which would
          // produce "null" or "undefined" strings if delta.thinking is not a string.
          if (evt.type === "content_block_delta") {
            const delta = evt.delta as Record<string, unknown> | undefined;
            if (delta?.type === "thinking_delta") {
              if (delta.thinking === undefined || delta.thinking === null) {
                delta.thinking = "";
                patched = true;
              } else if (typeof delta.thinking !== "string") {
                delta.thinking = String(delta.thinking);
                patched = true;
              }
            }
          }

          if (patched) {
            patchedCount++;
            const newDataLine = "data: " + JSON.stringify(evt);
            const newLines = lines.map((l) =>
              l.startsWith("data: ") ? newDataLine : l,
            );
            controller.enqueue(encoder.encode(newLines.join("\n") + "\n\n"));
          } else {
            controller.enqueue(encoder.encode(part + "\n\n"));
          }
        } catch {
          controller.enqueue(encoder.encode(part + "\n\n"));
        }
      }
    },

    flush(controller) {
      if (sseBuf.trim()) {
        controller.enqueue(encoder.encode(sseBuf));
      }
      if (patchedCount > 0) {
        pipe.info("SSE_FIX", `patched ${patchedCount} thinking block(s) with missing 'thinking' field`);
      }
    },
  });
}

// ── Stream processing helpers ────────────────────────────────────────────────

interface AnthropicTapContext {
  config: ProxyConfig;
  modelId: string;
  keyId: string;
  sessionKey: string;
  upstreamUrl: string;
  requestPath: string;
  traceId: string;
  forkTraceId: string;
  startTime: string;
  inputMessages: unknown[];
  /** Anthropic top-level `system` field (string or content-block array). */
  system: unknown;
  retried: boolean;
  logMeta: Record<string, unknown>;
  /** Requested model when the router forwarded elsewhere; "" otherwise. */
  routedFrom: string;
  pipe: ReturnType<typeof createPipeline>;
  /** For skill extract trigger. */
  sessionKeyForSkill: string;
  /** Client type (first URL path segment) — passed through to extract trigger as one of three isolation keys. */
  agentSource: string;
  sessionInfo: Record<string, unknown> | null | undefined;
  /** Tdai L0 write. */
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  tdaiUserMessage: TdaiMessage | null;
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
  /** Langfuse turn-trace context (trace = one turn). */
  lf: LangfuseTurnContext;
  /** Space/tenant ID from request path. */
  spaceId?: string;
  /** Upstream response header `x-request-id` (empty when not returned). */
  upstreamRequestId?: string;
  /** CC request split kind, determines whether to trigger skill/L0 side effects after stream completes. */
  requestKind: CcRequestKind;
  /** Evaluated config.langfuse.debug === true result, passed through to avoid reading config repeatedly inside stream. */
  langfuseDebug: boolean;
  /** Evaluated result of buildRequestDebugMetadata; {} when debug=false. */
  debugMetadata: Record<string, unknown>;
  /** Opaque counters from the request-preparation stage; null when it didn't run. */
  preparedStats: Record<string, unknown> | null;
}

/**
 * Consume Anthropic SSE stream in background, extract usage, log + Opik.
 */
function consumeAnthropicStream(stream: ReadableStream<Uint8Array>, ctx: AnthropicTapContext): void {
  const { config, modelId, keyId, sessionKey, upstreamUrl, traceId, forkTraceId, startTime, inputMessages, system, retried, logMeta, pipe, lf, spaceId, upstreamRequestId } = ctx;

  (async () => {
    const decoder = new TextDecoder();
    let sseBuf = "";
    let usage: Record<string, unknown> = {};
    let outputText = "";
    let toolUseCount = 0;
    let streamCompleted = false;
    // Internal telemetry: accumulate each tool_use block by index.
    // Anthropic SSE protocol:
    //   1. content_block_start(type=tool_use)  → receive index + name (input is empty {} at this point)
    //   2. content_block_delta(type=input_json_delta) → accumulate partial_json string
    //   3. content_block_stop → block ends
    // Previous implementation only read input in (1) (always empty) — now accumulating partial_json in (2) by index.
    const toolUseAcc = new Map<number, { id: string; name: string; inputJson: string }>();

    const timeoutHandle = setTimeout(() => {
      if (!streamCompleted) {
        pipe.error("STREAM_TIMEOUT", "Anthropic stream reading exceeded 5 minutes");
        // completeStream is async; fire-and-forget here (cannot await inside timeout)
        void completeStream().catch((err) => pipe.error("STREAM_TIMEOUT_COMPLETE", err));
      }
    }, 5 * 60 * 1000);

    async function completeStream(): Promise<void> {
      if (streamCompleted) return;
      streamCompleted = true;
      clearTimeout(timeoutHandle);

      const endTime = new Date().toISOString();

      if (Object.keys(usage).length > 0) {
        await recordInputTokenUsage({
          config,
          instanceId: spaceId || undefined,
          modelId,
          usage,
          protocol: "anthropic",
        });
        try {
          writeLog(config, {
            timestamp: endTime,
            event: "usage",
            modelId,
            keyId,
            sessionKey,
            turnSeq: lf.turnSeq,
            userInput: lf.userQuery || undefined,
            upstreamUrl,
            stream: true,
            usage,
            extensionStats: ctx.preparedStats ?? undefined,
            routedFrom: ctx.routedFrom,
            spaceId,
            upstreamRequestId,
            ...logMeta,
          });
        } catch (logErr: unknown) {
          pipe.error("LOG_WRITE", logErr);
        }

        try {
          opikCreateLlmSpan(config, {
            traceId,
            projectName: keyId,
            name: modelId,
            startTime,
            endTime,
            inputMessages: flattenAnthropicMessagesForOpik(inputMessages, system),
            outputMessage: outputText ? { role: "assistant", content: outputText } : null,
            model: modelId,
            usage,
            tags: retried ? ["retry"] : undefined,
            forkProjectName: "request_log",
            forkTraceId,
            forkMetadata: {
              keyId,
              modelId,
              stream: true,
              upstreamUrl,
            },
          });
        } catch (opikErr: unknown) {
          pipe.error("OPIK_SPAN", opikErr);
        }

        // Langfuse: report this LLM call as a generation under the turn trace
        // Streaming lacks complete raw assistant content array (tool_use blocks are chunked
        // incremental events in SSE); in debug mode, pass tool_use_count and stop_reason into metadata as fallback.
        try {
          const streamDebugExtra = ctx.langfuseDebug
            ? {
                stream_tool_use_count: toolUseCount,
                stream_output_text_len: outputText.length,
              }
            : {};
          langfuseReportGeneration({
            traceId: lf.traceId,
            name: modelId,
            model: modelId,
            startTime,
            endTime,
            input: buildLangfuseInput(inputMessages, system, ctx.langfuseDebug),
            output: outputText ? { role: "assistant", content: outputText } : undefined,
            usage,
            traceName: lf.traceName,
            userId: lf.userId,
            sessionId: lf.sessionId,
            tags: lf.tags,
            traceInput: lf.userQuery || undefined,
            traceOutput: outputText ? { role: "assistant", content: outputText } : undefined,
            traceMetadata: {
              stream: true, retried, upstreamUrl, ...logMeta,
              ...ctx.debugMetadata, ...streamDebugExtra,
            },
            observationMetadata: {
              retried, ...logMeta,
              ...ctx.debugMetadata, ...streamDebugExtra,
            },
          });
        } catch (langfuseErr: unknown) {
          pipe.error("LANGFUSE_SPAN", langfuseErr);
        }
      }

      // CC split: FORK/SIDEQUERY are not real conversation turns; skip L0/skill. Credit is still reported.
      const isMainDialog = ctx.requestKind === "main";

      // Tdai L0 write
      if (isMainDialog && ctx.tdaiClient && isExtractionAllowed(ctx.config, "tdai-memory")) {
        // Streaming does not await (avoids slowing down SSE closure); trackWrite + withL0Retry handle two packet loss vectors:
        //   - trackWrite registers in-flight promise to global set; on SIGTERM index.ts runs
        //     flushPendingWrites fallback to prevent pod rolling exit before event loop flushes L0.
        //   - withL0Retry performs 3 backoff retries (~3.5s) against tdai kernel glitches / 5xx / network jitter.
        trackWrite(
          withL0Retry(() => recordTdaiTurn(
            ctx.tdaiClient!, ctx.tdaiIdentity, ctx.tdaiUserMessage,
            outputText || null,
          )).catch((err: unknown) => pipe.error("TDAI_L0", err))
        );
      } else if (isMainDialog && ctx.tdaiClient) {
        logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionKeyForSkill);
      } else if (!isMainDialog) {
        console.log(`[cc-routing] skip L0 write (stream) for kind=${ctx.requestKind} session=${ctx.sessionKeyForSkill}`);
      }

      pipe.streamDone(Object.keys(usage).length > 0 ? usage : null);

      // Report the completed response to the extension. Fire-and-forget; the
      // client has already been served by this point.
      void notifyUpstreamResponse(
        ctx.config,
        {
          protocol: "anthropic",
          sessionKey: ctx.sessionKey,
          model: modelId,
          stream: true,
          turnSeq: lf.turnSeq,
          text: outputText,
          toolCalls: Array.from(toolUseAcc.values())
            .filter((v) => v.id && v.inputJson)
            .map((v) => ({ id: v.id, name: v.name, arguments: v.inputJson })),
          usage,
        },
        pipe,
      );

      // Internal telemetry: emit one model_intent per accumulated tool_use in SSE stream.
      // See docs/design/2026-08-03-internal-usage-telemetry-plan.md §7.2 F for details.
      // session_key must use the same compositeKey (agentSource:sessionKey) as session_init_logs,
      // otherwise `session_key IN (init_sessions)` in §4.1 CTE will not match.
      if (toolUseAcc.size > 0) {
        // Output sorted by index (restores model generation order); inputJson is stream-accumulated partial_json
        const intents = Array.from(toolUseAcc.entries())
          .sort(([a], [b]) => a - b)
          .filter(([, v]) => v.name)
          .map(([, v]) => ({ name: v.name, arguments: v.inputJson || "{}" }));
        if (intents.length > 0) {
          emitModelIntentTelemetry({
            sessionKey: `${ctx.agentSource}:${ctx.sessionKey}`,
            turnSeq: ctx.lf.turnSeq,
            spaceId: ctx.spaceId,
            userId: ctx.keyId,
            agentSource: ctx.agentSource,
            intents,
          });
        }
      }

      // Skill extract trigger — after stream finalization.
      // Synchronous await: continue only after store persistence to ensure cross-node data consistency in next turn.
      if (isMainDialog && isExtractionAllowed(ctx.config, "skill")) {
        await triggerSkillExtractIfReady({
          config: ctx.config,
          sessionKey: ctx.sessionKeyForSkill,
          agentSource: ctx.agentSource,
          sessionInfo: ctx.sessionInfo,
          inputMessages: ctx.inputMessages,
          assistantMessage: outputText
            ? { role: "assistant", content: outputText }
            : null,
          protocol: "anthropic",
          assetCapabilities: ctx.assetCapabilities,
          toolCallCountOverride: toolUseCount,
        });
      } else if (isMainDialog) {
        logExtractionSkipped(ctx.config, "skill", ctx.sessionKeyForSkill);
      } else {
        console.log(`[cc-routing] skip skill buffer (stream) for kind=${ctx.requestKind} session=${ctx.sessionKeyForSkill}`);
      }

      // Credit usage reporting for streaming responses. The stream has already
      // been forwarded to the client; failures here are best-effort and can
      // only be observed via server logs (no way to retro-add response headers).
      tryReportCreditFromPath(
        ctx.config.creditReport,
        ctx.requestPath,
        usage,
        ctx.config.creditPricing,
        ctx.modelId,
        ctx.upstreamUrl,
        "usage",
      )
        .then((outcome) => {
          if (outcome.attempted && !outcome.ok) {
            pipe.error("CREDIT_REPORT", `[stream] ${outcome.errorMessage ?? "unknown"}`);
            // Persist failed report as a raw record (reuses existing usage_raw table).
            writeFailedReportRaw(
              {
                timestamp: new Date().toISOString(),
                event: "usage",
                modelId: ctx.modelId,
                keyId: ctx.keyId,
                sessionKey: ctx.sessionKey,
                upstreamUrl: ctx.upstreamUrl,
                stream: true,
                usage,
                routedFrom: ctx.routedFrom,
                upstreamRequestId: ctx.upstreamRequestId,
                pricingConfig: ctx.config.creditPricing,
              },
              outcome.errorMessage ?? "unknown",
            );
          }
        })
        .catch((err: unknown) => pipe.error("CREDIT_REPORT", err));
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
            if (line.startsWith("data: ")) {
              dataStr = line.slice(6);
            } else if (line.startsWith("data:")) {
              dataStr = line.slice(5);
            }
          }

          if (!dataStr || dataStr === "[DONE]") continue;

          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            const evtType = evt.type as string;

            if (evtType === "message_start") {
              const message = evt.message as Record<string, unknown> | undefined;
              if (message?.usage) {
                Object.assign(usage, message.usage as Record<string, unknown>);
              }
            } else if (evtType === "message_delta") {
              if (evt.usage) {
                Object.assign(usage, evt.usage as Record<string, unknown>);
              }
            } else if (evtType === "content_block_delta") {
              const delta = evt.delta as Record<string, unknown> | undefined;
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                outputText += delta.text;
              } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                // Accumulate into corresponding tool_use block (by index)
                try {
                  const idx = evt.index as number | undefined;
                  if (typeof idx === "number") {
                    const acc = toolUseAcc.get(idx);
                    if (acc) acc.inputJson += delta.partial_json;
                  }
                } catch {
                  // ignore — telemetry issues do not block main pipeline
                }
              }
            } else if (evtType === "content_block_start") {
              const block = evt.content_block as Record<string, unknown> | undefined;
              if (block?.type === "tool_use") {
                toolUseCount++;
                try {
                  const name = (block.name as string) ?? "";
                  const idx = evt.index as number | undefined;
                  if (name && typeof idx === "number") {
                    toolUseAcc.set(idx, { id: (block.id as string) ?? "", name, inputJson: "" });
                  }
                } catch {
                  // ignore — accumulation failures do not affect main pipeline
                }
              }
            }
          } catch {
            // ignore malformed SSE data
          }
        }
      }

      // Drain remaining buffer
      if (sseBuf.trim()) {
        const lines = sseBuf.split("\n");
        let dataStr = "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            dataStr = line.slice(6);
          }
        }
        if (dataStr && dataStr !== "[DONE]") {
          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            if (evt.type === "message_delta" && evt.usage) {
              Object.assign(usage, evt.usage as Record<string, unknown>);
            }
          } catch {
            // ignore
          }
        }
      }
    } catch (err: unknown) {
      pipe.error("STREAM", err);
    }

    await completeStream();
  })().catch((err: unknown) => {
    pipe.error("STREAM_CONSUME", err);
  });
}
