/**
 * Core HTTP Trace middleware – non-invasive tracing (facade layer).
 *
 * For each HTTP request, creates a SERVER‑type entry Span (core.request) and
 * restores upstream Trace Context from the `traceparent` header to enable cross‑service
 * trace correlation.
 *
 * Usage (in `server.ts`):
 *   import { wrapWithTrace } from "../core/report/trace-middleware.js";
 *   // Wrap the request handler when creating the server
 *   this.server = http.createServer((req, res) =>
 *     wrapWithTrace(req, res, () => this.handleRequest(req, res)));
 *
 * Does not modify any business logic – pure observability component.
 * The public API signature remains unchanged, so callers need not adjust code.
 */

import http from "node:http";
import { getObservabilityBackend } from "./factory.js";
import type { ISpan } from "./types.js";

// Re-export Span type for backward compatibility
export type { Span } from "@opentelemetry/api";

/**
 * Wrap an HTTP request handler to add tracing.
 *
 * @param req - the incoming HTTP request
 * @param res - the HTTP response object
 * @param handler - the original request handler
 */
export async function wrapWithTrace(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handler: () => Promise<void>,
): Promise<void> {
  try {
    return await getObservabilityBackend().traceMiddleware.wrapWithTrace(req, res, handler);
  } catch (err) {
    // Re-throw the error if it originated from the handler
    throw err;
  }
}

/** No‑op Span – safe fallback when the backend is unavailable */
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

/**
 * Create a child Span (for finer‑grained spans inside business handlers).
 *
 * @param name - Span name (e.g., "core.vdb.write")
 * @param attrs - Span attributes
 * @returns A Span instance; caller must manually call `span.end()`.
 */
export function startChildSpan(
  name: string,
  attrs: Record<string, string | number | boolean> = {},
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  try {
    return getObservabilityBackend().traceMiddleware.startChildSpan(name, attrs);
  } catch {
    return noopSpan;
  }
}

/**
 * Execute a function within the current Span context, automatically creating a child Span.
 *
 * @param name - Span name
 * @param attrs - Span attributes
 * @param fn - Function to execute
 * @returns The return value of `fn`.
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (span: any) => Promise<T>,
): Promise<T> {
  try {
    return await getObservabilityBackend().traceMiddleware.withSpan(name, attrs, fn);
  } catch (err) {
    // Re-throw the error if it originated from the function itself
    throw err;
  }
}