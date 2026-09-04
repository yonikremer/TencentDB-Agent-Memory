/**
 * pending-writes — track in-flight L0 writes + provide a SIGTERM flush hook + retry.
 *
 * Background: in streaming, recordTdaiTurn must be fire-and-forget (it must not block
 * SSE close, otherwise it slows perceived tail latency after the first token). But
 * fire-and-forget has two drop scenarios:
 *   1. On pod rolling update, when SIGTERM arrives there are still promises in the event
 *      loop that have not been flushed → node exits immediately → L0 lost
 *   2. tdai kernel briefly returns 503 / network jitter → a single POST fails with no
 *      retry → L0 lost
 *
 * Two mitigations in this module:
 *   - `trackWrite(promise)`: registers the in-flight promise in the pending set, and
 *     removes it when settled.
 *     `flushPendingWrites(deadlineMs)` waits for all in-flight writes to finish or time
 *     out. The index.ts SIGTERM handler calls it once before shutdown.
 *   - `withL0Retry(fn)`: wraps a single write in up to 3 attempts of exponential backoff
 *     retry. Guards against transient kernel outages.
 *
 * Unchanged behavior:
 *   - The non-streaming path still awaits (track also applies to awaited writes, but adds
 *     no overhead).
 *   - When `recordTdaiTurn(client, identity=null | userMessage=null)` returns early on
 *     the client side, this module does not intervene.
 *
 * Duplicate-write risk: if the first POST reached the tdai kernel but the client read a
 * 5xx timeout and retried, the kernel may receive two L0 records with identical content
 * (tdai `/v3/conversation/add` currently has no idempotency-key). Acceptable: better to
 * duplicate than lose; and the two retried POST payloads are identical, so the L1/L2/L3
 * distillation pipeline is idempotent (same hash, one record) — only L0 is redundant
 * observably.
 */

const pendingWrites = new Set<Promise<unknown>>();

/**
 * Registers an in-flight write. Returns the same promise for chaining.
 * Automatically removes it from the set on settle.
 *
 * Note: `.finally` returns a new promise; if the original p is rejected and the new
 * chain has no catch, Node reports UnhandledRejection (or, under
 * --unhandled-rejections=strict, exits the process directly). Use catch(noop) to swallow
 * the cleanup chain; the caller owns catching p (the handler does .catch pipe.error("TDAI_L0", ...)).
 */
export function trackWrite<T>(p: Promise<T>): Promise<T> {
  pendingWrites.add(p);
  p.finally(() => pendingWrites.delete(p)).catch(() => { /* caller owns rejection */ });
  return p;
}

/** Number of currently in-flight writes (for observability/testing). */
export function pendingWriteCount(): number {
  return pendingWrites.size;
}

/**
 * Waits for all in-flight writes to settle or the deadline to expire.
 * Called by the SIGTERM handler; on timeout returns the number of unfinished writes for
 * log observability (does not block exit).
 */
export async function flushPendingWrites(deadlineMs: number = 10_000): Promise<{
  drained: boolean;
  remaining: number;
}> {
  if (pendingWrites.size === 0) return { drained: true, remaining: 0 };
  const snapshot = [...pendingWrites];
  const settled = Promise.allSettled(snapshot);
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), deadlineMs));
  const outcome = await Promise.race([settled.then(() => "ok" as const), timeout]);
  return { drained: outcome === "ok", remaining: pendingWrites.size };
}

/**
 * Exponential backoff retry wrapper. Used for transient tdai kernel outages.
 *
 * Defaults: 3 total attempts with intervals 500ms → 1s → 2s (incl. jitter).
 * Total max ~3.5s; the pod SIGTERM grace period is usually 30s, and flushPendingWrites
 * defaults to a 10s fallback, enough to finish all 3 retries.
 *
 * Retries only errors worth retrying (network, 5xx, 408, 429); 4xx client errors are
 * thrown immediately.
 */
export async function withL0Retry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      const wait = baseMs * (2 ** i) + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * Simple heuristic: network errors, 5xx, 408/429 are worth retrying; others
 * (400/401/403/404/422) are given up on immediately.
 * TdaiClient errors currently take the form `throw new Error(\`tdai POST ... HTTP <code>: <body>\`)`;
 * a regex extracts the status code. If none is found (network down/timeout), default to
 * retry.
 */
function isRetryable(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  // Network class: AbortError / ENOTFOUND / ECONNRESET / ETIMEDOUT / fetch failed
  if (/abort|econnreset|enotfound|etimedout|fetch failed|network|timeout/i.test(msg)) return true;
  // HTTP status-code class
  const m = msg.match(/HTTP (\d{3})/);
  if (!m) return true; // No status code available → conservatively retry
  const code = Number(m[1]);
  return code >= 500 || code === 408 || code === 429;
}
