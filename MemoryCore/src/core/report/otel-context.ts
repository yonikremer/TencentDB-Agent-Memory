/**
 * OTel context helpers.
 *
 * Background (why we need it):
 *   The skill extraction worker's `runLoop()` is **lazy started** inside an HTTP request handler
 *   (`resolveConversationAdd` -> `wireConversationAdd` -> `worker.start()`).
 *   OTel uses AsyncLocalStorageContextManager to propagate context - a `runLoop()` that **never exits**
 *   will permanently inherit the active span from "the moment it was started" (i.e., the span of that request),
 *   so every subsequent LLM `generateText` becomes a child span of that request's trace, being
 *   merged into a single one by Langfuse (tags span across multiple agents, sessionId confused).
 *
 *   `runInRootContext` executes fn within the OTel ROOT_CONTEXT, cutting off this parasitism,
 *   so that newly created spans inside fn (like ai.generateText) become independent roots (each with their own traceId).
 *
 * Defensive loading of @opentelemetry/api: When the package is missing (open source / minimal deployment), it degrades to directly executing fn,
 * with equivalent semantics, without throwing errors. Loading method aligns with otel-sdk-init.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _context: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _rootContext: any = null;

try {
  const api = await import("@opentelemetry/api");
  _context = api.context;
  _rootContext = api.ROOT_CONTEXT;
} catch {
  // @opentelemetry/api is unavailable -> remains null, runInRootContext degrades to directly executing fn
}

/**
 * Execute fn in OTel ROOT_CONTEXT, cutting off inheritance from the active span at the calling point.
 *
 * Typical use case: wrap it when starting a background loop that never exits, to prevent the loop from carrying
 * the trace context from "startup time" indefinitely. When otel is unavailable, execute fn directly (no context isolation, but behavior is equivalent).
 */
export function runInRootContext<T>(fn: () => T): T {
  if (_context && _rootContext) {
    return _context.with(_rootContext, fn) as T;
  }
  return fn();
}
