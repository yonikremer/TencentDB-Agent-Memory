/**
 * Trace event facade — Event as Span + Traditional Start/End
 *
 * Usage:
 *
 *   import { trace } from "./core/report/trace.js";
 *
 *   // Event as Span (one line, most common)
 *   trace.report("l1_extraction", {
 *     sessionKey,
 *     memoriesExtracted: extracted.length,
 *     totalDurationMs: Date.now() - startMs,
 *     success: true,
 *     error: null,
 *   });
 *
 *   // Traditional Start/End (cross-service call chain scenario)
 *   const span = trace.start("memory.recall");
 *   // ... business logic ...
 *   span.end();
 *
 * This module is the facade layer, internally delegating to ITraceBackend (obtained via global singleton).
 * The public API signature remains unchanged, callers do not need to modify.
 */

import { getObservabilityBackend } from "./factory.js";
import type { TraceAttrs, ISpan } from "./types.js";

// Re-export Span type from @opentelemetry/api (type only, does not affect runtime)
export type { Span } from "@opentelemetry/api";

export type { TraceAttrs } from "./types.js";

/**
 * Report a business event (Event as Span).
 *
 * Internally creates a Span, sets each field in attrs as a Span Attribute,
 * sets the Span Status based on the "success" field, and then immediately Ends.
 */
function report(event: string, attrs: TraceAttrs = {}): void {
  try {
    getObservabilityBackend().trace.report(event, attrs);
  } catch {
    // Fail silently, do not block business logic
  }
}

/**
 * Create a traditional Span (for cross-service call chain scenarios).
 * The caller needs to manually call span.end().
 */
function start(spanName: string, kind?: number): ISpan {
  try {
    return getObservabilityBackend().trace.start(spanName, kind);
  } catch {
    return noopSpan;
  }
}

/**
 * Create a SERVER type Span.
 */
function startServer(spanName: string): ISpan {
  try {
    return getObservabilityBackend().trace.startServer(spanName);
  } catch {
    return noopSpan;
  }
}

/**
 * Create a CLIENT type Span.
 */
function startClient(spanName: string): ISpan {
  try {
    return getObservabilityBackend().trace.startClient(spanName);
  } catch {
    return noopSpan;
  }
}

/** Noop Span — safe fallback when the backend is unavailable */
const noopSpan: ISpan = {
  end() {},
  setAttribute() { return this; },
  setAttributes() { return this; },
  setStatus() { return this; },
  recordException() {},
  spanContext() { return { traceId: "", spanId: "", traceFlags: 0 }; },
  isRecording() { return false; },
  updateName() { return this; },
  addEvent() { return this; },
};

export const trace = {
  report,
  start,
  startServer,
  startClient,
};
