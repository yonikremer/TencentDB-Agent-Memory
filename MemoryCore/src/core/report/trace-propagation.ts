/**
 * Trace Context cross-asynchronous boundary propagation tool (facade layer)
 *
 * Used to serialize/deserialize OTel Trace Context in asynchronous tasks,
 * achieving HTTP request -> Pipeline Worker cross-asynchronous trace correlation.
 *
 * Usage:
 *   // When enqueuing: Serialize current Trace Context to TaskPayload.data
 *   const traceCtx = serializeTraceContext();
 *   task.data = { ...task.data, ...traceCtx };
 *
 *   // When consuming: Deserialize and restore Trace Context from TaskPayload.data
 *   const parentCtx = deserializeTraceContext(task.data);
 *   // Create CONSUMER Span in parentCtx
 *
 * The public API signature remains unchanged, callers do not need to modify.
 */

import { getObservabilityBackend } from "./factory.js";

/**
 * Serialize the current Trace Context to a plain object.
 * The returned object can be spread directly into TaskPayload.data.
 *
 * If there is no valid Span Context currently, returns an empty object.
 */
export function serializeTraceContext(): Record<string, string | number> {
  try {
    return getObservabilityBackend().tracePropagation.serializeTraceContext();
  } catch {
    return {};
  }
}

/**
 * Deserialize and restore Trace Context from TaskPayload.data.
 *
 * Returns an OTel Context that can be used to create a CONSUMER Span with a follow-from link.
 * If there is no trace information in data, returns ROOT_CONTEXT.
 */
export function deserializeTraceContext(
  data?: Record<string, unknown>,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): { parentContext: any; parentSpanContext: any | null } {
  try {
    return getObservabilityBackend().tracePropagation.deserializeTraceContext(data);
  } catch {
    return { parentContext: {}, parentSpanContext: null };
  }
}
