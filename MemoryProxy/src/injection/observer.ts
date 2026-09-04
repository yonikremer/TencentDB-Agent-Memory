/**
 * InjectionObserver — Injection pipeline observability abstraction.
 *
 * Design goals:
 *   Hook developers don't need to write any observability code. The pipeline automatically calls back the observer at key lifecycle nodes.
 *   The observer implementation (Noop/Logging) is injected when the pipeline is constructed, never blocking business logic.
 *
 * Architecture:
 *   InjectionPipeline → try/catch → InjectionObserver.onXxx() → log facade
 *
 * Principles:
 *   - Fire-and-forget: The observer can be asynchronous internally, but we don't await it
 *   - Fault isolation: Any exceptions in the observer are never propagated to the pipeline
 *   - Default Noop: Zero overhead when not configured
 */

import type { AgentContextMetadata, ContextBlock, InjectionHook, InjectionPoint } from "./types.js";
import { log } from "../report/log.js";
import { createHash } from "node:crypto";
import { TraceFlags } from "@opentelemetry/api";
import { startObservation, LangfuseOtelSpanAttributes } from "@langfuse/tracing";

// ── Hook execution result ─────────────────────────────────────────────────────

/** Summary of execution results for a single hook, aggregated and reported by the pipeline in onPipelineEnd. */
export interface HookResult {
  hookId: string;
  point: InjectionPoint;
  blockCount: number;
  durationMs: number;
  error?: string;
  cacheStrategy?: string;
}

// ── Observer interface ────────────────────────────────────────────────────────

/**
 * Injection pipeline observer interface.
 *
 * The pipeline calls observer methods at the following times:
 *   process() entry     → onPipelineStart
 *   executeHooks loop   → onHookStart / onHookDone / onHookError (for each hook)
 *   process() exit      → onPipelineEnd (success) or onPipelineError (failure)
 *
 * Default implementation: NoopInjectionObserver (zero overhead).
 * Production implementation: LoggingInjectionObserver (writes structured logs).
 */
export interface InjectionObserver {
  /** Pipeline starts processing a request. */
  onPipelineStart(meta: AgentContextMetadata): void;

  /** Pipeline completes successfully (all hooks executed). */
  onPipelineEnd(
    meta: AgentContextMetadata,
    durationMs: number,
    results: HookResult[],
  ): void;

  /** Pipeline-level error (e.g. unknown protocol, missing adapter), request failed to enter hook execution phase. */
  onPipelineError(meta: AgentContextMetadata, error: Error): void;

  /** Single hook starts execution. */
  onHookStart(hook: InjectionHook, point: InjectionPoint): void;

  /** Single hook execution completed (including returning empty blocks). */
  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    durationMs: number,
    cacheStrategy?: string,
  ): void;

  /** Single hook execution anomaly (recorded by error start→error/done). */
  onHookError(
    hook: InjectionHook,
    point: InjectionPoint,
    error: Error,
    durationMs: number,
  ): void;
}

// ── Noop implementation ───────────────────────────────────────────────────────

/**
 * No-op observer — Default implementation, zero overhead.
 * All methods have empty bodies, yielding no performance penalty after JIT inline.
 */
export class NoopInjectionObserver implements InjectionObserver {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onPipelineStart(_meta: AgentContextMetadata): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onPipelineEnd(_meta: AgentContextMetadata, _durationMs: number, _results: HookResult[]): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onPipelineError(_meta: AgentContextMetadata, _error: Error): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookStart(_hook: InjectionHook, _point: InjectionPoint): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookDone(_hook: InjectionHook, _point: InjectionPoint, _blocks: ContextBlock[], _durationMs: number, _cacheStrategy?: string): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookError(_hook: InjectionHook, _point: InjectionPoint, _error: Error, _durationMs: number): void { /* noop */ }
}

// ── Logging implementation ────────────────────────────────────────────────────

/**
 * Structured log observer — Writes to the structured logging system in `src/report/log.ts`.
 *
 * Reported events:
 *   injection.pipeline.start  — Pipeline started
 *   injection.pipeline.done   — Pipeline completed (includes durationMs, hookCount, totalBlockCount)
 *   injection.pipeline.error  — Pipeline-level error
 *   injection.hook.start      — Single hook started
 *   injection.hook.done       — Single hook completed (includes blocks summary)
 *   injection.hook.error      — Single hook failed
 *
 * Safety guarantee: All methods use try/catch internally, never throw exceptions.
 */
export class LoggingInjectionObserver implements InjectionObserver {
  onPipelineStart(meta: AgentContextMetadata): void {
    try {
      log.info("injection.pipeline.start", {
        traceId: meta.traceId.slice(0, 8),
        protocol: meta.protocol,
        agentSource: meta.agentSource,
        modelId: meta.modelId,
      });
    } catch { /* observer must never throw */ }
  }

  onPipelineEnd(
    meta: AgentContextMetadata,
    durationMs: number,
    results: HookResult[],
  ): void {
    try {
      const totalBlockCount = results.reduce((sum, r) => sum + r.blockCount, 0);
      const errorCount = results.filter((r) => r.error).length;
      log.info("injection.pipeline.done", {
        traceId: meta.traceId.slice(0, 8),
        protocol: meta.protocol,
        agentSource: meta.agentSource,
        durationMs,
        hookCount: results.length,
        totalBlockCount,
        errorCount,
      });
    } catch { /* observer must never throw */ }
  }

  onPipelineError(meta: AgentContextMetadata, error: Error): void {
    try {
      log.error(
        "injection.pipeline.error",
        {
          traceId: meta.traceId.slice(0, 8),
          protocol: meta.protocol,
          agentSource: meta.agentSource,
          errorMsg: error.message,
        },
        error,
      );
    } catch { /* observer must never throw */ }
  }

  onHookStart(hook: InjectionHook, point: InjectionPoint): void {
    try {
      log.info("injection.hook.start", {
        hookId: hook.id,
        point,
        cacheStrategy: hook.cacheStrategy ?? "none",
        priority: hook.priority,
      });
    } catch { /* observer must never throw */ }
  }

  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    durationMs: number,
    cacheStrategy?: string,
  ): void {
    try {
      const blockSummaries = blocks.map((b) => ({
        type: b.type,
        source: String(b.metadata?.source ?? "unknown"),
        preview: b.type === "text"
          ? b.content.replace(/\s+/g, " ").slice(0, 200)
          : `[${b.type}] ${b.metadata?.tool_name ?? ""}`,
      }));

      log.info("injection.hook.done", {
        hookId: hook.id,
        point,
        blockCount: blocks.length,
        durationMs,
        cacheStrategy: cacheStrategy ?? hook.cacheStrategy ?? "none",
        blocks: blockSummaries,
      });
    } catch { /* observer must never throw */ }
  }

  onHookError(
    hook: InjectionHook,
    point: InjectionPoint,
    error: Error,
    durationMs: number,
  ): void {
    try {
      log.warn("injection.hook.error", {
        hookId: hook.id,
        point,
        errorMsg: error.message,
        durationMs,
      });
    } catch { /* observer must never throw */ }
  }
}

// ── Langfuse implementation ───────────────────────────────────────────────────

/**
 * Deterministically derive Langfuse traceId (consistent with the algorithm in langfuse.ts langfuseTurnTraceId).
 * Derived from sessionKey + turnSeq via SHA-256, taking the first 32 hex chars.
 */
function deriveLangfuseTraceId(sessionKey: string, turnSeq: number): string {
  return createHash("sha256").update(`${sessionKey}:${turnSeq}`).digest("hex").slice(0, 32);
}

/** Derive phantom parent spanId (consistent with deriveParentSpanId in langfuse.ts). */
function deriveParentSpanId(traceId: string): string {
  return traceId.slice(0, 16);
}

/**
 * Langfuse Injection Observer — attaches each hook's execution as a span observation under the Langfuse turn trace.
 *
 * Prerequisites: metadata.sessionKey and metadata.turnSeq must exist,
 * otherwise all methods degrade to no-op (because Langfuse traceId cannot be derived).
 *
 * Each hook generates one span observation:
 *   - name: `[inject] {hookId}` or `[inject] {hookId} (error)`
 *   - metadata: hookId, point, cacheStrategy, durationMs, blockCount, blocks summary
 *   - traceId: Deterministically derived from sessionKey + turnSeq (shares the same trace with upstream LLM generation)
 *
 * Safety guarantee: All methods use try/catch internally, never throw exceptions; fallbacks to noop when observer is missing or degraded.
 */
export class LangfuseInjectionObserver implements InjectionObserver {
  /** Captured from onPipelineStart metadata, used by subsequent hook callbacks. */
  private meta: AgentContextMetadata | null = null;

  onPipelineStart(meta: AgentContextMetadata): void {
    try {
      this.meta = meta;
      // No span — deferred to hook-level recording
    } catch { /* observer must never throw */ }
  }

  onPipelineEnd(
    _meta: AgentContextMetadata,
    _durationMs: number,
    _results: HookResult[],
  ): void {
    try {
      this.meta = null; // cleanup
    } catch { /* observer must never throw */ }
  }

  onPipelineError(_meta: AgentContextMetadata, _error: Error): void {
    try {
      this.meta = null;
    } catch { /* observer must never throw */ }
  }

  onHookStart(_hook: InjectionHook, _point: InjectionPoint): void {
    // Span is created all at once in onHookDone/onHookError (includes full duration).
  }

  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    durationMs: number,
    cacheStrategy?: string,
  ): void {
    try {
      const lfTraceId = this.getLangfuseTraceId();
      if (!lfTraceId) return;

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - durationMs);

      const blockSummaries = blocks.map((b) => ({
        type: b.type,
        source: String(b.metadata?.source ?? "unknown"),
        preview: b.type === "text"
          ? b.content.replace(/\s+/g, " ").slice(0, 300)
          : `[${b.type}] ${b.metadata?.tool_name ?? ""}`,
      }));

      // Name format: [inject] <hookId> @ <point> — searchable in Langfuse by prefix/keyword
      const name = blocks.length > 0
        ? `[inject] ${hook.id} @ ${point}`
        : `[inject] ${hook.id} @ ${point} (empty)`;

      const obsMeta: Record<string, unknown> = {
        hookId: hook.id,
        point,
        source: blocks[0]?.metadata?.source ?? "unknown",
        cacheStrategy: cacheStrategy ?? hook.cacheStrategy ?? "none",
        durationMs,
        blockCount: blocks.length,
        protocol: this.meta?.protocol ?? "unknown",
        agentSource: this.meta?.agentSource ?? "unknown",
      };

      const span = startObservation(
        name,
        {
          input: { point, cacheStrategy: cacheStrategy ?? hook.cacheStrategy ?? "none" },
          output: { blockCount: blocks.length, blocks: blockSummaries },
          metadata: obsMeta,
        },
        {
          asType: "span",
          startTime,
          parentSpanContext: {
            traceId: lfTraceId,
            spanId: deriveParentSpanId(lfTraceId),
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
          },
        },
      );

      // Observation-level attributes
      const otelSpan = span.otelSpan;
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.OBSERVATION_METADATA, JSON.stringify(obsMeta));
      // Trace-level attributes: overlay injection summary (last-write-wins, all hooks write, ultimately keeps the last one)
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_METADATA, JSON.stringify({
        injection: { hookId: hook.id, point, blockCount: blocks.length, durationMs },
      }));
      if (this.meta?.sessionKey) {
        otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, this.meta.sessionKey);
      }

      span.end(endTime);
    } catch { /* observer must never throw */ }
  }

  onHookError(
    hook: InjectionHook,
    point: InjectionPoint,
    error: Error,
    durationMs: number,
  ): void {
    try {
      const lfTraceId = this.getLangfuseTraceId();
      if (!lfTraceId) return;

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - durationMs);

      const obsMeta: Record<string, unknown> = {
        hookId: hook.id,
        point,
        errorMsg: error.message,
        durationMs,
        protocol: this.meta?.protocol ?? "unknown",
        agentSource: this.meta?.agentSource ?? "unknown",
      };

      const span = startObservation(
        `[inject] ${hook.id} @ ${point} (error)`,
        {
          input: { point, cacheStrategy: hook.cacheStrategy ?? "none" },
          output: { error: true, message: error.message },
          level: "ERROR",
          statusMessage: error.message,
          metadata: obsMeta,
        },
        {
          asType: "span",
          startTime,
          parentSpanContext: {
            traceId: lfTraceId,
            spanId: deriveParentSpanId(lfTraceId),
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
          },
        },
      );

      const otelSpan = span.otelSpan;
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.OBSERVATION_METADATA, JSON.stringify(obsMeta));
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.OBSERVATION_LEVEL, "ERROR");

      span.end(endTime);
    } catch { /* observer must never throw */ }
  }

  /** Derive Langfuse traceId from stored metadata, or null if unavailable. */
  private getLangfuseTraceId(): string | null {
    if (!this.meta?.sessionKey || this.meta.turnSeq === undefined) return null;
    return deriveLangfuseTraceId(this.meta.sessionKey, this.meta.turnSeq);
  }
}
