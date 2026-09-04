/**
 * Auxiliary endpoint handler: Light pass-through processor.
 *
 * Used for whitelist endpoints that do not require routing decisions:
 *  - `/v1/messages/count_tokens` (Anthropic)
 *  - `/v1/embeddings` (OpenAI)
 *  - `/v1/completions` (OpenAI legacy protocol)
 *
 * Differences from main handlers (`handleAnthropicMessages` / `handleChatCompletions`):
 *  - **Skips** routing analyzer and model routing (these endpoints lack conversation reasoning semantics)
 *  - **Skips** opik/langfuse tracing (these endpoints do not constitute conversation turns, avoiding observability noise)
 *  - **Retains** auth header (apiKey) injection, credit reporting, JSONL/ClickHouse usage logging
 *
 * All request bodies in this handler are passed through as raw `ArrayBuffer`. JSON is parsed
 * only at the log/metadata level to extract the `model` field (falling back to "unknown" on failure).
 * Responses are also returned to the client as-is (non-stream: read completely then pass through; stream: `ReadableStream` directly piped).
 */

import type { Context } from "hono";
import { createPipeline, writeLog } from "./logger.js";
import { apiKeyToKeyId, extractBearerToken, uuidv7 } from "./opik.js";
import type { ProxyConfig } from "./types.js";
import {
  tryReportCreditFromPath,
  extractSpaceIdFromPath,
} from "./credit-reporter.js";
import { matchWhitelistEndpoint, type WhitelistEndpoint } from "./routes/whitelist.js";
import { joinUrl } from "./guard-adapter.js";
import { log } from "./report/log.js";
import { verifyUserKey } from "./auth.js";
import { matchSystemUserByUserId, hasSystemUsers } from "./systemUser.js";
import { handleSystemUserPassthrough } from "./systemUserPassthrough.js";

/** Hop-by-hop headers and host header: cannot be forwarded upstream. */
const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/** Response headers that should not be returned to client (avoids stream length mismatches, etc.). */
const SKIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

/**
 * Build request headers for forwarding upstream.
 *
 * Differences from main handlers: Auxiliary endpoints do not involve routing auth overrides,
 * only injecting `upstream.apiKey` according to endpoint protocol:
 *  - `anthropic` → `x-api-key` (clearing `authorization`)
 *  - `openai`    → `Authorization: Bearer`
 */
function buildAuxUpstreamHeaders(
  c: Context,
  config: ProxyConfig,
  entry: WhitelistEndpoint,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  headers["content-type"] = headers["content-type"] ?? "application/json";

  if (config.upstream.apiKey) {
    if (entry.protocol === "anthropic") {
      headers["x-api-key"] = config.upstream.apiKey;
      delete headers["authorization"];
    } else {
      headers["authorization"] = `Bearer ${config.upstream.apiKey}`;
      delete headers["x-api-key"];
    }
  }
  return headers;
}

/** Filter response headers (strip length/encoding fields), returning Headers object ready to send. */
function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  return out;
}

/**
 * Attempt to extract `model` field from request body for logging.
 * Returns "unknown" (does not throw) if body is non-JSON or missing model.
 */
function extractModelId(bodyText: string): string {
  if (!bodyText) return "unknown";
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    if (typeof parsed.model === "string" && parsed.model) return parsed.model;
  } catch {
    // ignore — non-JSON body is allowed for passthrough
  }
  return "unknown";
}

/**
 * Extract `usage` field from response text if present.
 *
 * Common shapes:
 *  - Anthropic count_tokens: entire body is `{ input_tokens: N }` — used directly as usage
 *  - OpenAI embeddings: `{ data: [...], usage: { prompt_tokens, total_tokens } }`
 *  - Others: attempt to read top-level `usage` field
 *  - Unparseable: return `null`
 */
function extractUsageFromResponse(
  respText: string,
  entry: WhitelistEndpoint,
): Record<string, unknown> | null {
  if (!respText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(respText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // Anthropic count_tokens response is { input_tokens: N } without usage wrapper
  if (entry.pathSuffix === "/v1/messages/count_tokens") {
    if (typeof obj.input_tokens === "number") return obj;
    return null;
  }

  // OpenAI series (embeddings / completions): usage is in top-level usage field
  if (obj.usage && typeof obj.usage === "object") {
    return obj.usage as Record<string, unknown>;
  }
  return null;
}

/**
 * Auxiliary endpoint handler.
 *
 * Request lifecycle:
 *  1. Match current path against whitelist table (defensive; routing layer guarantees match under normal conditions)
 *  2. Extract apiKey → keyId
 *  3. Read raw body (unparsed), extract `model` field for logging only
 *  4. `joinUrl` constructs upstream URL
 *  5. Inject auth headers according to protocol
 *  6. fetch upstream (no retries, simplified handling)
 *  7. Split handling:
 *     - stream response → pipe body directly back to client (usage parsing deferred)
 *     - non-stream → read completely → extract usage → credit reporting + JSONL logging
 *  8. Pass through status/headers/body as-is
 */
export async function handleAuxiliaryEndpoint(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();

  const entry = matchWhitelistEndpoint(c.req.path);
  if (!entry) {
    // Defensive: server.ts should guarantee only whitelist paths route to this handler.
    // Reaching here indicates configuration or routing mismatch; return 404 for quick diagnosis.
    return c.json({ error: "Unregistered endpoint" }, 404);
  }

  // 1. Authentication (resolve local keyId first, then verify via auth service to align with main handler)
  const apiKey =
    c.req.header("x-api-key") ??
    extractBearerToken(c.req.header("authorization") ?? c.req.header("Authorization") ?? "") ??
    "";

  let keyId = apiKey ? apiKeyToKeyId(apiKey) : "unknown";

  // Align with main handler: call auth service verification, return 401 if unverified.
  // spaceId originates from request path /proxy/<spaceId>/...; "" when path prefix is absent.
  const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const { userId, rejected: userKeyRejected, rejectReason } =
    await verifyUserKey(apiKey, spaceId);
  if (userKeyRejected) {
    return c.json(
      { error: `Authentication failed: ${rejectReason ?? "unknown"}` },
      401,
    );
  }
  if (userId) keyId = userId;

  // ── System-user short-circuit ────────────────────────────────────────────
  // Auxiliary endpoints (count_tokens / embeddings / completions / moderations)
  // also bypass the standard aux flow for internal service accounts. Match
  // is by userId resolved from verifyUserKey; auth-disabled requests (userId
  // == "") never match. Body has NOT been read yet — passthrough owns the
  // byte stream end-to-end.
  if (hasSystemUsers()) {
    const sysMatch = matchSystemUserByUserId(userId);
    if (sysMatch) {
      return handleSystemUserPassthrough(c, config, sysMatch);
    }
  }

  // 2. Read raw body (byte-level passthrough)
  const rawBody = await c.req.arrayBuffer();
  const bodyText = new TextDecoder().decode(rawBody);
  const modelId = extractModelId(bodyText);

  // 3. Construct upstream URL (reuse joinUrl, consuming whitelist table naturally)
  const upstreamUrl = joinUrl(config.upstream.url, c.req.path);

  // 4. Construct upstream headers (inject auth based on endpoint protocol)
  const upstreamHeaders = buildAuxUpstreamHeaders(c, config, entry);

  // 5. Pipeline log (simplified: emit key events only)
  const pipe = createPipeline(config, traceId, modelId);
  pipe.info(
    "AUX_ENDPOINT",
    `${entry.pathSuffix} → ${entry.upstreamEndpoint} (${entry.protocol})`,
  );
  pipe.forwardStart();

  // 6. Forward (simplified for aux endpoints: no retry)
  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: rawBody,
    });
  } catch (err: unknown) {
    pipe.error("AUX_FORWARD", err instanceof Error ? err : new Error(String(err)));
    return c.json(
      { error: "Upstream request failed", detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
  pipe.forwardDone(upstreamResp.status);

  // 7. Branch: stream vs non-stream
  const contentType = upstreamResp.headers.get("content-type") ?? "";
  const isStream = contentType.includes("event-stream");

  if (isStream) {
    // Stream branch: pipe directly, usage extraction in SSE tap deferred
    // (credit reporting will be handled on client disconnect or tap logic phase 2)
    log.debug("aux.stream.passthrough", { path: c.req.path, upstreamUrl });
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: filterResponseHeaders(upstreamResp.headers),
    });
  }

  // Non-stream: read full body → extract usage → credit
  const respBuf = await upstreamResp.arrayBuffer();
  const respText = new TextDecoder().decode(respBuf);
  const usage = extractUsageFromResponse(respText, entry);

  if (usage && upstreamResp.ok) {
    // Credit reporting (auxiliary endpoints use generic credit-reporter)
    try {
      await tryReportCreditFromPath(
        config.creditReport,
        c.req.path,
        usage,
        config.creditPricing,
        modelId,
        upstreamUrl,
        "usage",
      );
    } catch (err: unknown) {
      log.error(
        "aux.credit_report_failed",
        { path: c.req.path, upstreamUrl },
        err instanceof Error ? err : new Error(String(err)),
      );
    }

    // JSONL + ClickHouse usage logging (reusing main handler path)
    writeLog(config, {
      timestamp: startTime,
      event: "usage",
      modelId,
      keyId,
      sessionKey: keyId, // Auxiliary endpoints have no session concept, fallback to keyId
      upstreamUrl,
      stream: false,
      usage,
    });
  }

  pipe.responseDone(usage);

  // 8. Pass through response as-is
  return new Response(respBuf, {
    status: upstreamResp.status,
    headers: filterResponseHeaders(upstreamResp.headers),
  });
}
