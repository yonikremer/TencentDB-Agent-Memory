/**
 * Langfuse LLM trace reporting module (official SDK approach).
 *
 * Reports LLM calls using the official Langfuse SDK (@langfuse/tracing + @langfuse/otel).
 *
 * Core semantics: **one trace = one user input in a session (one turn)**.
 *   - The tool loop within the same turn (model → tool → model → …) issues several upstream requests,
 *     which share the same deterministic traceId, so they are merged into one trace in Langfuse,
 *     with each LLM call being a generation observation under that trace.
 *   - The traceId is derived from `sessionKey + turnSeq` via SHA-256 (deterministic), matching the official
 *     `createTraceId(seed)` algorithm byte-for-byte (first 32 chars of the SHA-256 hex).
 *
 * Cross-request merging mechanism:
 *   The multiple requests of one turn are independent HTTP handler invocations with no shared async context.
 *   Therefore, via `startObservation(..., { parentSpanContext: { traceId, ... } })`, each
 *   generation is explicitly attached to the known deterministic traceId (the SDK internally uses
 *   `trace.setSpanContext(context.active(), parentSpanContext)`).
 *
 * Design principles:
 *   - Fire-and-forget: spans are exported asynchronously in batches by LangfuseSpanProcessor
 *   - Graceful degradation when config is missing / SDK initialization fails (all no-op)
 *   - Fully independent of Opik reporting (each uses its own traceId)
 */

import { createHash } from "node:crypto";
import { TraceFlags } from "@opentelemetry/api";
import { startObservation, LangfuseOtelSpanAttributes } from "@langfuse/tracing";
import type { ProxyConfig } from "./types.js";
import { log } from "./report/log.js";

// ============================
// Lifecycle
// ============================

let _enabled = false;
let _initCalled = false;
// OpenTelemetry NodeSDK instance (used to flush on graceful shutdown).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sdk: { shutdown: () => Promise<void> } | null = null;

/**
 * Initializes Langfuse reporting. Called once at server startup; later calls are no-ops.
 * Returns whether it was enabled successfully.
 */
export async function initLangfuse(config: ProxyConfig): Promise<boolean> {
  if (_initCalled) return _enabled;
  _initCalled = true;

  const lf = config.langfuse;
  if (!lf.enabled || !lf.host || !lf.publicKey || !lf.secretKey) {
    log.info("langfuse.disabled", { reason: "config not complete" });
    return false;
  }

  try {
    // BatchSpanProcessor's maxQueueSize can only be injected via an OTel env var (the Langfuse constructor doesn't forward it).
    // Set it before SDK initialization so BatchSpanProcessor picks up our value.
    if (lf.maxQueueSize && !process.env.OTEL_BSP_MAX_QUEUE_SIZE) {
      process.env.OTEL_BSP_MAX_QUEUE_SIZE = String(lf.maxQueueSize);
    }

    const [{ NodeSDK }, { LangfuseSpanProcessor }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@langfuse/otel"),
    ]);

    const baseUrl = lf.host.replace(/\/$/, "");
    const processor = new LangfuseSpanProcessor({
      publicKey: lf.publicKey,
      secretKey: lf.secretKey,
      baseUrl,
      flushAt: lf.flushAt || undefined,           // max spans per batch
      flushInterval: lf.flushInterval || undefined, // scheduled flush interval (seconds)
    });

    const sdk = new NodeSDK({ spanProcessors: [processor] });
    sdk.start();
    _sdk = sdk;
    _enabled = true;

    log.info("langfuse.initialized", {
      baseUrl,
      flushAt: lf.flushAt,
      flushInterval: lf.flushInterval,
      maxQueueSize: lf.maxQueueSize,
    });
    return true;
  } catch (err: unknown) {
    log.warn("langfuse.init_failed", { error: String(err) });
    _enabled = false;
    return false;
  }
}

/**
 * Gracefully shuts down Langfuse reporting, ensuring all pending spans are flushed.
 */
export async function shutdownLangfuse(): Promise<void> {
  if (_sdk) {
    try {
      await _sdk.shutdown();
    } catch (err: unknown) {
      log.warn("langfuse.shutdown_error", { error: String(err) });
    }
    _sdk = null;
  }
  _enabled = false;
  _initCalled = false;
}

// ============================
// Deterministic turn traceId
// ============================

/**
 * Derives a deterministic traceId from `sessionKey + turnSeq` (32-char lowercase hex).
 *
 * Matches the official `createTraceId(seed)` algorithm: first 32 chars of the SHA-256(seed) hex.
 * Every request within the same turn uses the same (sessionKey, turnSeq) → same traceId →
 * merged into a single trace in Langfuse.
 */
export function langfuseTurnTraceId(sessionKey: string, turnSeq: number): string {
  const seed = `${sessionKey}:${turnSeq}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

// ============================
// Reporting: generation observation
// ============================

/**
 * Langfuse turn-trace context — trace-level attributes shared by all generations of the same turn
 * (one Langfuse trace). Built by the handler and passed to the report functions.
 */
export interface LangfuseTurnContext {
  /** The turn's deterministic traceId (generated by langfuseTurnTraceId). */
  traceId: string;
  /** Turn sequence number (countHumanTurns) — also used by ClickHouse to aggregate per turn. */
  turnSeq: number;
  /** Trace name. */
  traceName: string;
  /** Trace userId (usually keyId). */
  userId: string;
  /** Trace sessionId (session isolation key; multiple turns can be aggregated on it). */
  sessionId: string;
  /**
   * Trace-level tags — only dimensions stable within the turn (protocol / stream / session),
   * not route tags that change per request, so tool-loop requests in the same turn don't overwrite each other (last-write-wins).
   */
  tags: string[];
  /**
   * Observation-level extra tags for this request — they change per request and are written to the generation's
   * observation metadata, not trace-level tags. Hosts don't populate them by default.
   */
  routeTags: string[];
  /**
   * The denoised latest user question — non-empty only on the turn's first human-input request; "" during tool-loop continuations.
   * Used as trace-level input.
   */
  userQuery: string;
}

/** Report parameters for one LLM call (a generation attached under the given turn trace). */
export interface LangfuseGenerationReport {
  /** Deterministic traceId of the owning turn (generated by langfuseTurnTraceId). */
  traceId: string;
  /** Observation name (usually the model name, or `[internal] <model>`). */
  name: string;
  /** Model name. */
  model: string;
  /** ISO 8601 start time. */
  startTime: string;
  /** ISO 8601 end time. */
  endTime: string;
  /** Generation input (messages array or string). */
  input?: unknown;
  /** Generation output (assistant message or string). */
  output?: unknown;
  /** Raw usage object (normalized into Langfuse usageDetails). */
  usage?: Record<string, unknown>;
  /** Observation level (DEFAULT by default; pass ERROR on failure). */
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  /** Status message (usually for ERROR, describing the failure reason). */
  statusMessage?: string;
  // ── trace-level attributes (multiple calls in the same turn should pass the same values; last-write-wins) ──
  /** Trace name. */
  traceName: string;
  /** Trace userId (usually keyId). */
  userId: string;
  /** Trace sessionId (session isolation key; turns can be aggregated on it in Langfuse). */
  sessionId: string;
  /** Trace tags. */
  tags?: string[];
  /**
   * Trace-level input — passed only on the turn's "first human input" request (the turn's original user question).
   * Tool-loop continuation requests should leave it empty, so a request body carrying tool_result never overwrites the trace input.
   * Internal sub-steps such as routing should also leave it empty, to avoid polluting the trace-level input.
   */
  traceInput?: unknown;
  /**
   * Trace-level output — carries the turn's final answer. Multiple calls in the same turn follow last-write-wins,
   * so the last one (end of turn) becomes the trace output.
   */
  traceOutput?: unknown;
  /** Trace-level metadata. */
  traceMetadata?: Record<string, unknown>;
  /** Observation-level metadata. */
  observationMetadata?: Record<string, unknown>;
}

/**
 * Derives a valid phantom parent spanId (16 hex chars, non-zero).
 * Used to attach a generation under a deterministic traceId. The same traceId always yields the same spanId,
 * so all generations in one turn share the same parent (pointing at the same non-existent root span,
 * which Langfuse then treats as the top-level observations under that trace).
 */
function deriveParentSpanId(traceId: string): string {
  return traceId.slice(0, 16);
}

/**
 * Normalizes raw LLM usage → Langfuse usageDetails (Record<string, number>).
 *
 * Token accounting stays consistent with `buildClickHouseRow` in ClickHouse (reimplemented here independently, no cross-module dependency),
 * covering the three usage formats: Anthropic / OpenAI / DeepSeek:
 *   - Anthropic (TokenHub): `input_tokens` already excludes cache; total input = input + cache_read + cache_write,
 *     and the response has no `total_tokens`, so it must fall back to prompt + completion.
 *   - OpenAI / DeepSeek: `prompt_tokens` is the total input including cache and usually comes with `total_tokens`.
 *
 * The output follows Langfuse conventions (parts sum to total, avoiding double counting with the built-in cost calculation):
 *   - `input`: uncached input (= total input − cache_read − cache_write), billed at the input unit price
 *   - `cache_read_input_tokens` / `cache_creation_input_tokens`: cache read / write
 *   - `output`: output
 *   - `total`: total tokens (= total input + output)
 *
 * Fix note: previously `total = input_tokens + output_tokens` dropped cache tokens for Anthropic
 * (cache is usually the vast majority), leaving Langfuse's total one or two orders of magnitude too low.
 *
 * Exported for unit testing.
 */
export function normalizeUsageDetails(usage: Record<string, unknown>): Record<string, number> {
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;

  const cacheRead =
    num(usage.prompt_cache_hit_tokens) ||
    num(usage.cache_read_input_tokens) ||
    num(promptDetails?.cached_tokens);
  const cacheWrite =
    num(usage.prompt_cache_write_tokens) ||
    num(usage.cache_creation_input_tokens);

  // Total input (incl. cache): OpenAI/DeepSeek use prompt_tokens;
  // Anthropic has no prompt_tokens, so add cache_read + cache_write back to input_tokens (which excludes cache).
  const inputTokens = num(usage.input_tokens);
  const promptTokens = num(usage.prompt_tokens) || inputTokens + cacheRead + cacheWrite;
  const outputTokens = num(usage.completion_tokens) || num(usage.output_tokens);
  // Total tokens: prefer upstream total_tokens, otherwise prompt + completion (prompt already includes cache).
  const totalTokens = num(usage.total_tokens) || promptTokens + outputTokens;

  // Uncached input (parts sum to total; not double counted with cache_*).
  const uncachedInput = Math.max(promptTokens - cacheRead - cacheWrite, 0);

  const out: Record<string, number> = {
    input: uncachedInput,
    output: outputTokens,
    total: totalTokens,
  };
  if (cacheRead > 0) out.cache_read_input_tokens = cacheRead;
  if (cacheWrite > 0) out.cache_creation_input_tokens = cacheWrite;
  return out;
}

/** Reads a numeric field (non-numeric values treated as 0), consistent with ClickHouse's `num()` accounting. */
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** Converts an arbitrary value into a string writable as an OTel attribute. */
function asAttrString(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * Reports one LLM call: creates a generation observation under the given turn trace
 * and writes the trace-level attributes onto that span (the SDK sets the owning trace's fields from them).
 *
 * Fails silently (debug log only) and never affects business requests.
 */
export function langfuseReportGeneration(report: LangfuseGenerationReport): void {
  if (!_enabled) return;

  try {
    const generation = startObservation(
      report.name,
      {
        model: report.model,
        input: report.input,
        output: report.output,
        usageDetails: report.usage ? normalizeUsageDetails(report.usage) : undefined,
        metadata: report.observationMetadata,
        level: report.level,
        statusMessage: report.statusMessage,
      },
      {
        asType: "generation",
        startTime: new Date(report.startTime),
        parentSpanContext: {
          traceId: report.traceId,
          spanId: deriveParentSpanId(report.traceId),
          traceFlags: TraceFlags.SAMPLED,
          isRemote: true,
        },
      },
    );

    // Trace-level attributes: written directly as OTel attributes; the SDK propagates them to the owning trace.
    const span = generation.otelSpan;
    span.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, report.traceName);
    span.setAttribute(LangfuseOtelSpanAttributes.TRACE_USER_ID, report.userId);
    span.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, report.sessionId);
    if (report.tags && report.tags.length > 0) {
      span.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, JSON.stringify(report.tags));
    }
    // Trace-level input/output are decoupled from the observation level: only written when explicitly passed.
    // The first human-input request passes traceInput (the turn's initial question); the finalizing request passes traceOutput.
    if (report.traceInput !== undefined) {
      span.setAttribute(LangfuseOtelSpanAttributes.TRACE_INPUT, asAttrString(report.traceInput));
    }
    if (report.traceOutput !== undefined) {
      span.setAttribute(LangfuseOtelSpanAttributes.TRACE_OUTPUT, asAttrString(report.traceOutput));
    }
    if (report.traceMetadata) {
      span.setAttribute(
        LangfuseOtelSpanAttributes.TRACE_METADATA,
        JSON.stringify(report.traceMetadata),
      );
    }

    generation.end(new Date(report.endTime));
  } catch (err: unknown) {
    log.debug("langfuse.report_error", { error: String(err) });
  }
}

/** Report parameters for one failed request (upstream error / forwarding failure). */
export interface LangfuseFailureReport {
  /** Turn context. */
  lf: LangfuseTurnContext;
  /** Observation name (usually the model name). */
  model: string;
  /** ISO 8601 start time. */
  startTime: string;
  /** ISO 8601 end time. */
  endTime: string;
  /** The request's input messages (for troubleshooting). */
  input?: unknown;
  /** HTTP status code (optional when forwarding fails abnormally). */
  status?: number;
  /** Failure description (e.g. an error body snippet or "timeout/error"). */
  statusMessage: string;
  /** Extra tags (e.g. ["error"]). */
  extraTags?: string[];
  /** Observation-level metadata. */
  observationMetadata?: Record<string, unknown>;
}

/**
 * Reports one failed request: creates an ERROR generation under the owning turn trace.
 * Sets no trace-level input/output (a failure isn't the turn's final result); it only records the failure itself.
 */
export function langfuseReportFailure(report: LangfuseFailureReport): void {
  if (!_enabled) return;

  const { lf } = report;
  langfuseReportGeneration({
    traceId: lf.traceId,
    name: report.model,
    model: report.model,
    startTime: report.startTime,
    endTime: report.endTime,
    input: report.input,
    output: report.status !== undefined
      ? { error: true, status: report.status, message: report.statusMessage }
      : { error: true, message: report.statusMessage },
    level: "ERROR",
    statusMessage: report.statusMessage,
    traceName: lf.traceName,
    userId: lf.userId,
    sessionId: lf.sessionId,
    tags: report.extraTags && report.extraTags.length > 0 ? [...lf.tags, ...report.extraTags] : lf.tags,
    // Trace-level input still records the user question (so the original request is visible on the failed trace); output is not written.
    traceInput: lf.userQuery || undefined,
    observationMetadata: {
      ...report.observationMetadata,
      ...(lf.routeTags.length > 0 ? { route: lf.routeTags } : {}),
    },
  });
}
