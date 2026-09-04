/**
 * SkillConversationExtractWorker — §9.
 *
 * Persistent loop:
 *   ① BRPOP agent
 *   ② Acquire extract-lock; if failed → requeue + sleep
 *   ③ Acquire tasks-mutex to read head task
 *   ④ Read archive:
 *        404 → ghost task → acquire mutex, filter delete task, skip
 *        success → SkillExtractor.extract → sink.applyCandidates → acquire mutex, filter delete task
 *   ⑤ Decide whether to requeue (more tasks → requeue, else removeAgent)
 *   ⑥ Release extract-lock
 *
 * Concurrency protection:
 *   - agent-level extract-lock ensures only one Worker extracts per agent
 *   - tasks-mutex protects _tasks.json read-modify-write (same lock as Handler archiving phase)
 */

import type {
  AgentTuple,
  ExtractLockHandle,
  ISkillAgentTaskQueue,
} from "./agent-task-queue.js";
import type {
  SkillBufferStorage,
  SkillDeadTaskEntry,
  SkillTaskEntry,
} from "./buffer-storage.js";
import type {
  ExtractedCandidate,
  ExtractorLogger,
  ISkillExtractor,
} from "../queue/types.js";
import { runInRootContext } from "../../report/otel-context.js";
import { obsLogger } from "../../report/obs-logger.js";
import { trace } from "../../report/trace.js";

/**
 * Persists candidates to the business side (e.g., calling SkillCore.create/patch, or writing directly to SkillStore).
 * Injected by the wiring layer, Worker does not care about the implementation. Must be idempotent (Client retries may cause task to be extracted multiple times).
 */
export interface SkillCandidatesSink {
  applyCandidates(input: {
    task: SkillTaskEntry;
    candidates: ExtractedCandidate[];
    /** For trace / logging purposes */
    workerId: string;
  }): Promise<void>;
}

export interface SkillConversationExtractWorkerOptions {
  workerId: string;
  buffer: SkillBufferStorage;
  queue: ISkillAgentTaskQueue;
  extractor: ISkillExtractor;
  sink: SkillCandidatesSink;
  logger: ExtractorLogger;

  /** BRPOP block duration ms, default 5000. */
  brpopBlockMs?: number;
  /** extract-lock TTL ms, default 600_000 (10 min). */
  extractLockTtlMs?: number;
  /**
   * extract-lock renewal interval ms, default extractLockTtlMs / 4.
   *
   * Skill extract via LLM tool-calling review agent may span multiple iterations,
   * total duration may approach or exceed lockTtl. Renewal ensures Worker isn't preempted
   * by other Workers while actively extracting. Default lockRenewIntervalMs = ttl/4 (aligning with legacy V2 worker params).
   */
  extractLockRenewIntervalMs?: number;
  /** tasks-mutex lock TTL ms (fallback for process crash), default 10000. */
  tasksMutexLockTtlMs?: number;
  /** tasks-mutex contention max wait time, default 30000. */
  tasksMutexWaitDeadlineMs?: number;
  /** Sleep duration ms before dequeuing after extract-lock contention failure. Default 2000 + jitter. */
  lockContentionSleepMs?: number;
  lockContentionSleepJitterMs?: number;
  /**
   * Max tasks to extract per agent in one round before requeuing to yield (fairness), default 1.
   * Design doc states Worker requeues agent to head after processing one task.
   */
  tasksPerRound?: number;
  /** Time source for test injection. */
  now?: () => number;

  // ── Failure handling (transient / permanent classification + DLQ) ────────────────────────
  //
  // Aligns with design doc §3.6 (7) P0 fix: originally, extraction failure caught and directly requeue+break,
  // runLoop immediately dequeued same agent causing ~100/s hot retries, wasting LLM quota and flooding logs.
  // Now classified by error nature into two types:
  //
  //   A) transient (401/403/429/5xx/network/timeout/fetch)
  //      → sleep(failureRequeueSleepMs) → requeue
  //      → retry_count unchanged, no DLQ, infinite retries until external recovery
  //      → warn sampling: logs one warn every transientLogSampleEvery times
  //   B) permanent (400/422/JSON parse/schema)
  //      → sleep → retry_count++ written to _tasks.json → requeue
  //      → moved to _tasks_dlq.json when retry_count >= permanentMaxRetries
  //      → Unclassifiable errors treated as A (fallback to prevent data loss)
  /**
   * Sleep ms before requeuing on failure, fixed value (no exponential backoff, no jitter).
   * Default 2000.
   */
  failureRequeueSleepMs?: number;
  /**
   * Cumulative permanent errors before entering DLQ, default 3.
   */
  permanentMaxRetries?: number;
  /**
   * transient error warn logging interval (times) sampled by task_id. 1st time logs error,
   * subsequently logs one warn every N times, preventing log flooding. Default 60.
   */
  transientLogSampleEvery?: number;
}

export class SkillConversationExtractWorker {
  private readonly opts: SkillConversationExtractWorkerOptions;
  private readonly logger: ExtractorLogger;
  private closed = false;
  private started = false;
  private loopPromise: Promise<void> | null = null;
  /**
   * per-task_id transient failure counter (in-process, not persisted). Used for warn sampling:
   * First failure logs error, subsequently logs one warn every transientLogSampleEvery times.
   * Reset on process restart is fine — sampling purpose is merely limiting log frequency, not auditing.
   */
  private readonly transientFailStreak = new Map<string, number>();

  constructor(opts: SkillConversationExtractWorkerOptions) {
    this.opts = opts;
    this.logger = opts.logger;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.closed = false;
    this.logger.info(
      `[skill-conv-worker] start id=${this.opts.workerId} brpopBlockMs=${this.opts.brpopBlockMs ?? 5000} ` +
        `extractLockTtlMs=${this.opts.extractLockTtlMs ?? 600_000}`,
    );
    // CRITICAL: start runLoop within OTel ROOT_CONTEXT.
    //
    // This worker is often lazily started within some HTTP request handler (resolveConversationAdd →
    // wireConversationAdd → start()). If not detached from context, the never-exiting runLoop will
    // permanently inherit the active span from the "moment of startup", causing all subsequent LLM spans
    // to attach to that single request trace, merged into one by Langfuse (tags crossing multiple agents, sessionId chaotic).
    // See report/otel-context.ts.
    this.loopPromise = runInRootContext(() => this.runLoop());
    // Silent unhandled rejection
    this.loopPromise.catch(() => { /* logged inside */ });
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch { /* swallow */ }
    }
  }

  /**
   * Consumes one agent singly. For testing exclusively (sync execution). Returns processing result for assertions.
   *
   * 2026-08-03 crash-recovery §4.1: dequeues using peekAgent (RPOP+LPUSH atomic, LMOVE semantics),
   * agent remains in List from the moment retrieved, if worker crashes midway, next peek will still grab it.
   * See docs/design/2026-07-21-skill-worker-crash-recovery.md §4.
   */
  async runOnce(): Promise<{
    agent?: AgentTuple;
    processedTaskIds: string[];
    lockContended?: boolean;
    dropped?: string[]; // ghost / tasks dropped due to extraction failure
  }> {
    const agent = await this.opts.queue.peekAgent(this.opts.brpopBlockMs ?? 5000);
    if (!agent) return { processedTaskIds: [] };
    return this.consumeAgent(agent);
  }

  private async runLoop(): Promise<void> {
    const blockMs = this.opts.brpopBlockMs ?? 5000;
    while (!this.closed) {
      let agent: AgentTuple | null = null;
      try {
        agent = await this.opts.queue.peekAgent(blockMs);
      } catch (err) {
        if (this.closed) break;
        this.logger.warn(`[skill-conv-worker] peek error: ${(err as Error).message}`);
        await sleep(200);
        continue;
      }
      if (!agent) continue;
      try {
        await this.consumeAgent(agent);
      } catch (err) {
        this.logger.error(`[skill-conv-worker] consumeAgent error: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Full 8-step process consuming one agent. Called internally by runLoop by default; also exposed
   * for reuse by SkillWorkerPool — each workerLoop in the pool handles scheduling (dequeue +
   * resolver + legacy fallback), actual extraction goes here, avoiding duplicate implementation.
   */
  async consumeAgent(agent: AgentTuple): Promise<{
    agent: AgentTuple;
    processedTaskIds: string[];
    lockContended?: boolean;
    dropped?: string[];
  }> {
    const q = this.opts.queue;
    const extractLockTtl = this.opts.extractLockTtlMs ?? 600_000;
    const mutexOpts = {
      lockTtlMs: this.opts.tasksMutexLockTtlMs ?? 10_000,
      waitDeadlineMs: this.opts.tasksMutexWaitDeadlineMs ?? 30_000,
    };
    const perRound = this.opts.tasksPerRound ?? 1;
    const processedTaskIds: string[] = [];
    const dropped: string[] = [];

    // 2026-08-03 crash-recovery: peek strategy dictates behavior for success/failure branches.
    //   - lmove / evalsha / eval  → Atomic path, agent already in List, branches no longer explicitly requeue,
    //     success path also no longer removes, relies on next peek finding empty tasks for lazy deletion.
    //   - rpop_lpush_downgrade    → Non-atomic v1 semantics: failure/success branches requeue/remove as usual,
    //     coupled with pool side periodic selfHealScan fallback.
    // See docs/design/2026-07-21-skill-worker-crash-recovery.md §5.3.
    const isDowngrade =
      (typeof q.getPeekStrategy === "function" ? q.getPeekStrategy() : "lmove") ===
      "rpop_lpush_downgrade";

    const instanceId = agent.instance_id;
    // agentKey retains 4-segment (space|user|team|agent) semantics, no instance_id segment added —
    // compatible with legacy observation dashboard SQL aggregating by agent_key. instance_id is attached as a separate field,
    // allowing backend grouping/filtering by instance dimension (for troubleshooting post pooling-refactor).
    const agentKey = `${agent.space_id}|${agent.user_id}|${agent.team_id}|${agent.agent_id}`;
    // [obs] worker segmental events: consume_start → acquire_lock → read_head →
    //   read_archive → extractor → apply_candidates → delete_task → consume_done.
    // Before getting task_id, locates via agent_key + worker_id; after task_id is ready, every event
    // carries task_id — handler's skill.trigger.enqueue_agent event already carries same task_id,
    // so backend can fetch full handler + worker dual-segment trace by task_id.
    // obsLogger internal try/catch + backend degradation, no extra defense needed.
    const workerId = this.opts.workerId;
    const t0Consume = Date.now();
    obsLogger.info("skill.worker.consume_start", {
      worker_id: workerId, agent_key: agentKey, instance_id: instanceId,
    });
    this.logger.info(`[skill-conv-worker] dequeued agent=${agentKey}`);

    // ② Acquire extract-lock
    const t0Lock = Date.now();
    const handle = await q.acquireExtractLock(agent, extractLockTtl);
    obsLogger.info("skill.worker.acquire_lock", {
      worker_id: workerId, agent_key: agentKey, instance_id: instanceId,
      dur_ms: Date.now() - t0Lock, acquired: !!handle,
    });
    if (!handle) {
      // 2026-08-03: On atomic path agent is already in List (peek guarantees), no requeue needed;
      // On degraded path uses v1 semantics, requeues outside mutex to ensure agent is not lost.
      if (isDowngrade) {
        this.logger.info(`[skill-conv-worker] extract-lock contended agent=${agentKey}, requeue+sleep (downgrade)`);
        await q.requeueAgent(agent);
      } else {
        this.logger.info(`[skill-conv-worker] extract-lock contended agent=${agentKey}, sleep (peek keeps agent in queue)`);
      }
      const jitter = Math.floor(Math.random() * (this.opts.lockContentionSleepJitterMs ?? 500));
      await sleep((this.opts.lockContentionSleepMs ?? 2000) + jitter);
      obsLogger.info("skill.worker.consume_done", {
        worker_id: workerId, agent_key: agentKey, instance_id: instanceId,
        outcome: "lock_contended", dur_ms: Date.now() - t0Consume,
      });
      return { agent, processedTaskIds: [], lockContended: true };
    }
    this.logger.info(`[skill-conv-worker] acquired extract-lock agent=${agentKey}`);

    // ②.5 Start renewal timer — guarantees lock isn't dropped during LLM long-runs
    const renewInterval = this.opts.extractLockRenewIntervalMs ?? Math.floor(extractLockTtl / 4);
    let renewTimer: ReturnType<typeof setInterval> | undefined;
    if (renewInterval > 0) {
      renewTimer = setInterval(() => {
        void (async () => {
          try {
            const ok = await q.renewExtractLock(handle, extractLockTtl);
            if (!ok) {
              this.logger.warn(
                `[skill-conv-worker] renew extract-lock lost agent=${agentKey}`,
              );
              if (renewTimer) clearInterval(renewTimer);
              renewTimer = undefined;
            }
          } catch (err) {
            this.logger.warn(
              `[skill-conv-worker] renew extract-lock error: ${(err as Error).message}`,
            );
          }
        })();
      }, renewInterval);
    }

    try {
      for (let round = 0; round < perRound; round++) {
        // ③ Acquire mutex to read head task.
        //
        // Critical fix (root cause of ghost tasks): removeAgent after null check MUST complete
        // within the SAME tasks-mutex critical section, not after mutex release — otherwise
        // TriggerService.archive() could grab mutex in this lockless window and write new
        // task, but Redis Set has not excised the agent yet (removeAgent in this function
        // hasn't run yet), SADD in enqueueAgent will return 0 due to "Set already has" and skip
        // LPUSH — new task persists but Redis queue has zero record, permanently stuck as a ghost task.
        // Folding removeAgent into same lock, partnered with trigger-service.ts fix
        // (enqueueAgent moved inside write task critical section), ensures mutual exclusion on both sides.
        const t0Head = Date.now();
        const head = await q.withTasksMutex(agent, mutexOpts, async () => {
          const doc = await this.opts.buffer.readTasks(agent);
          const first = doc.tasks[0] ?? null;
          if (!first) {
            await q.removeAgent(agent);
          }
          return first;
        });
        obsLogger.info("skill.worker.read_head", {
          worker_id: workerId, agent_key: agentKey, instance_id: instanceId,
          dur_ms: Date.now() - t0Head, has_head: !!head,
        });

        if (!head) {
          // tasks empty → agent already taken offline within critical section above, break
          obsLogger.info("skill.worker.consume_done", {
            worker_id: workerId, agent_key: agentKey, instance_id: instanceId,
            outcome: "empty", dur_ms: Date.now() - t0Consume,
          });
          return { agent, processedTaskIds, dropped };
        }

        // task_id is ready: from here downwards all events carry task_id, linked with handler side
        // (handler's skill.trigger.enqueue_agent already attached it).
        const t0Task = Date.now();
        obsLogger.info("skill.worker.task_start", {
          worker_id: workerId,
          task_id: head.task_id,
          instance_id: instanceId,
          task_ref_id: head.task_ref_id,
          session_id: head.session_id,
          team_id: head.team_id,
          agent_id: head.agent_id,
          archive_key: head.archive_key,
        });

        // ④ Read archive
        let candidates: ExtractedCandidate[] | null = null;
        let isGhost = false;
        try {
          this.logger.info(
            `[skill-conv-worker] processing task_id=${head.task_id} archive_key=${head.archive_key}`,
          );
          const t0Arch = Date.now();
          const archive = await this.opts.buffer.readArchive(head.archive_key);
          obsLogger.info("skill.worker.read_archive", {
            worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
            dur_ms: Date.now() - t0Arch,
            found: !!archive,
            msg_count: archive?.messages?.length ?? 0,
          });
          if (!archive) {
            isGhost = true;
            this.logger.warn(
              `[skill-conv-worker] ghost task, dropping task_id=${head.task_id} archive_key=${head.archive_key}`,
            );
            obsLogger.warn("skill.worker.ghost", {
              worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
              archive_key: head.archive_key,
            });
          } else {
            const conversation = (archive.messages ?? []).map((m) => ({
              role: String(m.role ?? "user"),
              content: String(m.content ?? ""),
            }));
            this.logger.info(
              `[skill-conv-worker] extract start task_id=${head.task_id} messages=${conversation.length}`,
            );
            const t0Ext = Date.now();
            const result = await this.opts.extractor.extract({
              task_id: head.task_id,
              team_id: head.team_id,
              user_id: head.user_id,
              agent_id: head.agent_id,
              // Langfuse trace binding fields: if omitted, skill.extract trace
              // sessionId=null / instanceId=unknown, filtering by session in UI yields nothing.
              session_id: head.session_id,
              space_id: head.space_id,
              conversation,
              // direct-trigger (`/v3/skill/extract`) exclusive passthrough fields; tasks from conversation/add archiving
              // don't carry these fields, undefined does not affect extractor (uses defaults).
              reason: head.reason,
              options: head.max_iterations != null
                ? { max_iterations: head.max_iterations }
                : undefined,
            });
            candidates = result.candidates ?? [];
            obsLogger.info("skill.worker.extractor", {
              worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
              dur_ms: Date.now() - t0Ext,
              candidates: candidates.length,
              msg_count: conversation.length,
            });
            this.logger.info(
              `[skill-conv-worker] extract done task_id=${head.task_id} candidates=${candidates.length}`,
            );
            const t0Sink = Date.now();
            await this.opts.sink.applyCandidates({
              task: head,
              candidates,
              workerId: this.opts.workerId,
            });
            obsLogger.info("skill.worker.apply_candidates", {
              worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
              dur_ms: Date.now() - t0Sink,
              candidates: candidates.length,
            });
          }
        } catch (err) {
          // Failure classification (aligning with design doc §3.6 (7) P0 fix):
          //   transient → sleep + requeue, retry_count unchanged
          //   permanent → sleep + retry_count++ write back; move to DLQ when threshold met
          //   classification fallback → handle as transient (conservatively avoid data loss)
          const errMsg = (err as Error).message ?? String(err);
          const category = classifyError(err as Error);
          if (category === "transient") {
            this.logTransientFailure(head.task_id, errMsg);
            // Note: outcome uses shorthand `retry_transient`, lacking "transient" keyword —
            // DLQ unit test uses .includes("transient") to assert transient sampling counters,
            // avoiding obsLogger events getting included.
            obsLogger.info("skill.worker.task_done", {
              worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
              outcome: "retry_transient", dur_ms: Date.now() - t0Task,
            });
            await sleep(this.opts.failureRequeueSleepMs ?? 2000);
            // 2026-08-03: On atomic peek path agent remains in List, task.json untouched,
            // next peek simply gets the same head to rerun; on degraded path explicit requeue.
            if (isDowngrade) await q.requeueAgent(agent);
            break;
          }
          // permanent
          // Clear transient counter, preventing past transients from interfering with future sampling.
          this.transientFailStreak.delete(head.task_id);
          obsLogger.info("skill.worker.task_done", {
            worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
            outcome: "dlq_or_retry", dur_ms: Date.now() - t0Task,
          });
          await sleep(this.opts.failureRequeueSleepMs ?? 2000);
          await this.handlePermanentFailure(agent, head, errMsg, mutexOpts, isDowngrade);
          break;
        }

        // ⑤ Successful extraction or ghost task → CAS filter delete task (by task_id).
        //
        // 2026-08-03 crash-recovery §4.1: Atomic peek path no longer evaluates remaining tasks
        // and no longer requeues/removes — agent stays in List constantly, relying on next peek reading empty tasks
        // for lazy deletion within the same mutex (see step ③ tasks empty branch).
        //
        // Degraded path (peekAgent only pops doesn't push) uses v1 semantics: evaluates remainder → requeue/remove,
        // order preserved against trigger-service.archive() through same mutex.
        const t0Del = Date.now();
        let remainingTasks = 0;
        await q.withTasksMutex(agent, mutexOpts, async () => {
          const doc = await this.opts.buffer.readTasks(agent);
          const before = doc.tasks.length;
          doc.tasks = doc.tasks.filter((t) => t.task_id !== head.task_id);
          if (doc.tasks.length !== before) {
            doc.updated_at_ms = this.opts.now?.() ?? Date.now();
            await this.opts.buffer.writeTasks(agent, doc);
          }
          remainingTasks = doc.tasks.length;
          if (isDowngrade) {
            if (doc.tasks.length > 0) {
              await q.requeueAgent(agent);
            } else {
              await q.removeAgent(agent);
            }
          }
          // Atomic path: do nothing, agent is in List, next peek triggers lazy deletion.
        });
        obsLogger.info("skill.worker.delete_task", {
          worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
          dur_ms: Date.now() - t0Del,
          remaining: remainingTasks,
        });

        // trace.report backend span: aligned with skill.extract / skill.conversation_add,
        // using task_id fetches the full handler + worker dual-segment trace in clickhouse / langfuse.
        try {
          trace.report("skill.worker.task_done", {
            task_id: head.task_id,
            instance_id: instanceId,
            task_ref_id: head.task_ref_id,
            team_id: head.team_id,
            agent_id: head.agent_id,
            session_id: head.session_id,
            outcome: isGhost ? "ghost" : "ok",
            candidates: candidates?.length ?? 0,
            dur_ms: Date.now() - t0Task,
            success: true,
          });
        } catch { /* noop */ }

        obsLogger.info("skill.worker.task_done", {
          worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
          outcome: isGhost ? "ghost" : "ok",
          candidates: candidates?.length ?? 0,
          dur_ms: Date.now() - t0Task,
        });

        if (isGhost) dropped.push(head.task_id);
        else processedTaskIds.push(head.task_id);
      }

      obsLogger.info("skill.worker.consume_done", {
        worker_id: workerId, agent_key: agentKey, instance_id: instanceId,
        outcome: "ok",
        processed: processedTaskIds.length,
        dropped: dropped.length,
        dur_ms: Date.now() - t0Consume,
      });
      return { agent, processedTaskIds, dropped };
    } finally {
      // ⑥ Stop renewal + release extract-lock
      if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = undefined;
      }
      try {
        await q.releaseExtractLock(handle);
      } catch (err) {
        this.logger.warn(
          `[skill-conv-worker] releaseExtractLock error: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * transient failure log sampling: initially printed at error level, thereafter every N times prints
   * one summary at warn level, preventing log flooding. N is controlled by `transientLogSampleEvery` (default 60).
   */
  private logTransientFailure(taskId: string, errMsg: string): void {
    const prev = this.transientFailStreak.get(taskId) ?? 0;
    const streak = prev + 1;
    this.transientFailStreak.set(taskId, streak);
    const every = this.opts.transientLogSampleEvery ?? 60;
    if (streak === 1) {
      this.logger.error(
        `[skill-conv-worker] transient extract failure task=${taskId}: ${errMsg}`,
      );
    } else if (every > 0 && streak % every === 0) {
      this.logger.warn(
        `[skill-conv-worker] transient extract failure (x${streak}) task=${taskId}: ${errMsg}`,
      );
    }
  }

  /**
   * permanent failure: acquires tasks-mutex for `_tasks.json` read-modify-write.
   *
   *   - retry_count+1 < permanentMaxRetries: writes back task entry, requeues agent
   *   - retry_count+1 >= permanentMaxRetries: removes task from `_tasks.json`,
   *     appends to `_tasks_dlq.json`, remainder tasks decide requeue / remove
   *
   * Crucially: `_tasks.json` read-modify-write MUST be within the same critical section, matching
   * success path pattern (avoiding race conditions with trigger-service.archive()). DLQ writes do not occupy
   * the mutex: Worker already holds extract-lock, only one writer exists for the same agent.
   */
  private async handlePermanentFailure(
    agent: AgentTuple,
    head: SkillTaskEntry,
    errMsg: string,
    mutexOpts: { lockTtlMs: number; waitDeadlineMs: number },
    isDowngrade: boolean,
  ): Promise<void> {
    const q = this.opts.queue;
    const maxRetries = this.opts.permanentMaxRetries ?? 3;
    const truncated = errMsg.length > 1024 ? errMsg.slice(0, 1024) : errMsg;
    const nowMs = () => this.opts.now?.() ?? Date.now();

    let deadTask: SkillTaskEntry | null = null;

    await q.withTasksMutex(agent, mutexOpts, async () => {
      const doc = await this.opts.buffer.readTasks(agent);
      const idx = doc.tasks.findIndex((t) => t.task_id === head.task_id);
      if (idx < 0) {
        // task already removed elsewhere (ghost collection / DLQ rerun), this permanent failure is invalid.
        this.logger.warn(
          `[skill-conv-worker] permanent failure but task gone task=${head.task_id}`,
        );
        // 2026-08-03: Atomic path does not requeue/remove, relies on next round lazy deletion; degraded path v1 semantics.
        if (isDowngrade) {
          if (doc.tasks.length > 0) await q.requeueAgent(agent);
          else await q.removeAgent(agent);
        }
        return;
      }
      const cur = doc.tasks[idx]!;
      const nextRetry = (cur.retry_count ?? 0) + 1;
      if (nextRetry >= maxRetries) {
        // → DLQ: remove from _tasks.json
        deadTask = { ...cur, retry_count: nextRetry, last_error: truncated };
        doc.tasks.splice(idx, 1);
        doc.updated_at_ms = nowMs();
        await this.opts.buffer.writeTasks(agent, doc);
        this.logger.error(
          `[skill-conv-worker] permanent failure → DLQ task=${head.task_id} ` +
            `retries=${nextRetry}/${maxRetries} err=${truncated}`,
        );
      } else {
        doc.tasks[idx] = { ...cur, retry_count: nextRetry, last_error: truncated };
        doc.updated_at_ms = nowMs();
        await this.opts.buffer.writeTasks(agent, doc);
        this.logger.warn(
          `[skill-conv-worker] permanent failure task=${head.task_id} ` +
            `retries=${nextRetry}/${maxRetries} err=${truncated}`,
        );
      }
      if (isDowngrade) {
        if (doc.tasks.length > 0) await q.requeueAgent(agent);
        else await q.removeAgent(agent);
      }
    });

    // Write to DLQ outside the mutex: Worker holds extract-lock exclusively for this agent, DLQ has no other writer.
    if (deadTask) {
      const dead: SkillDeadTaskEntry = {
        ...(deadTask as SkillTaskEntry),
        dead_lettered_at_ms: nowMs(),
      };
      try {
        await this.opts.buffer.appendDlq(agent, dead);
      } catch (err) {
        this.logger.error(
          `[skill-conv-worker] appendDlq failed task=${head.task_id}: ${(err as Error).message}`,
        );
      }
    }
  }
}

/**
 * Classifies Errors thrown by extract/sink into transient (self-healing) or permanent (data/schema).
 * Simple rules, string matches HTTP status codes + keywords in error messages; unclassifiable
 * fall back to transient — conservatively avoiding data loss.
 *
 * Full classification matrix see docs/design/2026-07-21-memorycore-standalone-e2e.md §3.6 (7).
 */
export function classifyError(err: Error): "transient" | "permanent" {
  const raw = `${err?.name ?? ""} ${err?.message ?? ""}`;
  const msg = raw.toLowerCase();
  // AbortError (LLM request signal cancel / timeout) treated as transient
  if ((err?.name ?? "") === "AbortError") return "transient";

  // ── permanent prioritized match: explicit 4xx data/schema errors ──
  // HTTP 400 / 422
  if (/(^|[^\d])(400|422)([^\d]|$)/.test(msg)) return "permanent";
  // JSON parse error / schema validation error / "invalid response" class
  if (
    msg.includes("json.parse") ||
    msg.includes("unexpected token") ||
    msg.includes("invalid json") ||
    msg.includes("invalid response") ||
    msg.includes("schema") ||
    msg.includes("zod") ||
    msg.includes("validation failed")
  ) {
    return "permanent";
  }

  // ── transient identification ──
  // HTTP 401/403/429/5xx
  if (/(^|[^\d])(401|403|429|5\d{2})([^\d]|$)/.test(msg)) return "transient";
  // common network error codes / fetch layer
  if (
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("eai_again") ||
    msg.includes("socket hang up") ||
    msg.includes("client network socket disconnected") ||
    msg.includes("fetch failed") ||
    msg.includes("und_err_") ||
    msg.includes("timeout") ||
    msg.includes("timed out")
  ) {
    return "transient";
  }

  // Fallback: unclassifiable treated as transient (no data loss)
  return "transient";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
