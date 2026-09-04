/**
 * Langfuse Filtering SpanProcessor (Facade layer).
 *
 * Only forwards LLM-related spans (ai.* / gen_ai.* prefixes) to Langfuse OTLP endpoint,
 * other engineering call spans are dropped to prevent excessive traffic.
 *
 * Design principles:
 * - Does not affect existing span lifecycle
 * - Silently ignores exporter failures
 * - Graceful degradation when configuration is missing
 *
 * Public API signature remains unchanged, callers require no changes.
 * Specific implementation provided by ILLMTraceBackend.
 */

import { getObservabilityBackend } from "./factory.js";
import type { ISpanProcessor } from "./types.js";

// ============================
// Configuration types (retained exports for backward compatibility)
// ============================

export interface LangfuseConfigEnabled {
  enabled: true;
  host: string;
  publicKey: string;
  secretKey: string;
}

export interface LangfuseConfigDisabled {
  enabled: false;
}

export type LangfuseConfig = LangfuseConfigEnabled | LangfuseConfigDisabled;

// ============================
// Configuration parsing (retained exports for backward compatibility)
// ============================

/**
 * Parse Langfuse configuration from environment variables.
 *
 * Environment variables:
 * - LANGFUSE_ENABLED    : "true" to enable (default "false")
 * - LANGFUSE_HOST       : Langfuse instance host (e.g. http://langfuse.example.local:3000)
 * - LANGFUSE_PUBLIC_KEY : Public key
 * - LANGFUSE_SECRET_KEY : Secret key
 *
 * Returns { enabled: false } when any required configuration is missing.
 */
export function parseLangfuseConfig(): LangfuseConfig {
  const enabled = process.env.LANGFUSE_ENABLED === "true";
  if (!enabled) {
    return { enabled: false };
  }

  const host = process.env.LANGFUSE_HOST;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  // Graceful degradation when any required configuration is missing
  if (!host || !publicKey || !secretKey) {
    return { enabled: false };
  }

  return { enabled: true, host, publicKey, secretKey };
}

// ============================
// Span filtering logic (retained exports for backward compatibility)
// ============================

/**
 * Check whether span is LLM-related.
 *
 * Pass-through rules (spans produced by Vercel AI SDK experimental_telemetry):
 * - `ai.*`     : ai.generateText, ai.streamText, ai.toolCall, ai.generateObject, etc.
 * - `gen_ai.*` : gen_ai.chat, gen_ai.embeddings, etc. (OpenTelemetry GenAI semantic conventions)
 *
 * All other spans (gateway.*, core.*, queue.*, http.*, etc.) are filtered out.
 */
export function isLLMRelatedSpan(spanName: string): boolean {
  if (!spanName) return false;
  return spanName.startsWith("ai.") || spanName.startsWith("gen_ai.");
}

// ============================
// Vercel AI SDK metadata → Langfuse OTel native attributes mapping
// ============================

/**
 * Vercel AI SDK serializes each key in experimental_telemetry.metadata to
 * `ai.telemetry.metadata.<key>` prefixed span attributes. But when we **directly** use
 * OTLP HTTP exporter to send to Langfuse (without passing through official Langfuse SDK bridge), Langfuse
 * only recognizes its natively specified attribute names (see https://langfuse.com/integrations/native/opentelemetry).
 *
 * To make Trace name / SessionId / UserId / Tags take effect in Langfuse UI,
 * we translate AI SDK metadata keys to Langfuse native keys here.
 *
 * Mapping rules (do not write target if source missing or empty; do not overwrite if target already exists):
 *   ai.telemetry.metadata.langfuseTraceName  → langfuse.trace.name
 *   ai.telemetry.metadata.sessionId          → langfuse.session.id
 *   ai.telemetry.metadata.userId             → langfuse.user.id
 *   ai.telemetry.metadata.tags               → langfuse.trace.tags
 *
 * Returns **new object** containing all original attributes + added langfuse.* keys. Does not mutate input.
 */
export function mapAiTelemetryToLangfuseAttrs(
  attrs: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!attrs || typeof attrs !== "object") return {};
  const out: Record<string, unknown> = { ...attrs };

  const setIfAbsent = (
    targetKey: string,
    sourceKey: string,
    check: (v: unknown) => boolean,
  ): void => {
    if (out[targetKey] !== undefined) return; // Respect user explicit setting
    const v = attrs[sourceKey];
    if (v === undefined || v === null) return;
    if (!check(v)) return;
    out[targetKey] = v;
  };

  const nonEmptyStr = (v: unknown): boolean =>
    typeof v === "string" && v.length > 0;
  const nonEmptyArr = (v: unknown): boolean =>
    Array.isArray(v) && v.length > 0;

  setIfAbsent(
    "langfuse.trace.name",
    "ai.telemetry.metadata.langfuseTraceName",
    nonEmptyStr,
  );
  setIfAbsent(
    "langfuse.session.id",
    "ai.telemetry.metadata.sessionId",
    nonEmptyStr,
  );
  setIfAbsent(
    "langfuse.user.id",
    "ai.telemetry.metadata.userId",
    nonEmptyStr,
  );
  setIfAbsent(
    "langfuse.trace.tags",
    "ai.telemetry.metadata.tags",
    nonEmptyArr,
  );

  return out;
}

// ============================
// LangfuseFilteringProcessor (Facade layer)
// ============================

/**
 * Create Langfuse SpanProcessor instance.
 * Obtains actual processor via ILLMTraceBackend interface.
 *
 * @returns SpanProcessor instance, or null (if Langfuse is not enabled)
 */
export function createLangfuseSpanProcessor(): ISpanProcessor | null {
  try {
    return getObservabilityBackend().llmTrace.createSpanProcessor();
  } catch {
    return null;
  }
}

/**
 * Compatibility layer: LangfuseFilteringProcessor class.
 * Retains backward compatibility, delegates internally to ILLMTraceBackend.
 *
 * When ILLMTraceBackend returns a valid processor, delegates processing to it;
 * otherwise falls back to using the passed exporter for filtering + export (directly forwarding LLM spans).
 */
export class LangfuseFilteringProcessor implements ISpanProcessor {
  /** Processor from ILLMTraceBackend (used only when no exporter is provided) */
  private _processor: ISpanProcessor | null;
  /** Real exporter passed in by otel-sdk-init.ts (highest priority) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _exporter: any;

  constructor(exporter?: unknown) {
    if (exporter) {
      // When an exporter is passed in, prioritize using the exporter for actual export.
      // otel-sdk-init.ts has created HttpTraceExporter pointing to Langfuse OTLP endpoint,
      // use it directly here instead of delegating to ILLMTraceBackend (whose processor may be a stub).
      this._exporter = exporter;
      this._processor = null;
    } else {
      // When no exporter is provided, try obtaining processor from ILLMTraceBackend
      this._processor = getObservabilityBackend().llmTrace.createSpanProcessor();
      this._exporter = null;
    }
  }

  onStart(span: unknown, parentContext: unknown): void {
    this._processor?.onStart(span, parentContext);
  }

  onEnd(span: unknown): void {
    try {
      const s = span as { name?: string; attributes?: Record<string, unknown> };
      // Unified filtering: only forward LLM-related spans
      if (!s.name || !isLLMRelatedSpan(s.name)) {
        return;
      }

      if (this._exporter) {
        // Translate Vercel AI SDK metadata to Langfuse native attributes before export,
        // so that Trace name / SessionId / UserId / Tags take effect in Langfuse UI.
        // To avoid affecting subsequent usage of span by other processors, construct a shallow copy span object here.
        const enrichedAttrs = mapAiTelemetryToLangfuseAttrs(s.attributes);
        const enrichedSpan =
          enrichedAttrs === s.attributes
            ? span
            : Object.assign(Object.create(Object.getPrototypeOf(span) ?? {}), span, {
                attributes: enrichedAttrs,
              });
        // Use real exporter to send to Langfuse OTLP endpoint
        this._exporter.export([enrichedSpan], () => {});
      } else if (this._processor) {
        // Delegate to ILLMTraceBackend processor
        this._processor.onEnd(span);
      }
    } catch {
      // Silent failure, does not affect other SpanProcessors
    }
  }

  async forceFlush(): Promise<void> {
    if (this._exporter?.forceFlush) {
      await this._exporter.forceFlush();
    } else if (this._processor) {
      await this._processor.forceFlush();
    }
  }

  async shutdown(): Promise<void> {
    if (this._exporter?.shutdown) {
      await this._exporter.shutdown();
    }
    if (this._processor) {
      await this._processor.shutdown();
    }
  }
}
