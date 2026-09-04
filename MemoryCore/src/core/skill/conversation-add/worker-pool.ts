/**
 * SkillWorkerPool —— In-process singleton skill extraction worker pool.
 *
 * Aligns with memory PipelineWorker: spawns N stateless consumeLoops at once,
 * which dequeue agent tuples from the globally shared SkillAgentTaskQueue.
 * The 5-segment tuple includes instance_id; after dequeuing, the worker uses
 * resolvers to dynamically fetch the corresponding instance's buffer / extractor / sink
 * based on the instance_id, and delegates the work to SkillConversationExtractWorker.consumeAgent
 * (reusing the 8-step process identically).
 *
 * Semantics are entirely identical to the old "per-instance worker":
 *   - agent-level extract-lock ensures only one loop extracts for the same (instance, agent)
 *   - tasks-mutex protects _tasks.json read-modify-write
 *   - transient / permanent error classification + DLQ
 *   - silent ghost task collection
 *
 * The only difference is topology: worker count no longer scales linearly with instance count,
 * using a single concurrency parameter to uniformly control the process-wide in-flight limit.
 * See docs/design/2026-07-30-skill-worker-instance-decoupling.md for details.
 */

import {
  LEGACY_INSTANCE_ID,
  parseAgentTuple,
  type AgentTuple,
  type ISkillAgentTaskQueue,
} from "./agent-task-queue.js";
import type { SkillBufferStorage } from "./buffer-storage.js";
import type { ExtractorLogger, ISkillExtractor } from "../queue/types.js";
import { runInRootContext } from "../../report/otel-context.js";
import { obsLogger } from "../../report/obs-logger.js";
import {
  SkillConversationExtractWorker,
  type SkillCandidatesSink,
  type SkillConversationExtractWorkerOptions,
} from "./extract-worker.js";

/**
 * Per-instance resource resolution functions captured by closures on the gateway side.
 * Uses process-level cache, <10ms first time, <1ms (Map.get) subsequently.
 */
export interface SkillWorkerResolvers {
  resolveBuffer(instanceId: string): Promise<SkillBufferStorage>;
  resolveExtractor(instanceId: string): Promise<ISkillExtractor>;
  resolveSink(instanceId: string): Promise<SkillCandidatesSink>;
}

export interface SkillWorkerPoolOptions extends SkillWorkerResolvers {
  /** Number of workers in the pool, process-wide concurrency limit. >=1. */
  concurrency: number;
  /** Process-wide shared skill agent queue. */
  queue: ISkillAgentTaskQueue;
  logger: ExtractorLogger;
  /** Pool id prefix, worker id will append index; defaults to `skill-pool-${pid}`. */
  poolId?: string;

  // ── Parameters passed through to underlying SkillConversationExtractWorker ──
  brpopBlockMs?: number;
  extractLockTtlMs?: number;
  extractLockRenewIntervalMs?: number;
  tasksMutexLockTtlMs?: number;
  tasksMutexWaitDeadlineMs?: number;
  lockContentionSleepMs?: number;
  lockContentionSleepJitterMs?: number;
  tasksPerRound?: number;
  failureRequeueSleepMs?: number;
  permanentMaxRetries?: number;
  transientLogSampleEvery?: number;
  now?: () => number;

  /**
   * 2026-08-03 crash-recovery §4.4: After the loop fails to process an agent (lock contention /
   * resolver throws / consumeAgent throws), dequeuing the same agent within a short time is skipped
   * to avoid hot-looping the pool under peek semantics. Default 200ms.
   *
   * The suppression table is kept within the loop process (per-workerLoop Map, not shared across loops —
   * independent suppression state naturally scatters contention across loops).
   */
  suppressAgentTtlMs?: number;

  /**
   * 2026-08-03 crash-recovery §4.5: Periodic self-healing scan interval (ms) on the degraded path.
   * Only enabled when queue.getPeekStrategy() === "rpop_lpush_downgrade". Default 60_000.
   * On the non-degraded path, start() only runs a cold start scan once, without starting the timer.
   */
  selfHealIntervalMs?: number;
}

export class SkillWorkerPool {
  private readonly opts: SkillWorkerPoolOptions;
  private readonly logger: ExtractorLogger;
  private readonly poolId: string;
  private closed = false;
  private started = false;
  private loopPromises: Promise<void>[] = [];
  private selfHealTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: SkillWorkerPoolOptions) {
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
      throw new Error(`[skill-worker-pool] concurrency must be positive integer, got ${opts.concurrency}`);
    }
    this.opts = opts;
    this.logger = opts.logger;
    this.poolId = opts.poolId ?? `skill-pool-${process.pid}`;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.closed = false;
    const n = this.opts.concurrency;
    this.logger.info(
      `[skill-worker-pool] start pool_id=${this.poolId} concurrency=${n} ` +
        `brpopBlockMs=${this.opts.brpopBlockMs ?? 5000} ` +
        `extractLockTtlMs=${this.opts.extractLockTtlMs ?? 600_000}`,
    );

    // 2026-08-03 crash-recovery §4.5: Cold start runs one selfHealScan, clearing historically
    // abandoned "Set has / List lacks" ghosts + legacy 4-segments. Runs before starting workerLoops to avoid race conditions.
    // Uses a fire-and-forget IIFE instead of await — pool.start() keeps its synchronous API,
    // if the scan is slow, loops run in parallel, and self-heal will patch any leaks.
    void (async () => {
      try {
        const result = await this.selfHealScan();
        this.logger.info(
          `[skill-worker-pool] self-heal cold scan done scanned=${result.scanned} ` +
            `repushed=${result.repushed} legacy_purged=${result.legacyPurged} dur_ms=${result.dur_ms}`,
        );
        obsLogger.info("skill.worker.self_heal_scan", {
          pool_id: this.poolId,
          scanned: result.scanned,
          repushed: result.repushed,
          legacy_purged: result.legacyPurged,
          dur_ms: result.dur_ms,
          trigger: "cold_start",
        });
      } catch (err) {
        this.logger.warn(
          `[skill-worker-pool] self-heal cold scan failed: ${(err as Error).message}`,
        );
      }
    })();

    // Extra periodic timer required on the degraded path. Not needed on the atomic path (peek already guarantees List state consistency).
    const strategy =
      typeof this.opts.queue.getPeekStrategy === "function"
        ? this.opts.queue.getPeekStrategy()
        : "lmove";
    if (strategy === "rpop_lpush_downgrade") {
      const interval = this.opts.selfHealIntervalMs ?? 60_000;
      this.logger.warn(
        `[skill-worker-pool] peek strategy is DOWNGRADED — starting periodic self-heal ` +
          `every ${interval}ms`,
      );
      this.selfHealTimer = setInterval(() => {
        void (async () => {
          if (this.closed) return;
          try {
            const result = await this.selfHealScan();
            obsLogger.info("skill.worker.self_heal_scan", {
              pool_id: this.poolId,
              scanned: result.scanned,
              repushed: result.repushed,
              legacy_purged: result.legacyPurged,
              dur_ms: result.dur_ms,
              trigger: "periodic_downgrade",
            });
          } catch (err) {
            this.logger.warn(
              `[skill-worker-pool] periodic self-heal failed: ${(err as Error).message}`,
            );
          }
        })();
      }, interval);
    }

    // Spin up N workerLoops. Follows the same pattern as memory PipelineWorker.start:
    // No await, all run concurrently and persistently; wait together inside stop(). Each loop runs
    // inside the OTel ROOT_CONTEXT (aligns with the old SkillConversationExtractWorker) to prevent
    // infinite loops inheriting the active span from "moment of startup", which would pollute LLM traces.
    for (let i = 0; i < n; i++) {
      const p = runInRootContext(() => this.workerLoop(i));
      p.catch(() => { /* logged inside */ });
      this.loopPromises.push(p);
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.selfHealTimer) {
      clearInterval(this.selfHealTimer);
      this.selfHealTimer = undefined;
    }
    for (const p of this.loopPromises) {
      try { await p; } catch { /* swallow */ }
    }
    this.loopPromises = [];
  }

  /**
   * One-time scan of the pending-agents-set, repairs missing items on the List side + clears legacy 4-segment residuals.
   * See docs/design/2026-07-21-skill-worker-crash-recovery.md §4.5.
   *
   * Semantics:
   *   - 5-segment legit tuple && List lacks → LPUSH to repush, repushed++
   *   - 4-segment legacy residual          → SREM + LREM to purge, legacyPurged++
   *   - 5-segment legit tuple && List has  → do nothing
   *
   * Cold start calls this once as fire-and-forget; degraded path calls it periodically.
   * Also exported for testing and troubleshooting.
   */
  async selfHealScan(): Promise<{
    scanned: number;
    repushed: number;
    legacyPurged: number;
    dur_ms: number;
  }> {
    const q = this.opts.queue;
    if (typeof q.scanAgentSet !== "function") {
      // Old queue implementation not upgraded, just return empty result, don't crash the pool.
      return { scanned: 0, repushed: 0, legacyPurged: 0, dur_ms: 0 };
    }
    const t0 = Date.now();
    let scanned = 0;
    let repushed = 0;
    let legacyPurged = 0;
    const members = await q.scanAgentSet();
    for (const raw of members) {
      scanned++;
      const parsed = parseAgentTuple(raw);
      if (!parsed || parsed.instance_id === LEGACY_INSTANCE_ID) {
        // legacy 4-segment (parse yielded instance_id === LEGACY) or corrupted (parse null) → clear.
        // Corrupted residuals are handled alongside legacy: the pool can't handle it anyway.
        await q.purgeRawAgent(raw);
        legacyPurged++;
        continue;
      }
      const inList = await q.listContains(raw);
      if (!inList) {
        await q.enqueueRawAgent(raw);
        repushed++;
      }
    }
    return { scanned, repushed, legacyPurged, dur_ms: Date.now() - t0 };
  }

  /**
   * Single worker loop. Designed to be stateless: every time an agent is received, resources are resolved on the fly,
   * constructing a one-shot SkillConversationExtractWorker to delegate to consumeAgent.
   */
  private async workerLoop(index: number): Promise<void> {
    const workerId = `${this.poolId}#${index}`;
    const blockMs = this.opts.brpopBlockMs ?? 5000;
    const suppressTtl = this.opts.suppressAgentTtlMs ?? 200;

    // 2026-08-03 crash-recovery §4.4: per-workerLoop short suppression table, prevents hot-looping
    // under peek semantics (when lock contention / resolver throws, agent stays at head; this loop won't grab it again for 200ms).
    // Other loops have independent suppression states and naturally stagger.
    const suppress = new Map<string, number>();
    const now = () => this.opts.now?.() ?? Date.now();
    const isSuppressed = (a: AgentTuple): boolean => {
      const key = `${a.instance_id}|${a.space_id}|${a.user_id}|${a.team_id}|${a.agent_id}`;
      const until = suppress.get(key);
      if (until === undefined) return false;
      if (until <= now()) { suppress.delete(key); return false; }
      return true;
    };
    const suppressAgent = (a: AgentTuple): void => {
      const key = `${a.instance_id}|${a.space_id}|${a.user_id}|${a.team_id}|${a.agent_id}`;
      suppress.set(key, now() + suppressTtl);
      // Lazy cleanup: clear expired every 100 entries
      if (suppress.size > 100) {
        const t = now();
        for (const [k, v] of suppress) if (v <= t) suppress.delete(k);
      }
    };

    while (!this.closed) {
      let agent: AgentTuple | null = null;
      try {
        // 2026-08-03 crash-recovery §4.1: Use atomic peekAgent (LMOVE semantics) to guarantee
        // agent stays in List when the loop crashes, ensuring next peek can retrieve it. See
        // docs/design/2026-07-21-skill-worker-crash-recovery.md §4.
        agent = await this.opts.queue.peekAgent(blockMs);
      } catch (err) {
        if (this.closed) break;
        this.logger.warn(`[skill-worker-pool] ${workerId} peek error: ${(err as Error).message}`);
        await sleep(200);
        continue;
      }
      if (!agent) continue;

      // Short suppression: this loop just failed this agent, skip it for a short time. Other loops have independent
      // suppression states, will grab other agents, yielding naturally.
      if (isSuppressed(agent)) {
        obsLogger.info("skill.worker.suppressed_skip", {
          worker_id: workerId,
          instance_id: agent.instance_id,
          agent_id: agent.agent_id,
        });
        // Short sleep to prevent this loop from spinning empty and immediately peeking the agent it just suppressed
        await sleep(Math.min(20, suppressTtl));
        continue;
      }

      // Legacy 4-segment fallback: instance_id === "__legacy__". Occasionally occurs during upgrade transitions,
      // discard immediately on sight + error log, do not attempt to consume (indicates version mismatch).
      //
      // 2026-08-03 crash-recovery: peekAgent uses LMOVE semantics, legacy 4-segment raw is moved
      // to the head — just doing continue would cause the pool to infinitely peek loop on the same legacy raw (OOM).
      // Must reconstruct original raw string via 4 segments, and purgeRawAgent directly via SREM+LREM to clear it out.
      // 5-segment serialize won't match this raw, so we use purgeRawAgent instead of removeAgent.
      if (agent.instance_id === LEGACY_INSTANCE_ID) {
        const legacyRaw = `${agent.space_id}|${agent.user_id}|${agent.team_id}|${agent.agent_id}`;
        this.logger.error(
          `[skill-worker-pool] ${workerId} legacy 4-segment tuple detected, purging: ${legacyRaw}`,
        );
        obsLogger.warn("skill.worker.legacy_tuple_dropped", {
          worker_id: workerId,
          space_id: agent.space_id,
          user_id: agent.user_id,
          team_id: agent.team_id,
          agent_id: agent.agent_id,
        });
        try {
          await this.opts.queue.purgeRawAgent(legacyRaw);
        } catch (err) {
          this.logger.warn(
            `[skill-worker-pool] ${workerId} purgeRawAgent(legacy) failed: ${(err as Error).message}`,
          );
        }
        continue;
      }

      try {
        const result = await this.consumeAgent(agent, workerId);
        // consumeAgent only throws unhandled errors, lock contention is result.lockContended=true.
        // Lock contention failure also enters suppression, letting other loops grab other agents.
        if (result?.lockContended) suppressAgent(agent);
      } catch (err) {
        this.logger.error(
          `[skill-worker-pool] ${workerId} consumeAgent error: ${(err as Error).message}`,
        );
        // consumeAgent throws (usually resolver error) → suppress this agent for a while,
        // letting this loop grab other agents. When suppression expires, if unresolved, it will try again.
        suppressAgent(agent);
      }
    }
  }

  /**
   * After grabbing the agent, dynamically retrieves 3 per-instance resources using resolvers based on instance_id,
   * constructs a one-shot SkillConversationExtractWorker and delegates to consumeAgent to run the 8-step process.
   *
   * Worker instances are not cached here — `new` every time is O(1) allocation + constant field copies,
   * negligible compared to 20-90 seconds of LLM extraction, achieving a completely stateless worker pool.
   */
  private async consumeAgent(
    agent: AgentTuple,
    workerId: string,
  ): Promise<{ lockContended?: boolean }> {
    const instanceId = agent.instance_id;
    const [buffer, extractor, sink] = await Promise.all([
      this.opts.resolveBuffer(instanceId),
      this.opts.resolveExtractor(instanceId),
      this.opts.resolveSink(instanceId),
    ]);

    const extractWorkerOpts: SkillConversationExtractWorkerOptions = {
      workerId,
      buffer,
      queue: this.opts.queue,
      extractor,
      sink,
      logger: this.logger,
      brpopBlockMs: this.opts.brpopBlockMs,
      extractLockTtlMs: this.opts.extractLockTtlMs,
      extractLockRenewIntervalMs: this.opts.extractLockRenewIntervalMs,
      tasksMutexLockTtlMs: this.opts.tasksMutexLockTtlMs,
      tasksMutexWaitDeadlineMs: this.opts.tasksMutexWaitDeadlineMs,
      lockContentionSleepMs: this.opts.lockContentionSleepMs,
      lockContentionSleepJitterMs: this.opts.lockContentionSleepJitterMs,
      tasksPerRound: this.opts.tasksPerRound,
      failureRequeueSleepMs: this.opts.failureRequeueSleepMs,
      permanentMaxRetries: this.opts.permanentMaxRetries,
      transientLogSampleEvery: this.opts.transientLogSampleEvery,
      now: this.opts.now,
    };
    const oneShot = new SkillConversationExtractWorker(extractWorkerOpts);
    // Directly call consumeAgent — follows the identical 8-step process (extract-lock / renewTimer /
    // tasks-mutex / transient-permanent / DLQ / ghost detection). Returns lockContended for upstream short suppression table usage.
    const result = await oneShot.consumeAgent(agent);
    return { lockContended: result.lockContended };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
