/**
 * PipelineWorker - Competing Consumer for Pipeline Tasks
 *
 * Requirement #12 Worker Competing Consumption + #13 Dead Letter Queue and Failure Handling
 *
 * Architecture Doc §Plan C:
 * - XREADGROUP Consumer Group competing consumption task (single queue)
 * - Distributed lock protection: per-session (L1/L2), per-instance (L3)
 * - Lock renewal: renew every 30s, abort on failure
 * - LLM execution + Write: fetch buffer -> call LLM -> write VDB/COS
 * - Cascading schedule: L1->L2 (via onL1Complete timer advance), L2->L3 (direct enqueue)
 * - Dead letter queue: exceed retry limit -> write to dead letter
 * - Retry strategy: lock grab failure 5s requeue, LLM timeout exponential backoff 5s/15s/45s
 * - Idempotency: VDB upsert by record_id, COS overwrite
 */

import type { IStateBackend, TaskPayload } from "../core/state/types.js";
import { serializeTraceContext } from "../core/report/trace-propagation.js";
import { obsLogger } from "../core/report/obs-logger.js";

// ============================
// Types
// ============================

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** L1/L2/L3 Task Executor (Concrete LLM + VDB logic injected by upper layer)
 *
 * H-11 Step 2: methods optionally accept an AbortSignal. When the worker loses
 * its distributed lock mid-execution, it aborts the signal so the executor
 * can promptly tear down in-flight LLM calls. Executors that ignore the
 * signal still work (the worker will skip ACK after lockLost), but they
 * waste compute / tokens until the LLM call naturally returns.
 */
export interface TaskExecutor {
  executeL1(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeL2(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeL3(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeFlush?(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeOffloadL1?(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeOffloadL15?(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeOffloadL2?(task: TaskPayload, signal?: AbortSignal): Promise<void>;
}

export interface PipelineWorkerConfig {
  /** Worker Node ID */
  workerId?: string;
  /** Concurrency consumption coroutine count (default: 60). Each coroutine independently consumes tasks, different sessions execute in parallel. */
  concurrency?: number;
  /** Consumption polling interval ms (default: 200) */
  pollIntervalMs?: number;
  /**
   * Lock TTL ms (default: 600000 = 10min).
   * Must be >= 2 * max(LLM timeout): default LLM timeout is 120s,
   * leave enough buffer to ensure that even if the renewal timer misses 1-2
   * ticks due to GC / event loop blocking, the lock will not expire and be grabbed by others.
   *
   * Also determines the single-round backoff window length on lock conflict: under massive import,
   * multiple sessions of the same agent may queue for a long time, a window that is too short
   * will frequently trigger re-enqueue (see MAX_LOCK_REQUEUE).
   */
  lockTtlMs?: number;
  /** Lock renewal interval ms (default: 30000 = 1/8 of TTL, avoid renewal failure) */
  lockRenewIntervalMs?: number;
  /** Max retry count (default: 3) */
  maxRetries?: number;
  /** Retry base delay ms (default: 5000, exponential backoff) */
  retryBaseDelayMs?: number;
  /** Pending message recovery interval ms (default: 30000) */
  pendingRecoveryIntervalMs?: number;
  /** Pending message timeout threshold ms (default: 300000 = 5min, must be > lockTtlMs) */
  pendingStaleMs?: number;
  /** Dead letter task persistence callback */
  onDeadLetter?: (task: TaskPayload, error: string, retryCount: number) => Promise<void>;
  /**
   * Callback after L1 completes, used to advance L2 timer (solves L2 fast path).
   * Injected by server.ts via statefulManager.advanceL2TimerAfterL1.
   * If not injected, L2 relies solely on maxInterval as fallback.
   */
  onL1Complete?: (sessionId: string, instanceId: string, teamId?: string, agentId?: string) => Promise<void>;
  /**
   * Callback after L2 completes, used to set L2 maxInterval timer.
   * Injected by server.ts via statefulManager.armL2MaxInterval.
   */
  onL2Complete?: (sessionId: string, instanceId: string, teamId?: string, agentId?: string) => Promise<void>;
  /**
   * Distributed lock granularity (default: "session")
   * - "session": L1/L2 per-session lock, L3 per-instance lock (original behavior, max concurrency)
   * - "instance": L1/L2/L3 all per-instance lock (CR-1 temporary mitigation: prevents concurrent append
   *   to daily JSONL shared key for same instance different session. Trade-off is complete serial execution within instance.)
   *
   * Switching this value does not affect persistent state (lock is a temporary key with TTL=120s).
   * During rollout, the switch must be synchronized across all workers within lockTtlMs to avoid old/new workers holding locks simultaneously with different keys.
   */
  lockGranularity?: "session" | "instance";

  /**
   * Concurrency semaphore inside PipelineWorker. Historically shared across memory + skill V2 worker,
   * after skill refactor on 2026-07-17, the skill side no longer uses semaphores for concurrency limit, now memory
   * pipeline is the only consumer. Behavior unchanged if not injected. processTask entry acquire, finally release.
   */
  permitPool?: import("./worker-permit-pool.js").WorkerPermitPool;
}

export interface DeadLetterEntry {
  task: TaskPayload;
  error: string;
  retryCount: number;
  deadAt: number;
}

const TAG = "[pipeline-worker]";

/**
 * Max requeue count allowed after lock conflict.
 *
 * In massive import scenarios, thousands of sessions of the same agent may queue for the same lock;
 * A single backoff window (lockTtlMs) is not enough for all tasks to acquire the lock, so they are requeued
 * after timeout instead of being dropped. 15 times coupled with lockTtlMs provides a sufficiently long total retry window,
 * while preventing tasks from infinite requeuing in abnormal situations.
 */
const MAX_LOCK_REQUEUE = 15;

// ============================
// PipelineWorker
// ============================

export class PipelineWorker {
  private backend: IStateBackend;
  private executor: TaskExecutor;
  private config: Required<Omit<PipelineWorkerConfig, "onDeadLetter" | "onL1Complete" | "onL2Complete" | "permitPool">> & {
    onDeadLetter?: PipelineWorkerConfig["onDeadLetter"];
    onL1Complete?: PipelineWorkerConfig["onL1Complete"];
    onL2Complete?: PipelineWorkerConfig["onL2Complete"];
    permitPool?: PipelineWorkerConfig["permitPool"];
  };
  private logger: Logger;

  private running = false;
  private destroyed = false;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;

  // Active locks tracked for graceful shutdown
  private activeLocks = new Set<string>();

  // In-flight tasks (consumed but not yet completed/failed/dropped). Used by
  // standalone /v2/pipeline/status to compute per-L-type running stats.
  // Service mode never reads this — it just costs a Map.set/delete per task.
  private runningTasks = new Map<string, TaskPayload>();

  // Dead letter queue (in-process + optional callback persistence)
  private deadLetterQueue: DeadLetterEntry[] = [];

  // Metrics
  private metrics = {
    tasksConsumed: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksRetried: 0,
    tasksDeadLettered: 0,
    lockConflicts: 0,
    /** H-11: number of times renewLock callback failed → lockLost=true was set. */
    lockRenewFailed: 0,
    /** H-11: number of times execution finished but lockLost was true → task left in PENDING for another worker. */
    lockLostDuringExecution: 0,
    /** H-11 Step 2: number of times an executor was aborted via AbortSignal due to lockLost. */
    executionAborted: 0,
  };

  constructor(backend: IStateBackend, executor: TaskExecutor, config?: PipelineWorkerConfig, logger?: Logger) {
    this.backend = backend;
    this.executor = executor;
    this.logger = logger ?? { info: console.log, warn: console.warn, error: console.error };
    this.config = {
      workerId: config?.workerId ?? `worker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      concurrency: config?.concurrency ?? 60,
      pollIntervalMs: config?.pollIntervalMs ?? 200,
      lockTtlMs: config?.lockTtlMs ?? 600000,
      lockRenewIntervalMs: config?.lockRenewIntervalMs ?? 30000,
      maxRetries: config?.maxRetries ?? 3,
      retryBaseDelayMs: config?.retryBaseDelayMs ?? 5000,
      pendingRecoveryIntervalMs: config?.pendingRecoveryIntervalMs ?? 30000,
      pendingStaleMs: config?.pendingStaleMs ?? 300000,
      onDeadLetter: config?.onDeadLetter,
      onL1Complete: config?.onL1Complete,
      onL2Complete: config?.onL2Complete,
      lockGranularity: config?.lockGranularity ?? "session",
      permitPool: config?.permitPool,
    };
  }

  // ============================
  // Lifecycle
  // ============================

  async start(): Promise<void> {
    if (this.destroyed || this.running) return;
    this.running = true;

    this.logger.info(`${TAG} Starting (workerId=${this.config.workerId}, concurrency=${this.config.concurrency})`);

    // Start pending message recovery loop
    this.startPendingRecovery();

    // Start N concurrent consumption coroutines
    for (let i = 0; i < this.config.concurrency; i++) {
      this.consumeLoop();
    }
  }

  async stop(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.running = false;

    // Stop pending recovery
    if (this.recoveryTimer) { clearInterval(this.recoveryTimer); this.recoveryTimer = null; }

    // Release all active locks
    for (const lockKey of this.activeLocks) {
      try { await this.backend.releaseLock(lockKey, this.config.workerId); } catch { /* best effort */ }
    }
    this.activeLocks.clear();

    this.logger.info(
      `${TAG} Stopped (consumed=${this.metrics.tasksConsumed}, completed=${this.metrics.tasksCompleted}, ` +
      `failed=${this.metrics.tasksFailed}, deadLettered=${this.metrics.tasksDeadLettered})`,
    );
  }

  getMetrics() {
    return { ...this.metrics, workerId: this.config.workerId, deadLetterCount: this.deadLetterQueue.length };
  }

  /**
   * Snapshot of tasks currently being executed by this worker (after lock
   * acquisition, before completion/failure). Used by standalone
   * /v2/pipeline/status to compute per-L-type running stats. Service mode
   * never calls this. Returns a fresh array (Map values copy).
   */
  getRunningTasks(): TaskPayload[] {
    return Array.from(this.runningTasks.values());
  }

  getDeadLetterQueue(): readonly DeadLetterEntry[] {
    return this.deadLetterQueue;
  }

  // ============================
  // Consume Loop
  // ============================

  private async consumeLoop(): Promise<void> {
    while (this.running && !this.destroyed) {
      try {
        const task = await this.backend.consumeTask(this.config.workerId, this.config.pollIntervalMs);
        if (!task) continue;

        this.metrics.tasksConsumed++;
        await this.processTask(task);
      } catch (err) {
        if (!this.destroyed) {
          this.logger.error(`${TAG} Consume loop error: ${err instanceof Error ? err.message : String(err)}`);
          await this.sleep(1000); // Avoid crazy retries
        }
      }
    }
  }

  // ============================
  // Task Processing
  // ============================

  private async processTask(task: TaskPayload): Promise<void> {
    const lockKey = this.getLockKey(task);
    const retryCount = (task.data?.retryCount as number) ?? 0;

    // permitPool acquire: memory pipeline internal concurrency rate limiting (historically shared across skill V2,
    // after 2026-07 skill side no longer uses semaphores for concurrency limit). No-op if pool not injected.
    // Both lock-free and with-lock branches must finally release -- use releasePermitOnce for idempotency.
    const permitPool = this.config.permitPool;
    if (permitPool) {
      await permitPool.acquire();
    }
    let permitReleased = false;
    const releasePermitOnce = (): void => {
      if (permitReleased) return;
      permitReleased = true;
      if (permitPool) {
        try { permitPool.release(); }
        catch (err) {
          this.logger.warn(`${TAG} permitPool release error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

    // Lock-free path: offload-l1 doesn't need distributed lock
    if (lockKey === null) {
      this.runningTasks.set(task.id, task);
      try {
        await this.executeTask(task, undefined);

        // ACK
        const msgId = (task as any)._msgId;
        if (msgId) await this.backend.ackTask(msgId);

        this.metrics.tasksCompleted++;
        this.logger?.debug?.(`${TAG} Task completed (lock-free): ${task.type} [${task.instanceId}/${task.sessionId}]`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.metrics.tasksFailed++;

        if (retryCount < this.config.maxRetries) {
          const delay = this.config.retryBaseDelayMs * Math.pow(3, retryCount);
          this.logger.warn(`${TAG} Task failed (lock-free, retry ${retryCount + 1}/${this.config.maxRetries}, delay=${delay}ms): ${errMsg}`);
          const msgId = (task as any)._msgId;
          if (msgId) { try { await this.backend.ackTask(msgId); } catch { /* best effort */ } }
          await this.sleep(delay);
          await this.reEnqueue(task, retryCount + 1);
          this.metrics.tasksRetried++;
        } else {
          await this.moveToDeadLetter(task, errMsg, retryCount);
        }
      } finally {
        this.runningTasks.delete(task.id);
        releasePermitOnce();

        // Deferred enqueue (same as locked path)
        const deferred = (task as any)._deferredEnqueue as TaskPayload[] | undefined;
        if (deferred?.length) {
          for (const dTask of deferred) {
            try {
              await this.backend.enqueueTask(dTask);
              this.logger?.debug?.(`${TAG} Deferred enqueue: ${dTask.type} [${dTask.id}]`);
            } catch (err) {
              this.logger?.warn?.(`${TAG} Deferred enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
      return;
    }

    // Step 1: Grab distributed lock
    const locked = await this.backend.acquireLock(lockKey, this.config.workerId, this.config.lockTtlMs);
    if (!locked) {
      this.metrics.lockConflicts++;

      // offload-l2: skip immediately on lock conflict (idempotent timer will re-trigger)
      if (task.type === "offload-l2") {
        this.logger?.debug?.(`${TAG} Lock conflict [offload-l2] (task=${task.id}): ${lockKey}, skip (timer will re-trigger)`);
        const msgId = (task as any)._msgId;
        if (msgId) {
          try { await this.backend.ackTask(msgId); } catch { /* best effort */ }
        }
        releasePermitOnce();
        return;
      }

      // Lock conflict: current coroutine waits locally (no re-enqueue to stream).
      // Exponential backoff: 200ms → 600ms → 1.8s → 5s (capped), retry until lockTtlMs exhausted.
      // Old version fixed sleep(5000) under instance level lock caused poor queueing experience (accumulation of seconds delay for multi-session same instance);
      // Changed to exponential backoff, most conflicts resolved within 1s, while retaining long-tail backoff to avoid backend pressure.
      // Only this coroutine is occupied; other 9 continue consuming different sessions.
      const deadline = Date.now() + this.config.lockTtlMs;
      let acquired = false;
      let attempt = 0;
      let delay = 200;
      while (Date.now() < deadline && this.running) {
        attempt++;
        this.logger?.debug?.(`${TAG} Lock conflict [${task.type}] (task=${task.id}): ${lockKey}, retry ${attempt} after ${delay}ms`);
        await this.sleep(delay);
        acquired = await this.backend.acquireLock(lockKey, this.config.workerId, this.config.lockTtlMs);
        if (acquired) break;
        delay = Math.min(delay * 3, 5000);
      }
      if (!acquired) {
        // Failed to grab lock within backoff window: requeue instead of dropping.
        //
        // Why must ACK first then requeue with new id (instead of not ACKing and letting XPENDING requeue):
        // CR-1 verified not ACKing causes stale recovery to infinitely re-claim the same msgId,
        // exhausting worker slots. ACKing the old message + enqueuing a new task here
        // guarantees no loss and does not rely on pending requeue mechanism.
        //
        // lockRetryCount prevents infinite loop: same task requeued max MAX_LOCK_REQUEUE times.
        const retryCount = Number((task.data as Record<string, unknown> | undefined)?.lockRetryCount ?? 0);
        const msgId = (task as any)._msgId;

        if (retryCount < MAX_LOCK_REQUEUE) {
          const requeued: TaskPayload = {
            ...task,
            id: `${task.id}-lr${retryCount + 1}`,
            createdAt: Date.now(),
            data: { ...(task.data ?? {}), lockRetryCount: retryCount + 1 },
          };
          delete (requeued as any)._msgId;

          let enqueued = false;
          try {
            await this.backend.enqueueTask(requeued);
            enqueued = true;
          } catch (err) {
            this.logger?.warn?.(
              `${TAG} Lock conflict requeue failed [${task.type}] (task=${task.id}): ` +
              (err instanceof Error ? err.message : String(err)),
            );
          }

          if (enqueued) {
            this.logger?.info?.(
              `${TAG} Lock conflict timeout [${task.type}] (task=${task.id}): ${lockKey}, ` +
              `requeued as ${requeued.id} (attempt ${retryCount + 1}/${MAX_LOCK_REQUEUE})`,
            );
            if (msgId) {
              try { await this.backend.ackTask(msgId); } catch { /* best effort */ }
            }
            releasePermitOnce();
            return;
          }
          // 重投失败则退回到丢弃路径，避免消息悬挂
        } else {
          this.logger?.error?.(
            `${TAG} Lock conflict exhausted [${task.type}] (task=${task.id}): ${lockKey}, ` +
            `dropping after ${retryCount} requeues`,
          );
        }

        if (msgId) {
          try { await this.backend.ackTask(msgId); } catch { /* best effort */ }
        }
        releasePermitOnce();
        return;
      }
      // Fall through to execute with acquired lock
    }

    this.activeLocks.add(lockKey);
    // Track in-flight task — used by standalone /v2/pipeline/status. Done after
    // lock acquisition so lock-conflict drops don't pollute the running set.
    this.runningTasks.set(task.id, task);
    let lockLost = false;
    // H-11 Step 2: AbortController so renewLock failure can immediately interrupt
    // long-running LLM calls inside the executor (saves token cost and avoids
    // writing data after the lock has been transferred to another worker).
    const abortController = new AbortController();

    // Step 2: Start lock renewal (local timer, per-task independent)
    const renewTimer = setInterval(async () => {
      try {
        const renewed = await this.backend.renewLock(lockKey, this.config.workerId, this.config.lockTtlMs);
        if (!renewed) {
          this.metrics.lockRenewFailed++;
          this.logger.warn(
            `${TAG} Lock renew failed for ${lockKey} (worker=${this.config.workerId}); ` +
            `marking lockLost and aborting executor`,
          );
          lockLost = true;
          clearInterval(renewTimer);
          // H-11 Step 2: signal the executor to abort. Any in-flight LLM / VDB call
          // wired to this signal will throw an AbortError and tear down cleanly.
          if (!abortController.signal.aborted) {
            this.metrics.executionAborted++;
            abortController.abort(new Error("pipeline-worker: lock lost during execution"));
          }
        }
      } catch (e) {
        this.metrics.lockRenewFailed++;
        this.logger.warn(
          `${TAG} Lock renew threw for ${lockKey}: ${e instanceof Error ? e.message : String(e)}`,
        );
        lockLost = true;
        clearInterval(renewTimer);
        if (!abortController.signal.aborted) {
          this.metrics.executionAborted++;
          abortController.abort(new Error("pipeline-worker: lock renew exception"));
        }
      }
    }, this.config.lockRenewIntervalMs);

    // Step 3: Execute task
    try {
      await this.executeTask(task, abortController.signal);

      // H-11 Step 1: re-check lockLost after successful executeTask.
      // If the lock was lost mid-execution we must NOT ack and NOT cascade
      // because another worker has already (or will) take over via XPENDING/XCLAIM
      // recovery, and ACK'ing here would cause a silent partial-failure where the
      // task is removed from the stream while only half of its side effects landed.
      if (lockLost) {
        this.metrics.lockLostDuringExecution++;
        this.logger.warn(
          `${TAG} Lock lost during execution but task body returned; ` +
          `skipping ACK + cascadeSchedule so another worker can re-process: ` +
          `${task.type} [${task.instanceId}/${task.sessionId}]`,
        );
        // NOTE: rely on L1/L2/L3 idempotency (vectorStore.upsert by memoryId
        // is idempotent; jsonl appends use ETag/append-position so concurrent
        // writers don't corrupt). Hard rollback not feasible for COS objects.
        return;
      }

      // Step 4: ACK
      const msgId = (task as any)._msgId;
      if (msgId) await this.backend.ackTask(msgId);

      this.metrics.tasksCompleted++;
      this.logger?.debug?.(`${TAG} Task completed: ${task.type} [${task.instanceId}/${task.sessionId}]`);

      // Step 5: Cascading schedule (L1->L2, L2->L3)
      await this.cascadeSchedule(task);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // Check if lock is lost -> if lost, do not retry (avoid duplicate execution)
      if (lockLost) {
        this.logger.warn(`${TAG} Lock lost during execution, aborting: ${task.type} [${task.instanceId}/${task.sessionId}]`);
        this.metrics.tasksFailed++;
        return;
      }

      this.metrics.tasksFailed++;

      // Exponential backoff retry
      if (retryCount < this.config.maxRetries) {
        const delay = this.config.retryBaseDelayMs * Math.pow(3, retryCount); // 5s, 15s, 45s
        this.logger.warn(
          `${TAG} Task failed (retry ${retryCount + 1}/${this.config.maxRetries}, delay=${delay}ms): ${errMsg}`,
        );
        // CR-1 fix: ACK the original message before re-enqueue. Otherwise the original
        // msgId stays in XPENDING and gets re-claimed by stale recovery in parallel
        // with the retry, causing the same task to run twice.
        const msgId = (task as any)._msgId;
        if (msgId) {
          try { await this.backend.ackTask(msgId); } catch { /* best effort */ }
        }
        await this.sleep(delay);
        await this.reEnqueue(task, retryCount + 1);
        this.metrics.tasksRetried++;
      } else {
        await this.moveToDeadLetter(task, errMsg, retryCount);
      }
    } finally {
      // Step 6: Stop renewal + release lock
      clearInterval(renewTimer);
      this.activeLocks.delete(lockKey);
      this.runningTasks.delete(task.id);
      try { await this.backend.releaseLock(lockKey, this.config.workerId); } catch { /* best effort */ }
      releasePermitOnce();

      // Step 7: Deferred enqueue - executor can use task._deferredEnqueue to temporarily store tasks that need to be enqueued after the lock is released,
      // avoiding unnecessary lock conflicts caused by new tasks being consumed immediately while the same session lock is still held.
      const deferred = (task as any)._deferredEnqueue as TaskPayload[] | undefined;
      if (deferred?.length) {
        for (const dTask of deferred) {
          try {
            await this.backend.enqueueTask(dTask);
            this.logger?.debug?.(`${TAG} Deferred enqueue: ${dTask.type} [${dTask.id}]`);
          } catch (err) {
            this.logger?.warn?.(`${TAG} Deferred enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  }

  private async executeTask(task: TaskPayload, signal?: AbortSignal): Promise<void> {
    switch (task.type) {
      case "L1": return this.executor.executeL1(task, signal);
      case "L2": return this.executor.executeL2(task, signal);
      case "L3": return this.executor.executeL3(task, signal);
      case "flush": return this.executor.executeFlush?.(task, signal) ?? this.executor.executeL1(task, signal);
      case "offload-l1": return this.executor.executeOffloadL1?.(task, signal);
      case "offload-l15": return this.executor.executeOffloadL15?.(task, signal);
      case "offload-l2": return this.executor.executeOffloadL2?.(task, signal);
      default:
        this.logger.warn(`${TAG} Unknown task type: ${task.type}`);
    }
  }

  // ============================
  // Cascading Schedule
  // ============================

  private async cascadeSchedule(task: TaskPayload): Promise<void> {
    const now = Date.now();
    const tid = task.teamId ?? (task.data as any)?.teamId;
    const aid = task.agentId ?? (task.data as any)?.agentId;

    if (task.type === "L1" || task.type === "flush") {
      // L1 完成 → reset session-level L1 state, then advance agent/profile-level L2 timers.
      await this.backend.updateSessionState(task.instanceId, task.sessionId, {
        conversation_count: 0,
      }, tid, aid);
      const profileScopes = Array.isArray((task as any)._l2ProfileScopes)
        ? ((task as any)._l2ProfileScopes as string[]).filter(Boolean)
        : [];
      const l2Keys = profileScopes.length > 0 ? profileScopes : [task.sessionId];
      if (this.config.onL1Complete) {
        for (const l2Key of l2Keys) {
          try {
            await this.backend.updateSessionState(task.instanceId, l2Key, { l2_pending_l1_count: 1 }, tid, aid);
            await this.config.onL1Complete(l2Key, task.instanceId, tid, aid);
          } catch (err) {
            this.logger?.warn?.(`${TAG} onL1Complete failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      this.logger?.debug?.(`${TAG} [${task.instanceId}/${task.sessionId}] L1 done → L2 timer advanced (${l2Keys.join(",")})`);
    }

    if (task.type === "L2") {
      // If L2 was skipped (no new L1 records), don't cascade to L3 or arm timer
      if ((task as any)._l2Skipped) {
        this.logger?.debug?.(`${TAG} [${task.instanceId}/${task.sessionId}] L2 skipped (no new data), not arming timer or enqueuing L3`);
        return;
      }

      // L2 completed -> enqueue L3 directly (carrying trace context for cross-async link correlation)
      // L3 task also carries team/agent, keep lock granularity aligned
      await this.backend.enqueueTask({
        id: `L3-${task.instanceId}-${now}`,
        type: "L3",
        instanceId: task.instanceId,
        sessionId: task.sessionId,
        teamId: tid,
        agentId: aid,
        priority: 2,
        data: task.data ? { ...task.data, ...serializeTraceContext() } : { teamId: tid, agentId: aid, ...serializeTraceContext() },
        createdAt: now,
      });
      await this.backend.updateSessionState(task.instanceId, task.sessionId, {
        l2_pending_l1_count: 0,
        l2_last_extraction_time: new Date().toISOString(),
      }, tid, aid);
      // onL2Complete is injected by server.ts via statefulManager.armL2MaxInterval
      if (this.config.onL2Complete) {
        try {
          await this.config.onL2Complete(task.sessionId, task.instanceId, tid, aid);
        } catch (err) {
          this.logger?.warn?.(`${TAG} onL2Complete failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.logger?.debug?.(`${TAG} [${task.instanceId}/${task.sessionId}] L2 done → L3 enqueued`);
    }
  }

  // ============================
  // Lock Management
  // ============================

  /**
   * Lock key design:
   *
   * v2 pipeline default (lockGranularity="session", actually dispersed by (instance, team, agent)):
   *   - L1: pipeline:{inst:tid:aid}:s:{sess}   - session level lock
   *           L1 data is isolated by (team,user,agent,session) in TCVDB,
   *           different sessions extract concurrently.
   *   - L2: pipeline:{inst:tid:aid}            - agent level lock
   *           L2 lands in profiles/team:T|agent:X/scene_blocks/ shared directory,
   *           L2 of different sessions of the same agent must be mutually exclusive to avoid collision when writing scene/index files.
   *   - L3: pipeline:{inst:tid:aid}            - agent level lock (same as L2)
   *           L3 writes profiles/team:T|agent:X/persona.md, one copy per agent.
   *
   * Fully concurrent across agents: different (tid, aid) disperse to different Redis Cluster slots,
   * avoiding centralization to a single hash slot in a single instance causing a large key hot spot.
   *
   * When teamId / agentId are missing (old calls / offload), fallback to "_:_" placeholder,
   * equivalent to falling into the same slot by instance dimension - compatible with old behavior, won't break lock mutual exclusion.
   *
   * lockGranularity="instance" (legacy CR-1 mitigation):
   *   - L1/L2/L3: pipeline:{instanceId}        - All share the same lock at instance level
   *   Not recommended, kept for backward compatibility. New deployments should use the default.
   *
   * Rolling upgrade caveat:
   *   During the upgrade window, new and old pods see different lock key formats, which may temporarily break cross-pod
   *   mutual exclusion. This upgrade is physically isolated by keyPrefix from tdai_memory -> tdai_memory_v2,
   *   new and old pods go to different redis namespaces, no intersection.
   */
  private getLockKey(task: TaskPayload): string | null {
    // offload-l1 is lock-free: rename guarantees exclusive file ownership,
    // appendFile is atomic (O_APPEND), and state.json is read-only for L1.
    if (task.type === "offload-l1") return null;

    // offload-l2: per-MMD lock so different MMDs can be processed concurrently.
    if (task.type === "offload-l2") {
      const mmdFile = (task.data as any)?.targetMmdFile ?? "default";
      return `pipeline:{${task.instanceId}}:offload-l2:${mmdFile}`;
    }

    // offload-l15: lock-free at worker level. The executor acquires a short
    // lock only during the final write phase (state.json update), allowing
    // multiple L1.5 LLM calls to run concurrently without blocking each other.
    if (task.type === "offload-l15") return null;

    if (this.config.lockGranularity === "instance") {
      return `pipeline:{${task.instanceId}}`;
    }

    // v2 default: disperse hash tag by (instance, team, agent)
    //
    // teamId/agentId priority:
    //   1. task.teamId / task.agentId (explicitly carried when v2 enqueues)
    //   2. task.data.teamId / task.data.agentId (compatible with old calls)
    //   3. parsed from task.sessionId (L2/L3 tasks enqueued by timer-scanner,
    //      sessionId is like "profile:team:T|agent:A" or
    //      "profile:team:T|agent:A|session:S", extract tid/aid from it)
    //   4. "_" placeholder fallback to instance level (not recommended, hash centralized)
    let tid = task.teamId || (task.data as any)?.teamId;
    let aid = task.agentId || (task.data as any)?.agentId;
    if (!tid || !aid) {
      const m = task.sessionId.match(/^profile:team:([^|]+)\|agent:([^|]+)(?:\|session:.+)?$/);
      if (m) {
        // The team field in profile scope is actually (teamId || userId), consistent with buildProfileIsolationScope.
        // Just use it as teamId here, as long as the hash bucketing dimension aligns.
        // If the key carries a source session, it only serves as L2 input boundary, not entering lock granularity.
        tid = tid || m[1];
        aid = aid || m[2];
      }
    }
    tid = tid || "_";
    aid = aid || "_";
    const ns = `{${task.instanceId}:${tid}:${aid}}`;

    if (task.type === "L2" || task.type === "L3") {
      // agent level lock: L2/L3 of the same agent are mutually exclusive to avoid collision when writing to shared directory
      return `pipeline:${ns}`;
    }
    // L1 + flush are still session level
    return `pipeline:${ns}:s:${task.sessionId}`;
  }

  // ============================
  // Dead Letter (#13)
  // ============================

  private async moveToDeadLetter(task: TaskPayload, error: string, retryCount: number): Promise<void> {
    const entry: DeadLetterEntry = { task, error, retryCount, deadAt: Date.now() };
    this.deadLetterQueue.push(entry);
    this.metrics.tasksDeadLettered++;

    this.logger.error(
      `${TAG} Dead letter: ${task.type} [${task.instanceId}/${task.sessionId}] after ${retryCount} retries: ${error}`,
    );

    // CR-1 fix: ACK the original message to prevent stale recovery from picking it up
    // again. Without this, a dead-lettered task remains in XPENDING and gets re-claimed
    // every pendingRecoveryIntervalMs, causing infinite retry loops that block the
    // worker pool (root-caused from a production incident).
    const msgId = (task as any)._msgId;
    if (msgId) {
      try { await this.backend.ackTask(msgId); } catch { /* best effort */ }
    }

    // Clean up timers for this session to prevent ghost triggers
    try {
      const tid = task.teamId ?? (task.data as any)?.teamId;
      const aid = task.agentId ?? (task.data as any)?.agentId;
      await this.backend.removeTimer(task.instanceId, buildPipelineTimerMember(task.sessionId, "L1_idle", { teamId: tid, agentId: aid }));
      await this.backend.removeTimer(task.instanceId, buildPipelineTimerMember(task.sessionId, "L2_schedule", { teamId: tid, agentId: aid }));
    } catch { /* best effort */ }

    // Critical node log: task enters dead letter queue
    obsLogger.error("core.task.dead_letter", {
      instance_id: task.instanceId,
      session_id: task.sessionId,
      task_type: task.type,
      task_id: task.id,
      error,
      retry_count: retryCount,
    });

    // Persistence callback (write to COS / Stream)
    if (this.config.onDeadLetter) {
      try {
        await this.config.onDeadLetter(task, error, retryCount);
      } catch (err) {
        this.logger.error(`${TAG} onDeadLetter callback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async reEnqueue(task: TaskPayload, newRetryCount: number): Promise<void> {
    await this.backend.enqueueTask({
      ...task,
      id: `${task.type}-${task.sessionId}-retry${newRetryCount}-${Date.now()}`,
      data: { ...task.data, retryCount: newRetryCount },
      createdAt: Date.now(),
    });
  }

  // ============================
  // Pending Message Recovery (#13.2: XPENDING timeout check + XCLAIM)
  // ============================

  /**
   * Periodically scan for pending messages in the remote queue that timed out without ACK.
   *
   * When a Worker process dies, the messages it consumed but did not ACK will be stuck in the pending list.
   * Surviving Workers take over these messages for reprocessing via the backend's claimStaleTasks.
   *
   * Guarantees:
   * - Idempotency: VDB upsert by record_id, COS overwrite
   * - No duplication: Backend atomically transfers ownership, the same message will only be claimed by one Worker
   */
  private startPendingRecovery(): void {
    if (!this.backend.claimStaleTasks) return; // LocalStateBackend does not need this

    this.recoveryTimer = setInterval(async () => {
      if (this.destroyed) return;
      try {
        const stale = await this.backend.claimStaleTasks!(
          this.config.workerId,
          this.config.pendingStaleMs,
          10, // claim up to 10 at a time
        );
        if (stale.length > 0) {
          this.logger.info(`${TAG} Recovered ${stale.length} stale pending task(s)`);
          for (const task of stale) {
            this.metrics.tasksConsumed++;
            // Directly process the claimed task (goes through normal processTask flow)
            this.processTask(task).catch((err) => {
              this.logger.error(`${TAG} Recovery task failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        }
      } catch (err) {
        this.logger.warn(`${TAG} Pending recovery error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, this.config.pendingRecoveryIntervalMs);
  }

  // ============================
  // Util
  // ============================

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => { const t = setTimeout(r, ms); t.unref(); });
  }
}
