/**
 * WorkerPermitPool — memory PipelineWorker concurrency semaphore.
 *
 * History: formerly shared across modules (memory PipelineWorker + skill old V2 worker);
 * After skill refactor on 2026-07-17, the skill side uses agent-level extract-lock for concurrency limit,
 * and no longer relies on semaphores. This pool currently has only one consumer: the memory pipeline,
 * and is kept because memory side concurrency > 1 still needs it for queueing.
 *
 * Semantics:
 *   - capacity is a hard limit
 *   - queue up when acquire is full; wake up via FIFO on release
 *   - throw error if release is called more times than acquire (helps locate unmatched pair bugs)
 *   - destroy wakes up all waiting and makes them reject (used for graceful shutdown)
 */

const TAG = "[worker-permit-pool]";

export class WorkerPermitPool {
  readonly capacity: number;
  private _inFlight = 0;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  private destroyed = false;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`${TAG} capacity must be a positive integer, got: ${capacity}`);
    }
    this.capacity = capacity;
  }

  /**
   * Acquire a permit. If in-flight has reached capacity, suspend until woken up by release().
   * After destroy, acquire rejects immediately.
   */
  acquire(): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error(`${TAG} pool destroyed`));
    }
    if (this._inFlight < this.capacity) {
      this._inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * Return a permit. If there's a waiter, dequeue and resolve it (in-flight count unchanged);
   * otherwise decrement in-flight.
   *
   * Calling release more times than acquire is considered a programming error and throws to help locate leaks.
   */
  release(): void {
    if (this._inFlight <= 0 && this.waiters.length === 0) {
      throw new Error(`${TAG} release() called with no in-flight permit (unbalanced acquire/release)`);
    }
    const next = this.waiters.shift();
    if (next) {
      // Pass in-flight directly to waiter, count remains unchanged
      next.resolve();
    } else {
      this._inFlight--;
    }
  }

  /** Number of permits currently held. */
  inFlight(): number {
    return this._inFlight;
  }

  /** Number of permits immediately available. */
  available(): number {
    return Math.max(0, this.capacity - this._inFlight);
  }

  /** Number of acquire requests currently queued. */
  waiting(): number {
    return this.waiters.length;
  }

  /**
   * Destroy the pool: reject all waiters, and subsequent acquires reject immediately.
   * Idempotent.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const err = new Error(`${TAG} pool destroyed`);
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.reject(err);
    }
  }
}
