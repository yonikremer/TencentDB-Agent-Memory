/**
 * AutoSyncScheduler — Periodically fetches git repositories and updates codegraph index.
 *
 * Model: FIFO queue + fixed-size worker pool.
 *   - Scanner: Scans all repositories in ready status once every scanIntervalMs;
 *     deduplicates using Set (skips those already queued or in worker processing) then pushes to in-memory queue.
 *   - Workers: maxConcurrentSyncs worker routines run continuously, popping tasks FIFO from queue to call
 *     CodeGraphService.sync(); polls and waits when queue is empty, exits naturally after stop.
 *
 * Single-repo sync frequency = max(single sync duration, scanIntervalMs). No extra cooldown field —
 * adjust SCAN_INTERVAL_MIN directly to control frequency.
 *
 * Design goals:
 *   1. Periodically detect git repository updates, automatically fetch latest code and rebuild codegraph index
 *   2. Use task queue to avoid burst high-concurrency requests overloading the service (concurrency hard-limited by worker count)
 *   3. Avoid duplicate enqueuing for repos in queue or processing (Set deduplication, queue max bound = repo count)
 *   4. Single repo sync failure does not affect other repos (worker swallows exceptions and continues processing)
 *   5. Reuse CodeGraphService.sync() existing busy/not_found rejection semantics
 *
 * Environment variable configuration:
 *   - KNOWLEDGE_AUTO_SYNC_ENABLED: Enable switch (default: false)
 *   - KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN: Scan interval (minutes) (default: 10)
 *   - KNOWLEDGE_AUTO_SYNC_MAX_CONCURRENT: Global max concurrent sync count (default: 3)
 */

import { createLogger } from "../logger.js";
import type { CodeGraphService, SyncResult } from "./code-graph-service.js";
import type { IKnowledgeStore, CodeGraphRow } from "./types.js";

const log = createLogger("auto-sync-scheduler");

// ───────────────────────── Configuration ─────────────────────────

export interface AutoSyncConfig {
  /** Whether auto-sync is enabled. Default false (must be explicitly enabled). */
  enabled: boolean;
  /** Main loop scan interval (milliseconds). Default 10 minutes. */
  scanIntervalMs: number;
  /** Global max concurrent syncs (= worker count). Default 3. */
  maxConcurrentSyncs: number;
}

const MIN_MS = 60 * 1000;
/** Polling interval when worker is idle (ms). Can be advanced under test fake timers. */
const WORKER_IDLE_POLL_MS = 100;

/**
 * Resolves configuration from environment variables, supporting fallback defaults.
 * Clamps all numeric fields to prevent invalid configurations.
 */
export function resolveAutoSyncConfig(env: Record<string, string | undefined> = process.env): AutoSyncConfig {
  const enabled = parseBoolean(env.KNOWLEDGE_AUTO_SYNC_ENABLED, false);
  const scanIntervalMin = clamp(parseFloat(env.KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN ?? "") || 10, 1, 60);
  const maxConcurrent = clamp(parseInt(env.KNOWLEDGE_AUTO_SYNC_MAX_CONCURRENT ?? "") || 3, 1, 20);

  return {
    enabled,
    scanIntervalMs: scanIntervalMin * MIN_MS,
    maxConcurrentSyncs: maxConcurrent,
  };
}

// ───────────────────────── Scheduler ─────────────────────────

export interface AutoSyncSchedulerDeps {
  store: IKnowledgeStore;
  cgService: CodeGraphService;
  config: AutoSyncConfig;
}

export interface AutoSyncStatus {
  /** Whether scheduler is started (not stopped). */
  running: boolean;
  /** Number of sync tasks currently executing in workers. */
  activeSyncs: number;
  /** Number of repositories pending in queue. */
  queueLength: number;
  /** Whether previous scan round is still in progress (prevents re-entrancy). */
  scanning: boolean;
}

export class AutoSyncScheduler {
  private readonly store: IKnowledgeStore;
  private readonly cgService: CodeGraphService;
  private readonly config: AutoSyncConfig;

  /** Timers for startup delay + periodic scan. */
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  /** Set of timer handles for worker idle sleep (cleared on stop). */
  private readonly workerSleepTimers = new Set<ReturnType<typeof setTimeout>>();

  /** FIFO pending queue + deduplication Set (ids in queue or in-flight). */
  private readonly queue: CodeGraphRow[] = [];
  private readonly inFlight = new Set<string>();

  /** Count of workers currently executing sync. */
  private activeSyncs = 0;
  /** Persistent worker count. */
  private workerCount = 0;
  /** Stop flag. Worker loops exit after stop. */
  private stopped = true;
  /** Whether previous scan round is still in progress. */
  private scanning = false;

  constructor(deps: AutoSyncSchedulerDeps) {
    this.store = deps.store;
    this.cgService = deps.cgService;
    this.config = deps.config;
  }

  /**
   * Starts scheduling:
   *   - Delays first scan by 30s (allows restore to complete first, avoiding disk contention)
   *   - Periodic scanning every scanIntervalMs
   *   - Starts maxConcurrentSyncs persistent workers
   */
  start(): void {
    if (!this.config.enabled) {
      log.info("[auto-sync] disabled by config, skipping start");
      return;
    }
    if (!this.stopped) {
      log.warn("[auto-sync] already started");
      return;
    }
    this.stopped = false;
    log.info("[auto-sync] starting scheduler", {
      scanIntervalMs: this.config.scanIntervalMs,
      maxConcurrentSyncs: this.config.maxConcurrentSyncs,
    });

    // Start persistent worker pool
    for (let i = 0; i < this.config.maxConcurrentSyncs; i++) {
      this.workerCount++;
      void this.runWorker(i).finally(() => { this.workerCount--; });
    }

    // Delay first scan by 30s
    const startupDelay = 30_000;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.stopped) return;
      void this.scan();
      this.scanTimer = setInterval(() => {
        if (this.stopped) return;
        void this.scan();
      }, this.config.scanIntervalMs);
    }, startupDelay);
    log.info(`[auto-sync] first scan in ${startupDelay / 1000}s`);
  }

  /** Stops scheduler: cancels timers, signals workers to exit (in-flight syncs complete naturally). */
  stop(): void {
    this.stopped = true;
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    for (const t of this.workerSleepTimers) clearTimeout(t);
    this.workerSleepTimers.clear();
    log.info("[auto-sync] stopped");
  }

  /** Status snapshot (used by admin API). */
  getStatus(): AutoSyncStatus {
    return {
      running: !this.stopped,
      activeSyncs: this.activeSyncs,
      queueLength: this.queue.length,
      scanning: this.scanning,
    };
  }

  /** Manually triggers scan cycle (used by admin API). Does not affect periodic schedule. No-op when disabled. */
  triggerScan(): void {
    if (!this.config.enabled) {
      log.warn("[auto-sync] cannot trigger: scheduler is disabled");
      return;
    }
    log.info("[auto-sync] manual scan triggered");
    void this.scan();
  }

  // ───────────────────────── Core scan loop ─────────────────────────

  /**
   * One scan round:
   *   1. List all code-graphs in ready status
   *   2. Deduplicate using inFlight Set (repos in queue or in-flight are not re-enqueued)
   *   3. Push FIFO to queue for workers to consume automatically
   */
  private async scan(): Promise<void> {
    if (this.scanning) {
      log.debug("[auto-sync] previous scan still running, skip this round");
      return;
    }
    this.scanning = true;
    try {
      log.info("[auto-sync] scan started");

      const candidates = this.listSyncCandidates();
      if (candidates.length === 0) {
        log.info("[auto-sync] no ready repos");
        return;
      }

      let enqueued = 0;
      for (const row of candidates) {
        if (this.stopped) break;
        if (this.inFlight.has(row.code_graph_id)) continue; // Already in queue or processing
        this.inFlight.add(row.code_graph_id);
        this.queue.push(row);
        enqueued++;
      }
      log.info(`[auto-sync] enqueued ${enqueued} repo(s) (queue=${this.queue.length}, active=${this.activeSyncs})`);
    } catch (err) {
      log.error(`[auto-sync] scan error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Lists code-graphs needing sync: selects only status = ready.
   * Repositories already in queue or worker processing are deduplicated by inFlight Set in scan();
   * Single-repo sync cadence is naturally determined by max(sync duration, scanIntervalMs) with no extra cooldown.
   */
  private listSyncCandidates(): CodeGraphRow[] {
    const syncedRefs = this.store.listSyncedCodeGraphs();
    if (syncedRefs.length === 0) return [];

    const candidates: CodeGraphRow[] = [];
    for (const ref of syncedRefs) {
      try {
        const row = this.store.getCodeGraph(ref.service_id, ref.team_id, ref.code_graph_id);
        if (!row) continue;
        if (row.status !== "ready") continue;
        candidates.push(row);
      } catch (err) {
        log.warn(`[auto-sync] failed to check ${ref.code_graph_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return candidates;
  }

  // ───────────────────────── Worker pool ─────────────────────────

  /**
   * Persistent worker: continuously shifts queue to execute sync; sleeps briefly and retries when empty.
   * Loop exits naturally after stop(). Exceptions swallowed with log records to keep worker alive.
   */
  private async runWorker(workerIdx: number): Promise<void> {
    log.debug(`[auto-sync] worker#${workerIdx} started`);
    while (!this.stopped) {
      const row = this.queue.shift();
      if (!row) {
        await this.sleep(WORKER_IDLE_POLL_MS);
        continue;
      }

      this.activeSyncs++;
      try {
        await this.syncOne(row);
      } catch (err) {
        // Caught inside syncOne; this is a fallback
        log.error(`[auto-sync] worker#${workerIdx} unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.activeSyncs--;
        this.inFlight.delete(row.code_graph_id);
      }
    }
    log.debug(`[auto-sync] worker#${workerIdx} exiting`);
  }

  /** Executes sync on a single code-graph (reuses CodeGraphService.sync discriminated union). */
  private async syncOne(row: CodeGraphRow): Promise<void> {
    const startMs = Date.now();
    log.info(`[auto-sync] sync ${row.code_graph_id} (${row.repo_url}@${row.branch})`);
    try {
      // CodeGraphService.sync currently returns SyncResult synchronously; await keeps compatibility for future async or test mocks.
      const result: SyncResult = await Promise.resolve(
        this.cgService.sync(row.service_id, row.team_id, row.code_graph_id, undefined),
      );
      const durationMs = Date.now() - startMs;
      switch (result.kind) {
        case "ok":
          log.info(`[auto-sync] sync enqueued for ${row.code_graph_id} (took ${durationMs}ms)`);
          break;
        case "busy":
          log.debug(`[auto-sync] skip ${row.code_graph_id}: already ${result.status} (step: ${result.step})`);
          break;
        case "not_found":
          log.warn(`[auto-sync] skip ${row.code_graph_id}: not found (may have been deleted)`);
          break;
      }
    } catch (err) {
      log.error(`[auto-sync] sync failed for ${row.code_graph_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** setTimeout-based sleep, cleared on stop to avoid timer leaks in test environments. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.workerSleepTimers.delete(t);
        resolve();
      }, ms);
      this.workerSleepTimers.add(t);
    });
  }
}

// ───────────────────────── Helpers ─────────────────────────

function parseBoolean(val: string | undefined, fallback: boolean): boolean {
  if (val == null || val.trim() === "") return fallback;
  const v = val.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
