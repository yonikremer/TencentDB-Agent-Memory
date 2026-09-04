/**
 * per-key mutex —— serializes async operations on the same key; different keys run fully concurrently.
 *
 * Used for R-M-W operations such as KvBindingRepo.touchLastSeen / KvExtractStore.incrBy,
 * eliminating contention **within a single node**. For cross-node scenarios see the analysis
 * in migration plan §6.2 (precision loss is acceptable to the business).
 *
 * Approach: keep a Promise chain per key; withPerKeyLock appends the new task to the tail of the old chain.
 * When a task finishes and is still the tail, remove it —— avoids holding a dead entry long-term.
 */
const inflight = new Map<string, Promise<unknown>>();

export function withPerKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = inflight.get(key) ?? Promise.resolve();
  // fn is used in both positions —— reject/fulfill both wait serially, so that if one throws,
  // later tasks cannot leak in front of the old chain.
  const cur = prev.then(fn, fn) as Promise<T>;
  // tail registers the chain tail & cleans up; the rejection is converted to resolved to avoid an "unhandled rejection" warning.
  // The real error still reaches the caller through cur.
  const tail: Promise<void> = cur.then(() => {}, () => {}).finally(() => {
    if (inflight.get(key) === tail) inflight.delete(key);
  });
  inflight.set(key, tail);
  return cur;
}

/** Test-only: clears all in-flight locks (does not wait for them to complete; await them yourself if needed). */
export function __resetPerKeyLocksForTests(): void {
  inflight.clear();
}
