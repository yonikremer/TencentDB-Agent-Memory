/** Core request handler: intercept → forward → parse usage → log. */

import type { Context } from "hono";
import { createHash } from "node:crypto";
import { writeLog, createPipeline } from "./logger.js";
import {
  apiKeyToKeyId,
  extractBearerToken,
  opikCreateLlmSpan,
  opikCreateTrace,
  opikUpdateTrace,
  uuidv7,
} from "./opik.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "./langfuse.js";
import {
  buildLangfuseInputChat,
  buildRequestDebugMetadata,
} from "./common/langfuse-debug.js";
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
import {
  enforceRateLimit,
  isRateLimitExceededError,
  recordInputTokenUsage,
} from "./rate-limit/guard.js";

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
 * Flatten messages into Opik-friendly chat messages (no truncation).
 */
function flattenMessagesForOpik(messages: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    if (typeof content === "string") {
      result.push(msg);
      continue;
    }

    if (!Array.isArray(content)) {
      if (role === "assistant" && Array.isArray(m.tool_calls)) {
        if (typeof content === "string" && content) {
          result.push({ role: "assistant", content });
        }
        for (const tc of m.tool_calls as unknown[]) {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          let argsStr = "";
          if (fn?.arguments) {
            argsStr = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
          }
          result.push({
            role: "assistant",
            content: JSON.stringify({ tool_call_id: t.id, tool_name: fn?.name ?? "unknown", arguments: argsStr }, null, 2),
          });
        }
        continue;
      }
      result.push(msg);
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
          textParts.push(`[thinking] ${b.thinking as string}`);
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
      const topLevelToolCalls = m.tool_calls;
      if (Array.isArray(topLevelToolCalls)) {
        for (const tc of topLevelToolCalls) {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          let argsStr = "";
          if (fn?.arguments) {
            argsStr = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
          }
          result.push({
            role: "assistant",
            content: JSON.stringify({ tool_call_id: t.id, tool_name: fn?.name ?? "unknown", arguments: argsStr }, null, 2),
          });
        }
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

const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);

/** Extract usage object from a block of OpenAI SSE text. */
export function extractSseUsage(sseText: string): Record<string, unknown> | null {
  let lastUsage: Record<string, unknown> | null = null;

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;

    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      if (evt.usage && typeof evt.usage === "object") {
        lastUsage = evt.usage as Record<string, unknown>;
      }
    } catch {
      // ignore malformed SSE lines
    }
  }

  return lastUsage;
}

/**
 * Build upstream body from original body + cost guard overrides.
 * The host does NOT branch on routing — it just applies overrides if present.
 */
function buildUpstreamBody(
  body: Record<string, unknown>,
  target: ForwardTarget,
): Record<string, unknown> {
  let upstreamBody = body;
  if (target.bodyOverrides) {
    upstreamBody = { ...body, ...target.bodyOverrides };
  }
  return upstreamBody;
}

/**
 * Build upstream headers from request headers + routing auth overrides.
 * If config.upstream.apiKey is set, it overrides the request's Authorization header
 * only for the default route (not alternate model route).
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

  // `effectiveApiKey` is pre-resolved by the caller — see the resolveEffective
  // block near the call site. Non-empty → inject as server-side Bearer;
  // empty/undefined → passthrough (client's own Authorization survives).
  // cost-guard's `target.authHeaders` still gets to override everything.
  if (effectiveApiKey && !target.authHeaders) {
    headers["authorization"] = `Bearer ${effectiveApiKey}`;
  }

  if (target.authHeaders) {
    for (const [k, v] of Object.entries(target.authHeaders)) {
      headers[k] = v;
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

  // ── Optional full-body dump (dev only) ───────────────────────────────
  // Enable: PROXY_DEBUG_DUMP_BODY=/tmp/proxy-outbound
  // Each forward writes one file to make diagnosing upstream 400s easier.
  if (process.env.PROXY_DEBUG_DUMP_BODY) {
    try {
      const fs = await import("node:fs");
      const dir = process.env.PROXY_DEBUG_DUMP_BODY;
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const fn = `${dir}/${ts}-${sessionKeyForDebug ?? "nosid"}.json`;
      fs.writeFileSync(fn, JSON.stringify({ url: target.url, headers: upstreamHeaders, body: upstreamBody }, null, 2));
      console.log(`[dump-body] wrote ${fn}`);
    } catch (e) {
      console.log(`[dump-body] error: ${(e as Error).message}`);
    }
  }

  // ── Optional outbound body md5 debug log (see anthropicHandler.ts) ─────
  // The openai protocol side has no cache_control concept — only two md5s are computed (sys + the whole messages array).
  if (process.env.PROXY_DEBUG_DUMP_OUTBOUND_MD5) {
    try {
      const msgs = (upstreamBody as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
      const sysMsg = msgs.find((m) => m.role === "system");
      const sysStr = typeof sysMsg?.content === "string"
        ? sysMsg.content
        : sysMsg?.content ? JSON.stringify(sysMsg.content) : "";
      const msgsFullStr = JSON.stringify(msgs);
      const sysMd5 = createHash("md5").update(sysStr).digest("hex").slice(0, 12);
      const msgsFullMd5 = createHash("md5").update(msgsFullStr).digest("hex").slice(0, 12);
      // eslint-disable-next-line no-console
      console.log(
        `[outbound-md5] session=${sessionKeyForDebug ?? "?"} protocol=openai sysBytes=${sysStr.length} sysMd5=${sysMd5} msgsCount=${msgs.length} msgsFullBytes=${msgsFullStr.length} msgsFullMd5=${msgsFullMd5}`,
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`[outbound-md5] session=${sessionKeyForDebug ?? "?"} <error: ${(e as Error).message}>`);
    }
  }

  const fetchOpts: RequestInit = {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(upstreamBody),
  };
  if (forwardTimeoutMs > 0) {
    fetchOpts.signal = AbortSignal.timeout(forwardTimeoutMs);
  }

  if (rateLimitContext) {
    await enforceRateLimit({
      config: rateLimitContext.config,
      instanceId: rateLimitContext.instanceId,
      modelId: target.model,
      protocol: "openai",
    });
  }
  try {
    upstreamResp = await fetch(target.url, fetchOpts);
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
    pipe.info("RETRY", `Routed model failed (${reason}), retryUrl=${target.retryTarget.url} model=${target.retryTarget.model}`);

    const retryBody = { ...originalBody, model: target.retryTarget.model };
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
          protocol: "openai",
        });
      }
      const retryFetchOpts: RequestInit = {
        method: "POST",
        headers: retryHeaders,
        body: JSON.stringify(retryBody),
      };
      if (forwardTimeoutMs > 0) {
        retryFetchOpts.signal = AbortSignal.timeout(forwardTimeoutMs);
      }
      upstreamResp = await fetch(target.retryTarget.url, retryFetchOpts);
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

/** Main handler for POST /v1/chat/completions (OpenAI compat). */
export async function handleChatCompletions(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const startTime = new Date().toISOString();
  const traceId = uuidv7();

  // ── Early auth ──────────────────────────────────────────────────────────
  // Verify BEFORE parsing the body so a rejected caller never triggers body
  // parsing or the alias-gate. `earlyVerify.userId` is reused later for
  // both the systemUser short-circuit and the normal pipeline.
  const earlyAuthHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const earlyApiKey = extractBearerToken(earlyAuthHeader);
  const earlySpaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const earlyVerify = await verifyUserKey(earlyApiKey, earlySpaceId);
  if (earlyVerify.rejected) {
    return c.json({ error: `Authentication failed: ${earlyVerify.rejectReason ?? "unknown"}` }, 401);
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

  // ── Optional inbound body dump (dev only) ─────────────────────────
  // Enable: PROXY_DEBUG_DUMP_INBOUND=/tmp/proxy-inbound
  // Each inbound request writes one file to check whether a client replay actually carried a given field.
  if (process.env.PROXY_DEBUG_DUMP_INBOUND) {
    try {
      const fs = await import("node:fs");
      const dir = process.env.PROXY_DEBUG_DUMP_INBOUND;
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const hdrs: Record<string, string> = {};
      for (const [k, v] of c.req.raw.headers.entries()) hdrs[k] = v;
      const sid = hdrs["x-deepseek-harness-session-id"] ?? hdrs["x-session-id"] ?? "nosid";
      const fn = `${dir}/${ts}-${sid}.json`;
      fs.writeFileSync(fn, JSON.stringify({ path: c.req.path, headers: hdrs, body }, null, 2));
      console.log(`[dump-inbound] wrote ${fn}`);
    } catch (e) {
      console.log(`[dump-inbound] error: ${(e as Error).message}`);
    }
  }

  // ── DEBUG: dump tools/instructions/metadata (Phase 1 workbuddy research) ──
  // Enabled only when sessionInit.debugVerboseLogging=true; off by default in production.
  if (config.sessionInit?.debugVerboseLogging) {
  try {
    const dbgPath = c.req.path;
    if (dbgPath.includes("/workbuddy/")) {
      // Keep only trimmed-down fields (do not dump the raw tools array, to avoid over-length truncation)
      const dumpKeys = [
        "tool_choice",
        "toolset",
        "tool_config",
        "response_format",
        "metadata",
        "client_metadata",
      ];
      const dump: Record<string, unknown> = { path: dbgPath, model: body.model };
      for (const k of dumpKeys) {
        if (k in body) dump[k] = (body as Record<string, unknown>)[k];
      }
      const toolsField = (body as Record<string, unknown>).tools;
      if (Array.isArray(toolsField)) {
        dump.tools_summary = toolsField.map((t: unknown) => {
          const tt = t as Record<string, unknown>;
          const fn = (tt as any).function ?? {};
          const paramProps = fn.parameters?.properties;
          return {
            type: tt.type,
            name: (tt as any).name ?? fn.name,
            description:
              typeof (tt as any).description === "string"
                ? String((tt as any).description).slice(0, 400)
                : typeof fn.description === "string"
                  ? String(fn.description).slice(0, 400)
                  : undefined,
            param_keys: paramProps && typeof paramProps === "object"
              ? Object.keys(paramProps)
              : undefined,
          };
        });
      }
      // If messages[0] is a system message, dump it too (it may declare tool usage)
      const msgs = (body as Record<string, unknown>).messages;
      if (Array.isArray(msgs) && msgs.length > 0) {
        const first = msgs[0] as Record<string, unknown>;
        if (first?.role === "system") {
          const content = typeof first.content === "string"
            ? first.content
            : JSON.stringify(first.content);
          dump.system_head = content.slice(0, 2000);
          dump.system_length = content.length;
        }
        dump.messages_count = msgs.length;
      }
      console.log(
        `[wb-tools-dump] path=${dbgPath} tools_count=${Array.isArray(toolsField) ? toolsField.length : 0}`,
      );
      console.log(`[wb-tools-dump-json] ${JSON.stringify(dump).slice(0, 60000)}`);

      // Extra: separately dump AskUserQuestion's full schema (key Phase 1 research)
      if (Array.isArray(toolsField)) {
        const askTool = toolsField.find((t: unknown) => {
          const tt = t as any;
          const name = tt?.name ?? tt?.function?.name;
          return name === "AskUserQuestion";
        });
        if (askTool) {
          console.log(
            `[wb-ask-user-schema] ${JSON.stringify(askTool).slice(0, 20000)}`,
          );
        }
      }
    }
  } catch (e) {
    console.log(`[wb-tools-dump] error: ${String(e)}`);
  }
  } // debugVerboseLogging gate

  // ── Model gate: reject requests whose `model` is not a registered display name ──
  // When a price table is configured, the client `model` must match an entry's
  // `modelName` (the display name; case-insensitive). The real model_id is an
  // internal detail, not a client entry point. A miss returns 400 directly, so a
  // request is never forwarded yet skipped for billing because it has no pricing.
  // Skipped when the price table is empty (backward compatible).
  //
  // Internal and external callers are treated alike — internal callers must also
  // request by `modelName`, ensuring upstream ids and billing/observability keys
  // align across all traffic.
  const requestedModel = typeof body.model === "string" ? body.model : "unknown";
  if (!isModelInPricing(config.creditPricing, requestedModel)) {
    return c.json(
      {
        error: {
          message: `Model '${requestedModel}' is not a registered display name in the credit pricing table`,
          type: "invalid_request_error",
          code: "model_not_found",
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

  // [debug] Log last 3 message roles and content types to diagnose session-init issues
  if (config.sessionInit?.enabled && messages.length > 2) {
    const tail = messages.slice(-3);
    const summary = tail.map((m: any, idx: number) => {
      const role = m.role;
      const ct = m.content;
      const contentType = typeof ct === "string" ? `string(${ct.slice(0, 80)})` :
        Array.isArray(ct) ? `array[${ct.map((b: any) => b.type).join(",")}]` :
        ct === null ? "null" : typeof ct;
      const tcid = m.tool_call_id;
      const tcs = m.tool_calls ? `tool_calls[${m.tool_calls.map((t: any) => t.id).join(",")}]` : "";
      return `[${idx}]role=${role} content=${contentType} tool_call_id=${tcid} ${tcs}`;
    }).join(" | ");
    console.log(`[session-init-debug] raw-tail msgs=${messages.length} ${summary}`);
  }

  // ── Resolve agent source from URL path (e.g. /claude-code/v1/chat/completions) ──
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
  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const apiKey = extractBearerToken(authHeader);
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
  let userId = earlyVerify.userId
    || c.req.header("x-user-id")
    || c.req.header("x-cb-user-id")
    || c.req.header("x-tdai-user-token")
    || "";
  // DEBUG override: the tokenhub-uid and kernel-uid sent by the client often differ
  // during local joint debugging. Once sessionInit.debugForceUserId is configured,
  // substitute the real kernel user_id so the CB state machine can pull assets via
  // kernel /team/list and pop the form normally.
  const debugForceUserId = config.sessionInit?.debugForceUserId;
  if (debugForceUserId) {
    console.log(
      `[handler] DEBUG override userId ${userId || "<empty>"} → ${debugForceUserId}`,
    );
    userId = debugForceUserId;
  }
  if (userId) keyId = userId;

  // Activate Redis storage early — must run BEFORE session init.
  if (config.redis?.enabled) {
    const { getInjectionPipeline } = await import("./injection/index.js");
    getInjectionPipeline(config);
  }

  // ── Request kind classification (auxiliary detection for OpenAI-chat clients) ──
  // dsh (deepseek-harness) sends `x-deepseek-harness-compact: 1` on compaction
  // requests, and title-gen is detected by combining three body features. Such
  // requests must NOT go through the session-init form, and must not trigger mem
  // interception / L0 writes / skill extraction — they should pass straight through
  // to upstream. The codebuddy / claude-code client adapters' classifyRequest always
  // returns "main", so their behavior is unchanged.
  const { resolveAgentAdapter } = await import("./agent-adapters/index.js");
  const _adapter = resolveAgentAdapter(agentSource);
  const _requestKind = _adapter.classifyRequest(body as Record<string, unknown>, c.req.path, lcHeaders);
  const isAuxiliary = _requestKind === "auxiliary";
  if (isAuxiliary) {
    console.log(`[request-classify] session=${sessionKey} agent=${agentSource} → auxiliary (skip session-init/mem/injection/L0/skill)`);
  }

  // ── dsh (deepseek-harness) CLI headless / no-preset bypass ──────────────
  // When the dsh client is in a headless bundle or has no ask-user preset mounted,
  // body.tools carries no `ask_user_question` tool. A fake `ask_user_question`
  // tool_call injected by the proxy would be validated as an unknown tool by the dsh
  // agent-loop and throw directly. In that case bypass session-init instead of popping
  // a form — forcing a form when there is no UI is pointless.
  //
  // Detection: agentSource=dsh AND body.tools is non-empty AND contains no
  // ask_user_question. (An empty tools array means a pure chat / aux request and needs
  // no fallback; if tools already contains ask_user_question, a preset has mounted a
  // UI tool and the normal form path runs.)
  //
  // NOTE(opencode): the opencode CLI likewise does not support a virtual
  // ask_followup_question tool, but it goes through a separate header-driven
  // session-init branch (see the opencode-specific block below), so it does not need
  // the headless bypass here — opencode can consume plain-text mem-command responses
  // and also needs injection / L0 / skill extraction; it just cannot pop a form.
  const _dshHeadless = agentSource === "dsh" && (() => {
    const tools = (body as { tools?: unknown }).tools;
    if (!Array.isArray(tools) || tools.length === 0) return false;
    return !tools.some((t) => {
      const fn = (t as { function?: { name?: string }; name?: string })?.function;
      const n = fn?.name ?? (t as { name?: string })?.name;
      return n === "ask_user_question";
    });
  })();
  if (_dshHeadless) {
    console.log(`[request-classify] session=${sessionKey} agent=dsh headless/no-preset (no ask_user_question tool) → bypass session-init, direct passthrough`);
  }

  // ── mem:session-reset pre-hook ──
  // hermes / openclaw preselect identity via headers, and dsh headless has no
  // ask_user_question tool — none of the three has an interactive form UI to pop, so
  // after a reset the session would sit stuck at pending_asset_confirm forever.
  // Return a plain "not supported" message instead.
  const _headerOnlyAgents = new Set(["hermes", "openclaw"]);
  const _noFormAgent = _headerOnlyAgents.has(agentSource) || _dshHeadless;
  if (config.memCommand?.enabled && !isAuxiliary && _noFormAgent) {
    const { isSessionResetCommand } = await import("./mem-command/pre-intercept.js");
    if (isSessionResetCommand(body as Record<string, unknown>, agentSource)) {
      const { buildMemResponse } = await import("./mem-command/response-builder.js");
      console.log(`[mem-command:pre] session-reset unsupported for agent=${agentSource} dshHeadless=${_dshHeadless}`);
      const msg = _headerOnlyAgents.has(agentSource)
        ? `⚠️ mem:session-reset is not supported for the ${agentSource} client.\n\n`
          + `${agentSource} preselects its identity via the x-team-id / x-agent-id / x-task-id request headers, so there is no interactive form entry.\n`
          + `Switch Team / Agent / Task by changing those request headers directly in your client configuration.`
        : "⚠️ mem:session-reset is not supported in dsh headless mode.\n\n"
          + "In headless / no-preset scenarios the dsh client carries no ask_user_question tool, so the asset-selection form cannot be shown.\n"
          + "Please use it in a dsh environment that ships the ask_user_question preset.";
      return buildMemResponse(msg, {
        protocol: "openai",
        stream: isStream,
        requestId: `mem-reset-unsupported-${Date.now()}`,
      });
    }
  }
  if (config.memCommand?.enabled && !isAuxiliary && !_dshHeadless && !_headerOnlyAgents.has(agentSource)) {
    const { isSessionResetCommand } = await import("./mem-command/pre-intercept.js");
    if (isSessionResetCommand(body as Record<string, unknown>, agentSource)) {
      const { isMemCommandAllowed, parseMemCommand } = await import("./mem-command/index.js");
      const memCmd = parseMemCommand(body as Record<string, unknown>, agentSource);
      if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
        const { getSessionStore } = await import("./session/store.js");
        const store = getSessionStore();
        const compositeKey = `${agentSource}:${sessionKey}`;
        store.bind(compositeKey, { userId: userId || "anonymous", agentSource, sessionId: sessionKey, spaceId });

        // ── Force-archive the old agent's skill buffer (best-effort) ──
        // Before the reset, the old agent's accumulated conversation fragments may not
        // have reached the threshold; without a flush they would be lost permanently.
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

  // ── Session Init (before injection pipeline) ─────────────────────────────
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("./injection/types.js").AssetCapabilityFlags | undefined;
  let injectedSkipped = !conversationId || isAuxiliary || _dshHeadless;
  let sessionJustRegistered = false;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;
  console.log(`[injection-debug] conversationId=${conversationId} sessionKey=${sessionKey} userId=${userId} agentSource=${agentSource} kind=${_requestKind} dshHeadless=${_dshHeadless} sessionInitEnabled=${config.sessionInit?.enabled} injectionEnabled=${config.injection?.enabled} injectors=${JSON.stringify(config.injection?.injectors)} injectedSkipped=${injectedSkipped} spaceId=${spaceId}`);
  if (config.sessionInit?.enabled && conversationId && !isAuxiliary && !_dshHeadless) {
    try {
      const { getSessionStore, handleSessionInit, parsePresetIdentity } = await import("./session/index.js");
      const { getMetadataClient } = await import("./meta/client.js");
      const store = getSessionStore();
      // kernel /v3/meta/* endpoints authenticate via x-tdai-user-key, which needs an
      // sk-mem-* user key.
      // Priority: the client's Authorization bearer > config.tdai.apiKey.
      // Rationale:
      //   - real clients like workbuddy / codebuddy send a valid sk-mem-* user key
      //     (e.g. ck_ft1xxx.yyy) in Authorization, and verifyUserKey can resolve its userId.
      //   - config.tdai.apiKey is often a placeholder (e.g. "local") in local / test
      //     environments; overriding the client's real key with it would make the kernel
      //     return 401 invalid_user_key, session-init bypasses, and the front-end form
      //     never pops.
      //   - Only when the client provides no apiKey (e.g. some internal scripts) do we
      //     fall back to config.
      // Aligned with the kernelUserKey logic in workbuddyHandler.ts (client-first there too).
      const kernelUserKey = apiKey || config.tdai?.apiKey || "";
      const metadataClient = getMetadataClient(config.coreSkill, spaceId, kernelUserKey);
      const presetIdentity = parsePresetIdentity(config.sessionInit, lcHeaders);

      // ── Session Recovery: try L2b binding before falling into session-init form ──
      const compositeKey = `${agentSource}:${sessionKey}`;
      // Identity for repo/binding writes. When userId is missing, fall back to the
      // `anonymous` composite key so the key-path segments stay valid (`u=anonymous`
      // lives in its own namespace, naturally isolated from requests that have a
      // userId). See §4.4 edge-case handling.
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
      // Track whether this turn really went through the handleSessionInit state machine
      // (see the mirrored comment in anthropicHandler). sessionJustRegistered is set
      // when wentThrough && justRegistered, covering both terminal transitions — normal
      // registration and bypass (the bypass branch now also carries justRegistered=true)
      // — so the mem-command intercept block can, on the bypass turn, use checkFirst to
      // fish out the user's original mem: command and return a "not initialized" message
      // instead of letting it leak upstream into an LLM hallucination.
      // On the L2b recovery branch justRegistered=true is only a prewarm signal; when
      // going through the recovered branch, wentThroughSessionInitStateMachine=false
      // filters it out naturally, so it never reaches sessionJustRegistered.
      let wentThroughSessionInitStateMachine = false;
      // The recovery-hit source decides whether prewarm is needed:
      //   - l1 / l2a: this pod's memory + storage are both hot — the hook-cache is most
      //     likely present too, so skip prewarm;
      //   - l2b / history-scan: cross-pod cold start / rebuilt from a binding — the
      //     hook-cache may be stale and needs a refill.
      // The old unconditional `justRegistered: true` made every routine L1-hit-terminal
      // turn run the full skill/knowledge/tdai-memory network round (~2s + 3 external
      // calls) and repeatedly amplified knowledge's first-time timeout odds. Here the
      // decision is made precisely from the recovery source.
      const needsPrewarm =
        recovered?.__recoverySource === "l2b" ||
        recovered?.__recoverySource === "history-scan";
      if (recovered && isTerminalState) {
        // Recovery hit: keep original messages, only re-inject <session_context>
        // so this turn's system message carries agent/task context again.
        // The user's conversation is always kept as-is, including session_init form
        // interactions — nothing is removed.
        const { injectSessionContextWithToggles } = await import("./session/context-injector.js");
        const inMsgs = (body.messages as Array<Record<string, unknown>>) ?? [];
        const outMsgs = recovered.bypassed
          ? inMsgs
          : injectSessionContextWithToggles(
              inMsgs,
              recovered.agentDetail ?? null,
              recovered.taskDetail ?? null,
              config.sessionInit,
              sessionKey,
            );
        initResult = {
          intercepted: false,
          messages: outMsgs as Record<string, unknown>[],
          sessionInfo: recovered.sessionInfo,
          agentDetail: recovered.agentDetail,
          taskDetail: recovered.taskDetail,
          bypassed: recovered.bypassed,
          justRegistered: needsPrewarm, // triggers prewarm only on L2b / history-scan recovery
        };
      } else {
        // opencode goes through the same generic else branch as codebuddy (reusing
        // handleSessionInit + the ask_followup_question form). Verifies how the opencode
        // client really reacts to an unknown tool_call.
        wentThroughSessionInitStateMachine = true;
        // Detect whether the client's ask_followup_question schema declares the
        // questions field as an array. CB v1.106+ declares it as an array and does a
        // type check; older versions have no schema or no type declaration for questions.
        let questionsAsArray = true; // assume the new version by default
        const clientTools = Array.isArray(body.tools) ? body.tools as unknown[] : [];
        const afqTool = clientTools.find((t: any) =>
          t?.function?.name === "ask_followup_question" || t?.name === "ask_followup_question"
        ) as Record<string, unknown> | undefined;
        if (afqTool) {
          const params = (afqTool as any).function?.parameters ?? (afqTool as any).parameters;
          const qType = params?.properties?.questions?.type;
          questionsAsArray = qType === "array";
        } else if (clientTools.length === 0) {
          // No tools defined (very old client or a non-CB agent) — conservatively use string
          questionsAsArray = false;
        }
        initResult = await handleSessionInit(
          sessionKey,
          userId || null,
          body.messages as Array<Record<string, unknown>> ?? [],
          config.sessionInit,
          store,
          { stream: isStream, modelId: modelId as string, protocol: "openai", questionsAsArray },
          agentSource,
          metadataClient,
          kernelUserKey,
          spaceId,
          presetIdentity,
        );
      }

      // Case 1: Fake form returned → must not forward
      if (initResult.intercepted && initResult.response) {
        return initResult.response;
      }

      console.log(`[injection-debug] initResult session=${sessionKey} intercepted=${initResult.intercepted} bypassed=${initResult.bypassed} justRegistered=${initResult.justRegistered} resetFlow=${(initResult as any).resetFlow} hasSessionInfo=${!!initResult.sessionInfo} hasAgentDetail=${!!initResult.agentDetail}`);
      // See the mirrored spot in anthropicHandler: only inherit when we actually went
      // through the sessionInit state machine.
      if (wentThroughSessionInitStateMachine && initResult.justRegistered) sessionJustRegistered = true;

      // Case 1.5: Bypass path → skip ALL injection hooks
      if (initResult.bypassed) {
        injectedSkipped = true;
        console.log(`[session-init] session=${sessionKey} bypassed → skipping all injection`);
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
            userKey: apiKey || null,
            timeoutMs: config.tdai.memory.timeoutMs,
          });
          console.log(`[asset-capability] user=${(initResult.sessionInfo as { user_id?: string }).user_id ?? "-"} flags=${JSON.stringify(assetCapabilities)}`);
        } catch (err) {
          console.warn(`[asset-capability] resolve failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Restore space_id from the URL BEFORE prewarm. Recovery paths and
      // legacy sessions can hydrate a SessionInfo whose `space_id` is empty;
      // prewarm calls (skill-injector, memory-injector) route to the correct
      // kernel tenant via this field, so a missing value at this point
      // silently poisons the prewarm cache with empty results.
      // See BUG-skill-injection-multinode.md §3.3(B).
      const { restoreSessionSpaceId } = await import("./session/restore-space-id.js");
      restoreSessionSpaceId(
        initResult.sessionInfo as Record<string, unknown> | null | undefined,
        spaceId,
      );

      // Prewarm front gate: a turn that hits a mem-command does not forward upstream
      // nor consume hook-cache, so prewarming as usual would waste 2-3s + 3 network
      // calls (amplifying knowledge's 33% timeout odds). Do a pure string parse here
      // first (<1ms, side-effect free); on a hit set memCommandPending to short-circuit
      // the prewarm branch — the actual mem-command still runs in its original spot
      // below, keeping L0 writes / skill extract / langfuse intact.
      //
      // Fallback semantics: sessionJustRegistered is already finalized here (see L786
      // above), so it is safe to reuse in the checkFirst scenario.
      let memCommandPending = false;
      if (config.memCommand?.enabled && !isAuxiliary && !_dshHeadless) {
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
            "[mem-command] pre-prewarm peek failed:",
            err instanceof Error ? err.message : String(err),
          );
          // A peek failure never blocks the main path — it degrades to the previous
          // behavior (normal prewarm).
        }
      }

      // Case 2 success → await prewarm so the first-turn pipeline always
      // hits the cache. A fire-and-forget void() here caused the bug where
      // the pipeline ran before the cache was populated, silently injecting
      // zero blocks for the entire first turn.
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
            callerUserKey: apiKey ?? undefined,
          }, { clearBefore: true });
        } catch (err) {
          console.warn(
            "[hook-cache] handler prewarm error:",
            err instanceof Error ? err.message : String(err),
          );
          // Don't re-throw: the pipeline's resolveHookBlocks has its own
          // cache-miss → execute() fallback as a safety net (see pipeline.ts).
        }
      }

      // Case 2: Messages were cleaned → update body
      if (initResult.messages) {
        body = { ...body, messages: initResult.messages };
        messages = initResult.messages as unknown[];
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      // Belt-and-suspenders: also restore on the local `sessionInfo` alias.
      // In practice this is the same object reference as
      // `initResult.sessionInfo` (already restored above), but the second
      // call is a no-op and guards against future refactors that copy
      // the object between these two lines.
      restoreSessionSpaceId(sessionInfo, spaceId);

      // Record the resetFlow info at the outer scope so the confirmation response can be
      // returned once the session-init block finishes
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
      console.error("[session-init] Error in handleSessionInit:", err instanceof Error ? err.message : String(err));
      sessionInfo = undefined;
      injectedSkipped = true;
    }
  }

  // ── mem:session-reset completion confirmation ────────────────────────────────
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
      protocol: "openai",
      stream: isStream,
      requestId: `mem-reset-${Date.now()}`,
    });
  }

  // ── mem: command intercept ────────────────────────────────────────────────
  // Positioned to match anthropicHandler.ts:847 — after session init, before injection.
  // On a hit: execute the command → write L0 → trigger skill extract → return a forged
  // OpenAI response, skipping injection (so the KV cache is intact) and upstream
  // forwarding (zero token cost). When the memCommand.enabled switch is off this whole
  // section is skipped and the original path is used.
  //
  // The pitfall it solves: CodeBuddy hits this handler over the OpenAI protocol, but
  // the mem-command intercept used to live only in anthropicHandler, so a CB user
  // sending `mem:help` was forwarded straight to the upstream LLM, which returned a
  // hallucinated "help text" (listing non-existent commands such as mem:atoms /
  // mem:profile / mem:conversations). Added after reproducing it via packet capture
  // (langfuse trace d814929a...).
  //
  // Request classification: the OpenAI protocol does not do CC-style fork/sidequery
  // routing (handler.ts does not hook CC routing); every request is treated as main —
  // matching the codebuddy adapter's classifyRequest.
  if (config.memCommand?.enabled && !isAuxiliary && !_dshHeadless) {
    const { parseMemCommand, isMemCommandAllowed, executeMemCommand, buildMemResponse, extractSimpleMessages, truncateArgs } = await import("./mem-command/index.js");
    // Regular check: the last user message
    let memCmd = parseMemCommand(body as Record<string, unknown>, agentSource);
    // When the session-init state machine reaches a terminal state (initialized or
    // bypassed) this turn, the last user message is an init-interaction reply (e.g.
    // "no"), so additionally check the first user message — the user's original
    // intent. In the bypass scenario sessionInfo=null hits the "not initialized"
    // branch and returns a message, keeping the first mem: command from being swallowed
    // into history and then leaking into an LLM passthrough.
    if (!memCmd && sessionJustRegistered) {
      memCmd = parseMemCommand(body as Record<string, unknown>, agentSource, { checkFirst: true });
    }
    // session-reset is already handled by the pre-hook; skip it here to avoid running
    // it twice — see the same-named section in anthropicHandler
    if (memCmd?.command === "session-reset") memCmd = null;
    if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
      // When the session is not initialized the command is unavailable (same message
      // as the anthropic side)
      if (!sessionInfo || injectedSkipped) {
        const errText = `⚠️ Session not initialized; the command is unavailable. Please finish session initialization (choose a Team/Agent) first and retry.`;
        const errResponse = buildMemResponse(errText, {
          protocol: "openai",
          stream: isStream,
          requestId: `mem-cmd-${Date.now()}`,
        });
        console.log(`[mem-command] cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} blocked: session not initialized`);
        return errResponse;
      }
      const memResult = await executeMemCommand(memCmd, {
        sessionKey,
        agentSource,
        config,
        spaceId,
        userId,
        apiKey: apiKey || "",
        sessionInfo: sessionInfo as Record<string, unknown>,
        protocol: "openai",
        stream: isStream,
        args: memCmd.args,
        // The task command family drafts from the recent conversation; the OpenAI/CC/CB
        // protocols read it directly from body.messages.
        bodyMessages: extractSimpleMessages(body.messages),
        // The OpenAI protocol has no extended-thinking concept — always false
      });

      // L0 write — synchronous await ensures it is persisted before returning (unlike
      // the main conversation path's trackWrite/withL0Retry fallback, this mem-command
      // path is "run once", so it must wait explicitly).
      const tdaiClientForMem = createTdaiClient(config, spaceId);
      const tdaiIdentityForMem = deriveTdaiIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
      });
      if (tdaiClientForMem && tdaiIdentityForMem && isExtractionAllowed(config, "tdai-memory")) {
        const userMsg = { role: "user" as const, content: memCmd.rawMessage };
        try {
          await recordTdaiTurn(tdaiClientForMem, tdaiIdentityForMem, userMsg, memResult.messageText);
        } catch (err: unknown) {
          console.error("[mem-command] L0 write error:", err);
        }
      }

      // Skill extract trigger — keeps the conversation turn count accumulating
      // correctly (symmetric with the anthropic side)
      if (isExtractionAllowed(config, "skill")) {
        try {
          // On the OpenAI protocol assistant content is a string; the
          // normalize-conversation side handles the string form via the
          // convertOpenAIAssistant fallback.
          const assistantMsg = { role: "assistant", content: memResult.messageText };
          await triggerSkillExtractIfReady({
            config,
            sessionKey,
            agentSource,
            sessionInfo: sessionInfo as Record<string, unknown>,
            inputMessages: messages as unknown[],
            assistantMessage: assistantMsg,
            protocol: "openai",
            assetCapabilities,
          });
        } catch (err: unknown) {
          console.warn("[mem-command] skill extract trigger error:", err instanceof Error ? err.message : String(err));
        }
      }

      console.log(`[mem-command] cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} success=${memResult.success}`);

      // Langfuse: report the mem-command (symmetric with anthropicHandler).
      //   `lf` is only built at L955, so derive turnSeq → traceId inline here.
      const memTurnSeq = countHumanTurns(messages, "openai");
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
          "protocol:openai",
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

  // aux requests (compaction/title) and dsh headless (no UI, no preset) do not write
  // L0 — pass them straight through
  const tdaiClient = isAuxiliary || _dshHeadless || assetCapabilities?.chat_memory === false ? null : createTdaiClient(config, spaceId);
  const tdaiIdentity = injectedSkipped
    ? null
    : deriveTdaiIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
      });
  const tdaiUserMessage = extractLatestUserMessage(messages);

  // ── Context injection (before cost guard) ──────────────────────────────
  if (!injectedSkipped && config.injection?.enabled && config.injection.injectors.length > 0) {
    try {
      const injectionTurnSeq = countHumanTurns(messages, "openai");
      const { getInjectionPipeline } = await import("./injection/index.js");
      const pipeline = getInjectionPipeline(config);
      const injectedBody = await pipeline.process(body, {
        protocol: "openai",
        traceId,
        keyId,
        modelId: modelId as string,
        stream: isStream,
        agentSource,
        userId: userId || "anonymous",
        spaceId,
        sessionKey,
        turnSeq: injectionTurnSeq,
        // Pass through the raw request path — AssetReflectionInjector uses it to
        // detect the `/analyse` marker. No other injector depends on this field.
        requestPath: c.req.path,
        custom: sessionInfo
          ? {
              session: sessionInfo,
              assetCapabilities,
              userKey: apiKey || undefined,
            }
          : undefined,
      });
      body = injectedBody;
      messages = Array.isArray(injectedBody.messages) ? injectedBody.messages : messages;
    } catch (err: unknown) {
      // Injection failure is non-fatal — fall back to original body
    }
  }

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // ── Resolve forward target (opaque extension — no routing logic here) ──
  // upstream.agents[agent] is a single map keyed by agent name — same lookup
  // as anthropicHandler. Empty / missing entry → fall back to upstream.url,
  // preserving legacy behavior for configs that don't declare `agents:` at all.
  const agentUpstreamEntry = agentFromPath ? config.upstream.agents?.[agentFromPath] : undefined;
  // Per-agent apiKey resolution — three cases:
  //   (a) no entry in agents map           → global upstream.apiKey (fallback)
  //   (b) entry present, apiKey empty      → "" (passthrough, keep client key)
  //   (c) entry present, apiKey non-empty  → agent.apiKey (server-side key)
  // Presence of an entry (case b/c) cuts the global fallback — that's what
  // lets one proxy serve mixed server-key / client-key agents at once.
  const effectiveApiKey = agentUpstreamEntry
    ? (agentUpstreamEntry.apiKey ?? "")
    : config.upstream.apiKey;
  // Normalize the request path to the canonical upstream endpoint so the
  // extension's URL joining matches the host whitelist behavior.
  const forwardEndpoint = matchWhitelistEndpoint(c.req.path)?.upstreamEndpoint ?? "/chat/completions";
  // Isolation key is user-namespaced (`${user}:${session}`) so two users that
  // share the same client session id can't contaminate each other's state /
  // turn counting. ClickHouse keeps the raw session_key (it has its own
  // user_id column); this composite is internal to the extension only.
  const target: ForwardTarget = await resolveForwardTarget(config, {
    keyId: `${keyId}:${sessionKey}`,
    messages,
    protocol: "openai",
    hasTools,
    body,
    modelId,
    defaultUpstreamUrl: agentUpstreamEntry?.url ?? config.upstream.url,
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

  // ── Trace-level tags ──
  // agent_source marks the client family (codebuddy / claude-code / codex / ...) so
  // traces can be filtered by client in Langfuse; protocol only distinguishes the wire
  // protocol, and one wire protocol can back several clients.
  const traceTags: string[] = [
    `agent_source:${agentSource}`,
    "protocol:openai",
    isStream ? "stream" : "non-stream",
    `session:${sessionKey}`,
  ];

  // ── Langfuse turn context: one trace = one turn (deterministic traceId) ──
  // Same (sessionKey, turnSeq) across a turn's tool-loop requests → same trace.
  // Prefer the extension's monotonic per-session turnSeq (survives context
  // compaction); fall back to the stateless count when it's not tracked.
  const turnSeq = target.turnSeq > 0 ? target.turnSeq : countHumanTurns(messages, "openai");
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
  // CB / cursor / windsurf hit this handler over the OpenAI protocol; when debug is on,
  // stuff the request structure + client fingerprint into Langfuse observationMetadata
  // for packet-capture analysis. Off by default ({}), so live traces stay clean. See
  // common/langfuse-debug.ts.
  const langfuseDebug = config.langfuse.debug === true;
  const debugMetadata = buildRequestDebugMetadata({
    debug: langfuseDebug,
    body: body as Record<string, unknown>,
    headers: reqHeaders,
    agentSource,
    // This handler does not do CC-style fork/sidequery routing (only anthropicHandler
    // runs that)
    spaceId,
    turnSeq,
    requestPath: c.req.path,
    protocol: "openai",
  });

  // ── Opik: create trace ───────────────────────────────────────────────────
  const forkTraceId = opikCreateTrace(config, {
    traceId,
    projectName: keyId,
    name: `${target.model} / ${keyId}`,
    startTime,
    input: { messages: flattenMessagesForOpik(messages) },
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
  const upstreamHeaders = buildUpstreamHeaders(c, config, target, sessionKey, effectiveApiKey);

  // Optional private preparation stage. It rewrites `body` / `messages` in
  // place, so it has to land after every host-side mutation (injection, agent
  // overrides) and before the upstream body is assembled below. The host does
  // not interpret the returned stats — see request-prepare-adapter.ts.
  const preparedStats = await prepareUpstreamRequest({
    config,
    protocol: "openai",
    body,
    messages,
    sessionKey,
    pipe,
    upstreamCall: {
      upstreamUrl: target.url,
      headers: upstreamHeaders,
      model: target.model,
      tools: body.tools,
      bodyOverrides: target.bodyOverrides ?? undefined,
    },
    userQuery: lf.userQuery,
    spaceId,
    lf,
  });

  const upstreamBody = buildUpstreamBody(body, target);
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
  // Retry uses the same effective key as the primary path — when it
  // resolves to "" (agent entry present but no apiKey), retry also runs
  // on the client's own key, preserving the passthrough intent.
  if (effectiveApiKey) {
    originalHeaders["authorization"] = `Bearer ${effectiveApiKey}`;
  }

  // Inject stream_options.include_usage for OpenAI compat
  if (isStream) {
    upstreamBody.stream_options = {
      ...(typeof upstreamBody.stream_options === "object" && upstreamBody.stream_options !== null
        ? (upstreamBody.stream_options as object)
        : {}),
      include_usage: true,
    };
  }

  // ── Forward to upstream (with automatic retry if configured) ──────────────
  const forwardTimeoutMs = config.server.forwardTimeoutMs ?? 600_000;
  // Pass target.url so the FORWARD log reflects the actual per-agent upstream
  // (otherwise it prints the global default and misleads triage).
  pipe.forwardStart(target.url);
  let upstreamResp: Response;
  let retried = false;

  try {
    const result = await forwardWithRetry(
      target, upstreamHeaders, upstreamBody,
      body, originalHeaders,
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
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      statusMessage: err instanceof Error ? err.message : "Upstream request failed",
      extraTags: ["error"],
      observationMetadata: { stage: "forward", ...debugMetadata },
    });
    return c.json({ error: "Upstream request failed" }, 502);
  }

  // Build response headers (strip hop-by-hop)
  const respHeaders = new Headers();
  for (const [k, v] of upstreamResp.headers.entries()) {
    if (!SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) {
      respHeaders.set(k, v);
    }
  }

  // Upstream request id from response header (tokenhub / OpenAI-compatible
  // gateways set `x-request-id`). Used for cross-system tracing/audit.
  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";

  const effectiveModel = retried && target.retryTarget
    ? target.retryTarget.model
    : target.model;

  // A retry falls back to the model the client asked for, so the request ends
  // up costing what it would have cost unrouted — no saving to attribute.
  const routedFrom = retried ? "" : target.routedFrom;
  // `routedFrom` is also present in cost-guard's opaque logMeta. Keep the
  // normalized post-retry value authoritative so fallback requests never book
  // savings or carry stale route attribution.
  const { routedFrom: _ignoredRoutedFrom, ...routeLogMeta } = target.logMeta;
  const responseLogMeta = {
    ...routeLogMeta,
    ...(retried ? { retrySuccess: true } : {}),
  };

  // ── Streaming response ───────────────────────────────────────────────────
  if (isStream) {
    if (!upstreamResp.body) {
      pipe.streamDone(null);
      return new Response(null, { status: upstreamResp.status, headers: respHeaders });
    }

    // Log upstream error body for 4xx responses
    if (!retried && upstreamResp.status >= 400 && upstreamResp.status < 500) {
      const [errBodyStream, clientPassStream] = upstreamResp.body.tee();
      const errText = await new Response(errBodyStream).text();
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
        input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
        status: upstreamResp.status,
        statusMessage: errText.slice(0, 500),
        extraTags: ["error"],
        observationMetadata: { stage: "upstream", stream: true, ...debugMetadata },
      });
      pipe.streamDone(null);
      return new Response(clientPassStream, { status: upstreamResp.status, headers: respHeaders });
    }

    pipe.streamStart();

    const tapCtx: TapContext = {
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
      retried,
      logMeta: responseLogMeta,
      routedFrom,
      tdaiClient,
      tdaiIdentity,
      tdaiUserMessage,
      assetCapabilities,
      pipe,
      sessionKeyForSkill: sessionKey,
      agentSource,
      isAuxiliary,
      isDshHeadless: _dshHeadless,
      sessionInfo,
      lf,
      spaceId,
      upstreamRequestId,
      langfuseDebug,
      debugMetadata,
      preparedStats,
    };
    const passthrough = createUsageTapTransform(tapCtx);
    const tappedStream = upstreamResp.body.pipeThrough(passthrough);

    return new Response(tappedStream, { status: upstreamResp.status, headers: respHeaders });
  }

  // ── Non-streaming response ───────────────────────────────────────────────
  const respText = await upstreamResp.text();
  const endTime = new Date().toISOString();

  let usage: Record<string, unknown> | null = null;
  let assistantMessage: Record<string, unknown> | null = null;
  try {
    const respJson = JSON.parse(respText) as Record<string, unknown>;
    if (respJson.usage && typeof respJson.usage === "object") {
      usage = respJson.usage as Record<string, unknown>;
    }
    const choices = respJson.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const msg = (choices[0] as Record<string, unknown>).message;
      if (msg && typeof msg === "object") {
        assistantMessage = msg as Record<string, unknown>;
      }
    }
  } catch {
    // non-JSON upstream response
  }

  const logMeta = responseLogMeta;

  // Report the completed response to the extension (same signal the streaming
  // path emits from its tap). Fire-and-forget.
  void notifyUpstreamResponse(
    config,
    {
      protocol: "openai",
      sessionKey,
      model: effectiveModel,
      stream: false,
      turnSeq: lf.turnSeq,
      text: typeof assistantMessage?.content === "string" ? assistantMessage.content : "",
      toolCalls: (Array.isArray(assistantMessage?.tool_calls) ? assistantMessage.tool_calls : [])
        .map((tc) => {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          const argsVal = fn?.arguments;
          return {
            id: (t.id as string) ?? "",
            name: (fn?.name as string) ?? "",
            arguments: typeof argsVal === "string" ? argsVal : JSON.stringify(argsVal ?? ""),
          };
        })
        .filter((tc) => tc.id && tc.arguments),
      usage: usage ?? {},
    },
    pipe,
  );

  // Internal-usage telemetry: record each tool_call in a non-streaming response as a
  // model_intent.
  try {
    const toolCalls = assistantMessage?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const intents = toolCalls
        .map((tc) => {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          const name = (fn?.name as string) ?? "";
          const argsVal = fn?.arguments;
          const argsStr = typeof argsVal === "string" ? argsVal : JSON.stringify(argsVal ?? "");
          return { name, arguments: argsStr };
        })
        .filter((i) => i.name);
      if (intents.length > 0) {
        emitModelIntentTelemetry({
          // Match the compositeKey shape used by session_init_logs
          sessionKey: `${agentSource}:${sessionKey}`,
          turnSeq: lf.turnSeq,
          spaceId,
          userId: keyId,
          agentSource,
          intents,
        });
      }
    }
  } catch {
    // Telemetry must never block business logic
  }

  if (usage) {
    await recordInputTokenUsage({
      config,
      instanceId: spaceId || undefined,
      modelId: effectiveModel,
      usage,
      protocol: "openai",
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

    const outputMessages = assistantMessage ? [assistantMessage] : [];
    opikUpdateTrace(config, {
      traceId,
      projectName: keyId,
      endTime,
      output: outputMessages,
      usage,
    });
    if (forkTraceId && !config.opik.stripRequestLogContent) {
      opikUpdateTrace(config, {
        traceId: forkTraceId,
        projectName: "request_log",
        endTime,
        output: outputMessages,
        usage,
      });
    }

    if (tdaiClient && isExtractionAllowed(config, "tdai-memory")) {
      await recordTdaiTurn(tdaiClient, tdaiIdentity, tdaiUserMessage, assistantContentForTdai(assistantMessage));
    } else if (tdaiClient) {
      logExtractionSkipped(config, "tdai-memory", sessionKey);
    }

    opikCreateLlmSpan(config, {
      traceId,
      projectName: keyId,
      name: effectiveModel,
      startTime,
      endTime,
      inputMessages: flattenMessagesForOpik(messages),
      outputMessage: assistantMessage,
      model: effectiveModel,
      usage,
      tags: [
        "non-stream",
        ...(retried ? ["retry"] : []),
      ],
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
    langfuseReportGeneration({
      traceId: lf.traceId,
      name: effectiveModel,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      output: assistantMessage,
      usage,
      traceName: lf.traceName,
      userId: lf.userId,
      sessionId: lf.sessionId,
      tags: lf.tags,
      traceInput: lf.userQuery || undefined,
      traceOutput: assistantMessage ?? undefined,
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
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      status: upstreamResp.status,
      statusMessage: respText.slice(0, 500),
      extraTags: ["error"],
      observationMetadata: { stage: "upstream", stream: false, ...debugMetadata },
    });
  }

  pipe.responseDone(usage);

  // Skill extract trigger — count tool calls + buffer conversation.
  // Synchronous await: do not continue until the store has persisted, so the next
  // turn reads the latest data across nodes. aux requests (compaction/title) and dsh
  // headless do not trigger skill extraction — keeps the archived-buffer semantics clean.
  if (!isAuxiliary && !_dshHeadless && isExtractionAllowed(config, "skill")) {
    await triggerSkillExtractIfReady({
      config,
      sessionKey,
      agentSource,
      sessionInfo,
      inputMessages: messages,
      assistantMessage,
      protocol: "openai",
      assetCapabilities,
    });
  } else if (!isAuxiliary && !_dshHeadless) {
    logExtractionSkipped(config, "skill", sessionKey);
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


function assistantContentForTdai(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") return p.text;
      if (typeof p.content === "string") return p.content;
      return "";
    }).filter(Boolean).join("\n") || null;
  }
  return content == null ? null : JSON.stringify(content);
}

function outputMessageContent(message: Record<string, unknown> | null): string | null {
  return assistantContentForTdai(message);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

interface TapContext {
  config: ProxyConfig;
  modelId: string;
  keyId: string;
  sessionKey: string;
  upstreamUrl: string;
  traceId: string;
  forkTraceId: string;
  requestPath: string;
  startTime: string;
  inputMessages: unknown[];
  retried: boolean;
  logMeta: Record<string, unknown>;
  /** Requested model when the router forwarded elsewhere; "" otherwise. */
  routedFrom: string;
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  tdaiUserMessage: TdaiMessage | null;
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
  pipe: ReturnType<typeof createPipeline>;
  /** For skill extract trigger; null when session_init is disabled. */
  sessionKeyForSkill: string;
  /** Client type (first segment of the URL path) — passed to the extract trigger as one of the three-part isolation keys. */
  agentSource: string;
  /** True when this request was classified as auxiliary (compaction/title-gen) —
   * downstream L0/skill extract paths must skip to keep buffer semantics clean. */
  isAuxiliary: boolean;
  /** True when this dsh request came from CLI headless / no-preset (no ask_user_question
   * in tools) — behaves like aux for downstream side-effects. */
  isDshHeadless: boolean;
  sessionInfo: Record<string, unknown> | null | undefined;
  /** Langfuse turn-trace context (trace = one turn). */
  lf: LangfuseTurnContext;
  /** Space/tenant ID from request path. */
  spaceId?: string;
  /** Upstream response header `x-request-id` (empty when not returned). */
  upstreamRequestId?: string;
  /** The result of evaluating `config.langfuse.debug === true`. */
  langfuseDebug: boolean;
  /** Result of buildRequestDebugMetadata; {} when debug=false. */
  debugMetadata: Record<string, unknown>;
  /** Opaque counters from the request-preparation stage; null when it didn't run. */
  preparedStats: Record<string, unknown> | null;
}

/** Accumulated tool call state during SSE streaming. */
interface ToolCallAccumulator {
  id: string;
  type: string;
  functionName: string;
  functionArguments: string;
}

/** Result of extracting content + tool_calls from SSE text. */
interface SseExtractResult {
  content: string;
  toolCallDeltas: Array<{ index: number; id?: string; type?: string; functionName?: string; functionArguments?: string }>;
}

/** Extract assistant content and tool_call deltas from OpenAI SSE text. */
function extractSseContentAndTools(sseText: string): SseExtractResult {
  let content = "";
  const toolCallDeltas: SseExtractResult["toolCallDeltas"] = [];

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      const choices = evt.choices;
      if (Array.isArray(choices) && choices.length > 0) {
        const delta = (choices[0] as Record<string, unknown>).delta as Record<string, unknown> | undefined;
        if (typeof delta?.content === "string") {
          content += delta.content;
        }
        const tcArr = delta?.tool_calls;
        if (Array.isArray(tcArr)) {
          for (const tc of tcArr) {
            const t = tc as Record<string, unknown>;
            const idx = typeof t.index === "number" ? t.index : 0;
            const fn = t.function as Record<string, unknown> | undefined;
            toolCallDeltas.push({
              index: idx,
              id: typeof t.id === "string" ? t.id : undefined,
              type: typeof t.type === "string" ? t.type : undefined,
              functionName: typeof fn?.name === "string" ? fn.name : undefined,
              functionArguments: typeof fn?.arguments === "string" ? fn.arguments : undefined,
            });
          }
        }
      }
    } catch {
      // ignore malformed SSE lines
    }
  }
  return { content, toolCallDeltas };
}

/** Merge accumulated tool_call deltas into complete tool_call objects. */
function mergeToolCallDeltas(
  accumulators: Map<number, ToolCallAccumulator>,
  deltas: SseExtractResult["toolCallDeltas"],
): void {
  for (const d of deltas) {
    let acc = accumulators.get(d.index);
    if (!acc) {
      acc = { id: "", type: "function", functionName: "", functionArguments: "" };
      accumulators.set(d.index, acc);
    }
    if (d.id) acc.id = d.id;
    if (d.type) acc.type = d.type;
    if (d.functionName) acc.functionName += d.functionName;
    if (d.functionArguments) acc.functionArguments += d.functionArguments;
  }
}

/** Create a TransformStream that passes bytes through unchanged,
 *  while extracting usage/content/tool_calls from SSE events in-band.
 */
function createUsageTapTransform(ctx: TapContext): TransformStream<Uint8Array, Uint8Array> {
  const { config, modelId, keyId, sessionKey, upstreamUrl, traceId, forkTraceId, startTime, inputMessages, retried, logMeta, pipe, lf, spaceId, upstreamRequestId } = ctx;

  const decoder = new TextDecoder();
  let sseBuf = "";
  let lastUsage: Record<string, unknown> | null = null;
  let assistantContent = "";
  const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

  function processSseChunk(chunk: string): void {
    sseBuf += chunk;
    const parts = sseBuf.split("\n\n");
    sseBuf = parts.pop() ?? "";
    for (const part of parts) {
      const usage = extractSseUsage(part);
      if (usage) lastUsage = usage;
      const { content, toolCallDeltas } = extractSseContentAndTools(part);
      assistantContent += content;
      mergeToolCallDeltas(toolCallAccumulators, toolCallDeltas);
    }
  }

  async function finalize(): Promise<void> {
    if (sseBuf.trim()) {
      const usage = extractSseUsage(sseBuf);
      if (usage) lastUsage = usage;
      const { content, toolCallDeltas } = extractSseContentAndTools(sseBuf);
      assistantContent += content;
      mergeToolCallDeltas(toolCallAccumulators, toolCallDeltas);
    }

    const endTime = new Date().toISOString();

    let outputMessage: Record<string, unknown> | null = null;
    if (assistantContent || toolCallAccumulators.size > 0) {
      if (toolCallAccumulators.size > 0) {
        const toolCallEntries = Array.from(toolCallAccumulators.entries())
          .sort(([a], [b]) => a - b)
          .map(([, acc]) => JSON.stringify({ tool_call_id: acc.id, tool_name: acc.functionName, arguments: acc.functionArguments }, null, 2))
          .join("\n\n");
        const parts: string[] = [];
        if (assistantContent) parts.push(assistantContent);
        parts.push(toolCallEntries);
        outputMessage = { role: "assistant", content: parts.join("\n\n") };
      } else {
        outputMessage = { role: "assistant", content: assistantContent };
      }
    }

    // Report the completed response to the extension. Fire-and-forget; the
    // client has already been served by this point.
    void notifyUpstreamResponse(
      config,
      {
        protocol: "openai",
        sessionKey,
        model: modelId,
        stream: true,
        turnSeq: lf.turnSeq,
        text: assistantContent,
        toolCalls: Array.from(toolCallAccumulators.values())
          .filter((acc) => acc.id && acc.functionArguments)
          .map((acc) => ({
            id: acc.id,
            name: acc.functionName,
            arguments: acc.functionArguments,
          })),
        usage: lastUsage ?? {},
      },
      pipe,
    );

    // Internal-usage telemetry: emit one model_intent per tool_use intent (fan-out).
    // See docs/design/2026-08-03-internal-usage-telemetry-plan.md §7.2 E.
    if (toolCallAccumulators.size > 0) {
      const intents = Array.from(toolCallAccumulators.values())
        .filter((acc) => acc.functionName)
        .map((acc) => ({ name: acc.functionName, arguments: acc.functionArguments }));
      emitModelIntentTelemetry({
        // Match the compositeKey shape used by session_init_logs
        sessionKey: `${ctx.agentSource}:${sessionKey}`,
        turnSeq: lf.turnSeq,
        spaceId: spaceId,
        userId: keyId,
        agentSource: ctx.agentSource,
        intents,
      });
    }

    if (lastUsage) {
      await recordInputTokenUsage({
        config,
        instanceId: spaceId || undefined,
        modelId,
        usage: lastUsage,
        protocol: "openai",
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
          usage: lastUsage,
          extensionStats: ctx.preparedStats ?? undefined,
          ...ctx.logMeta,
          routedFrom: ctx.routedFrom,
          spaceId,
          upstreamRequestId,
        });
      } catch (logErr: unknown) {
        pipe.error("LOG_WRITE", logErr);
      }

      try {
        const outputMessages = outputMessage ? [outputMessage] : [];
        opikUpdateTrace(config, {
          traceId,
          projectName: keyId,
          endTime,
          output: outputMessages,
          usage: lastUsage,
        });
        if (ctx.forkTraceId && !config.opik.stripRequestLogContent) {
          opikUpdateTrace(config, {
            traceId: ctx.forkTraceId,
            projectName: "request_log",
            endTime,
            output: outputMessages,
            usage: lastUsage,
          });
        }

        opikCreateLlmSpan(config, {
          traceId,
          projectName: keyId,
          name: modelId,
          startTime,
          endTime,
          inputMessages,
          outputMessage,
          model: modelId,
          usage: lastUsage,
          tags: [
            "stream",
            ...(retried ? ["retry"] : []),
          ],
          forkProjectName: "request_log",
          forkTraceId: ctx.forkTraceId,
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
      // On the streaming path inputMessages is kept as-is (other downstream pipelines
      // share the same reference); when debug=true, stuff the accumulated tool_call
      // count into metadata as a fallback.
      try {
        const streamDebugExtra = ctx.langfuseDebug
          ? {
              stream_tool_call_count: toolCallAccumulators.size,
              stream_assistant_content_len: assistantContent.length,
            }
          : {};
        langfuseReportGeneration({
          traceId: lf.traceId,
          name: modelId,
          model: modelId,
          startTime,
          endTime,
          input: buildLangfuseInputChat(inputMessages, ctx.langfuseDebug, flattenMessagesForOpik),
          output: outputMessage,
          usage: lastUsage,
          traceName: lf.traceName,
          userId: lf.userId,
          sessionId: lf.sessionId,
          tags: lf.tags,
          traceInput: lf.userQuery || undefined,
          traceOutput: outputMessage ?? undefined,
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

    if (ctx.tdaiClient && isExtractionAllowed(ctx.config, "tdai-memory")) {
      // Streaming does not await (it would slow the SSE close feel); instead use
      // trackWrite + retry:
      //   - trackWrite registers the in-flight promise in a global set; on SIGTERM
      //     index.ts flushPendingWrites waits or times out, so L0 is not lost during a
      //     pod rolling update.
      //   - withL0Retry handles a transient tdai kernel drop / 5xx (3 backoffs, ~3.5s
      //     total).
      trackWrite(
        withL0Retry(() => recordTdaiTurn(
          ctx.tdaiClient!, ctx.tdaiIdentity, ctx.tdaiUserMessage,
          outputMessageContent(outputMessage),
        )).catch((err: unknown) => pipe.error("TDAI_L0", err))
      );
    } else if (ctx.tdaiClient) {
      logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionKeyForSkill);
    }

    pipe.streamDone(lastUsage);

    // Skill extract trigger — after stream finalization.
    // Synchronous await: do not continue until the store has persisted, so the next
    // turn reads the latest data across nodes. aux requests (compaction/title) and dsh
    // headless skip skill triggering to keep the archived-buffer semantics clean.
    if (!ctx.isAuxiliary && !ctx.isDshHeadless && isExtractionAllowed(ctx.config, "skill")) {
      await triggerSkillExtractIfReady({
        config: ctx.config,
        sessionKey: ctx.sessionKeyForSkill,
        agentSource: ctx.agentSource,
        sessionInfo: ctx.sessionInfo,
        inputMessages: ctx.inputMessages,
        assistantMessage: outputMessage,
        protocol: "openai",
        assetCapabilities: ctx.assetCapabilities,
        toolCallCountOverride: toolCallAccumulators.size,
      });
    } else if (!ctx.isAuxiliary && !ctx.isDshHeadless) {
      logExtractionSkipped(ctx.config, "skill", ctx.sessionKeyForSkill);
    }

    // Credit usage reporting for streaming responses. The stream has already
    // been forwarded to the client; failures here are best-effort and can
    // only be observed via server logs (no way to retro-add response headers).
    tryReportCreditFromPath(
      ctx.config.creditReport,
      ctx.requestPath,
      lastUsage,
      ctx.config.creditPricing,
      ctx.modelId,
      ctx.upstreamUrl,
      "usage",
    )
      .then((outcome) => {
        if (outcome.attempted && !outcome.ok) {
          pipe.error("CREDIT_REPORT", `[stream] ${outcome.errorMessage ?? "unknown"}`);
          // Persist failed report as a raw record.
          writeFailedReportRaw(
            {
              timestamp: new Date().toISOString(),
              event: "usage",
              modelId: ctx.modelId,
              keyId: ctx.keyId,
              sessionKey: ctx.sessionKey,
              upstreamUrl: ctx.upstreamUrl,
              stream: true,
              usage: lastUsage === null ? undefined : lastUsage,
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

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      try {
        processSseChunk(decoder.decode(chunk, { stream: true }));
      } catch (err: unknown) {
        pipe.error("STREAM_TAP", err);
      }
    },
    async flush() {
      try {
        await finalize();
      } catch (err: unknown) {
        pipe.error("STREAM_FINALIZE", err);
      }
    },
  });
}
