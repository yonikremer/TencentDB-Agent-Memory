/**
 * Checkpoint management for tracking memory processing progress.
 *
 * ## Split-state design
 *
 * Per-session state is split into two independent namespaces to prevent
 * the PipelineManager and L0/L1 runners from overwriting each other's fields:
 *
 * - **runner_states** (`RunnerSessionState`): owned by CheckpointManager methods
 *   (markL1*, advanceSession*). Contains L0 capture cursor, L1 cursor, scene name.
 *
 * - **pipeline_states** (`PipelineSessionState`): owned exclusively by
 *   PipelineManager via `mergePipelineStates()`. Contains conversation_count,
 *   extraction times, L2 tracking fields.
 *
 * Each side only reads/writes its own namespace, eliminating the split-brain
 * overwrite bug where pipeline persistStates() could clobber runner-written fields.
 *
 * ## Concurrency safety
 *
 * All mutating methods (read-modify-write) are serialized via a per-file async lock.
 * Multiple CheckpointManager instances sharing the same file path automatically share
 * the same lock, so callers can freely `new CheckpointManager()` without coordination.
 * Writes use atomic tmp+rename to prevent corruption on crash.
 */

import { randomBytes } from "node:crypto";
import type { StorageAdapter } from "../core/storage/adapter.js";
import { StoragePaths } from "../core/storage/types.js";

// ============================
// Types
// ============================

/**
 * Per-session state managed by L0/L1 runners (written directly to checkpoint).
 * These fields are ONLY written by CheckpointManager methods (markL1*, advanceSession*, etc.)
 * and are NEVER touched by the PipelineManager's persistStates().
 */
export interface RunnerSessionState {
  // ═══ L0 — per-session capture cursor ═══
  /** Epoch ms of the newest message captured for THIS session.
   *  Used instead of the global `Checkpoint.last_captured_timestamp` so that
   *  concurrent sessions don't advance each other's cursors and cause missed messages. */
  last_captured_timestamp: number;

  // ═══ L1 — cursor & continuity ═══
  /** L0 JSONL cursor: epoch ms of last message processed by L1 */
  last_l1_cursor: number;
  /** Last scene name from the most recent L1 extraction (for cross-batch continuity) */
  last_scene_name: string;
}

/**
 * Per-session state managed exclusively by PipelineManager (written via mergePipelineStates).
 * These fields are ONLY written by the pipeline's persistStates() callback
 * and are NEVER touched by CheckpointManager's L0/L1 methods.
 */
export interface PipelineSessionState {
  /** Conversation rounds since last L1 trigger */
  conversation_count: number;
  /** ISO timestamp of the last extraction completion */
  last_extraction_time: string;
  /** ISO timestamp cursor for incremental extraction reads */
  last_extraction_updated_time: string;
  /** Epoch ms of the last notifyConversation call */
  last_active_time: number;
  /** Mirrors conversation_count at L1 completion time (for L2 tracking) */
  l2_pending_l1_count: number;
  /**
   * Current warm-up threshold for L1 triggering.
   * Starts at 1 for new sessions and doubles after each L1 completion
   * (1 → 2 → 4 → 8 → ...) until it reaches everyNConversations.
   * 0 means warm-up is complete (use everyNConversations directly).
   */
  warmup_threshold: number;
  /** ISO timestamp of last L2 extraction completion */
  l2_last_extraction_time: string;
}

export interface Checkpoint {
  // ═══ Global counters ═══
  /** Epoch ms of the newest message successfully uploaded. Messages with ts > this are new. */
  last_captured_timestamp: number;
  /** Total messages processed across all time */
  total_processed: number;
  last_persona_at: number;
  last_persona_time: string;
  request_persona_update: boolean;
  persona_update_reason: string;
  memories_since_last_persona: number;
  scenes_processed: number;

  // ═══ Per-session split state ═══
  /** Runner-managed per-session state (L0 capture cursor, L1 cursor, scene name).
   *  Written ONLY by CheckpointManager methods. */
  runner_states: Record<string, RunnerSessionState>;
  /** Pipeline-managed per-session state (conversation_count, extraction times, etc.).
   *  Written ONLY by the pipeline's mergePipelineStates(). */
  pipeline_states: Record<string, PipelineSessionState>;

  // ═══ L0 ═══
  /** Total L0 conversation files recorded */
  l0_conversations_count: number;

  // ═══ L1 ═══
  /** Total L1 memories extracted across all time */
  total_memories_extracted: number;
}

const DEFAULT_RUNNER_STATE: RunnerSessionState = {
  last_captured_timestamp: 0,
  last_l1_cursor: 0,
  last_scene_name: "",
};

const DEFAULT_PIPELINE_STATE: PipelineSessionState = {
  conversation_count: 0,
  last_extraction_time: "",
  last_extraction_updated_time: "",
  last_active_time: 0,
  l2_pending_l1_count: 0,
  warmup_threshold: 0, // 0 = graduated (safe default for old sessions missing this field)
  l2_last_extraction_time: "",
};

const DEFAULT_CHECKPOINT: Checkpoint = {
  last_captured_timestamp: 0,
  total_processed: 0,
  last_persona_at: 0,
  last_persona_time: "",
  request_persona_update: false,
  persona_update_reason: "",
  memories_since_last_persona: 0,
  scenes_processed: 0,
  runner_states: {},
  pipeline_states: {},
  l0_conversations_count: 0,
  total_memories_extracted: 0,
};

export interface CheckpointLogger {
  info(msg: string): void;
  warn?(msg: string): void;
}

const noopLogger: CheckpointLogger = { info() {} };

// ============================
// Per-file async lock
// ============================
// Keyed by resolved file path. Multiple CheckpointManager instances pointing
// to the same file automatically share the same lock — callers don't need to
// coordinate instance creation.

const fileLocks = new Map<string, Promise<void>>();

/**
 * Serialize async critical sections per file path.
 * Under no contention the overhead is a single resolved-promise await.
 */
async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  // Chain after whatever is currently queued for this path
  const prev = fileLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  fileLocks.set(filePath, gate);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Clean up the map entry if we're the tail of the chain
    if (fileLocks.get(filePath) === gate) {
      fileLocks.delete(filePath);
    }
  }
}

/**
 * Minimal lock interface required for cross-node mutual exclusion.
 *
 * Naturally satisfied by IStateBackend (Redis); in standalone mode simply do not inject it,
 * because withFileLock is sufficient in a single process.
 */
export interface CheckpointDistributedLock {
  acquireLock(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string, ownerId: string): Promise<void>;
  /**
   * Renew (can only renew a lock held by self).
   *
   * Must provide: checkpoint critical section contains 2 object storage IOs, may exceed ttlMs on COS jitter.
 * Without renewal, lock expires silently → latecomer acquires it legally → two nodes in critical section simultaneously,
 * and owner validation in releaseLock prevents the earlier one from "deleting someone else's lock" thus yielding no errors,
 * resulting in the hardest to debug silent dual-writes.
   */
  renewLock(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
}

/** Observable counters for checkpoint writes (injected by caller for reporting to existing metric channels) */
export interface CheckpointLockMetrics {
  /** Number of times write is abandoned after lock failure, requesting upper layer retry */
  onRequeueRequired?(key: string, waitedMs: number): void;
  /** Number of times backend anomaly causes degradation (lockless execution) */
  onBackendError?(key: string, err: unknown): void;
  /** Number of times write is abandoned due to renewal failure */
  onLockLost?(key: string): void;
  /** Wait time for each successful lock acquisition, used to calculate p50/p95/p99 */
  onAcquireWait?(key: string, waitedMs: number): void;
}

export interface CheckpointLockOptions {
  /** Distributed lock backend; defaults to relying solely on in-process locks */
  lock: CheckpointDistributedLock;
  /** Lock key, must uniquely identify this checkpoint object (usually instanceId) */
  lockKey: string;
  /** Upper limit for lock holding duration to prevent deadlock after process crash */
  ttlMs?: number;
  /** Maximum wait time for lock acquisition */
  maxWaitMs?: number;
  /** Renewal interval, default ttlMs/3 */
  renewIntervalMs?: number;
  /** Observable counters */
  metrics?: CheckpointLockMetrics;
}

/**
 * Thrown when lock cannot be acquired / is lost mid-way.
 *
 * Semantics: This checkpoint **was not written**, upper layer must re-enqueue instead of treating as successful.
 * The old implementation degraded to "lockless hard write" here, which equals writing knowing it will overwrite others,
 * directly causing L1 cursor loss.
 */
export class CheckpointLockUnavailableError extends Error {
  readonly code = "CHECKPOINT_LOCK_UNAVAILABLE";
  constructor(message: string, readonly lockKey: string) {
    super(message);
    this.name = "CheckpointLockUnavailableError";
  }
}

/**
 * TTL 60s: Although critical section is mainly "one GET + one PUT", COS jitter / large file
 * serialization can prolong duration; combined with renewLock, TTL serves only as "post-crash
 * self-healing upper limit", no longer a hard constraint that "critical section must finish within".
 */
const DEFAULT_LOCK_TTL_MS = 60_000;
/** Maximum wait for lock acquisition. Must be < Task lock TTL (600s) to avoid dragging down upper layer task lock. */
const DEFAULT_LOCK_MAX_WAIT_MS = 30_000;

export class CheckpointManager {
  private filePath: string;
  private logger: CheckpointLogger;
  private storage: StorageAdapter | undefined;
  private lockOptions: CheckpointLockOptions | undefined;
  private readonly ownerId = `cp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  constructor(
    dataDir: string,
    logger?: CheckpointLogger,
    storage?: StorageAdapter,
    lockOptions?: CheckpointLockOptions,
  ) {
    this.storage = storage;
    if (storage) {
      this.filePath = StoragePaths.checkpoint;
    } else {
      // Dynamic import path for fs-based mode is resolved in readRaw/writeRaw
      this.filePath = `${dataDir}/.metadata/recall_checkpoint.json`;
    }
    this.logger = logger ?? noopLogger;
    this.lockOptions = lockOptions;
  }

  // ============================
  // Low-level I/O (internal)
  // ============================

  private async readRaw(): Promise<Checkpoint> {
    try {
      let raw: string | null;
      if (this.storage) {
        raw = await this.storage.readFile(this.filePath);
      } else {
        const fs = await import("node:fs/promises");
        raw = await fs.default.readFile(this.filePath, "utf-8");
      }
      if (!raw) return structuredClone(DEFAULT_CHECKPOINT);

      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Merge with defaults for backward compat (old checkpoints lack new fields).
      // structuredClone avoids shallow-copy pitfall: without it, the nested
      // runner_states/pipeline_states objects in DEFAULT_CHECKPOINT would be
      // shared across all callers and mutated in place — corrupting the default.
      const cp = { ...structuredClone(DEFAULT_CHECKPOINT), ...parsed } as Checkpoint;

      // Migrate from old session_states format (pre-split)
      const oldStates = parsed.session_states as Record<string, Record<string, unknown>> | undefined;
      if (oldStates && !parsed.runner_states && !parsed.pipeline_states) {
        cp.runner_states = {};
        cp.pipeline_states = {};
        for (const [key, state] of Object.entries(oldStates)) {
          cp.runner_states[key] = {
            ...DEFAULT_RUNNER_STATE,
            last_captured_timestamp: (state.last_captured_timestamp as number) ?? 0,
            last_l1_cursor: (state.last_l1_cursor as number) ?? 0,
            last_scene_name: (state.last_scene_name as string) ?? "",
          };
          cp.pipeline_states[key] = {
            ...DEFAULT_PIPELINE_STATE,
            conversation_count: (state.conversation_count as number) ?? 0,
            last_extraction_time: (state.last_extraction_time as string) ?? "",
            last_extraction_updated_time: (state.last_extraction_updated_time as string) ?? "",
            last_active_time: (state.last_active_time as number) ?? 0,
            l2_pending_l1_count: (state.l2_pending_l1_count as number) ?? 0,
            l2_last_extraction_time: (state.l2_last_extraction_time as string) ?? "",
          };
        }
      } else {
        // Ensure per-session states have all fields with defaults
        if (cp.runner_states) {
          for (const [key, state] of Object.entries(cp.runner_states)) {
            cp.runner_states[key] = { ...DEFAULT_RUNNER_STATE, ...state };
          }
        }
        if (cp.pipeline_states) {
          for (const [key, state] of Object.entries(cp.pipeline_states)) {
            cp.pipeline_states[key] = { ...DEFAULT_PIPELINE_STATE, ...state };
          }
        }
      }
      return cp;
    } catch {
      return structuredClone(DEFAULT_CHECKPOINT);
    }
  }

  /** Atomic write: write to tmp file, then rename into place (fs mode). Storage mode: direct overwrite. */
  private async writeRaw(checkpoint: Checkpoint): Promise<void> {
    const content = JSON.stringify(checkpoint, null, 2);
    if (this.storage) {
      await this.storage.writeFile(this.filePath, content);
    } else {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const dir = path.default.dirname(this.filePath);
      await fs.default.mkdir(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp.${randomBytes(4).toString("hex")}`;
      await fs.default.writeFile(tmp, content, "utf-8");
      await fs.default.rename(tmp, this.filePath);
    }
  }

  // ============================
  // Locked read-modify-write helper
  // ============================

  /**
   * Execute a mutating operation under the per-file lock.
   * `fn` receives the current checkpoint and may modify it in place;
   * the updated checkpoint is atomically written back.
   */
  private async mutate(fn: (cp: Checkpoint) => void | Promise<void>): Promise<Checkpoint> {
    // In-process lock first: concurrency within same process is serialized directly to avoid meaningless distributed lock roundtrips.
    return withFileLock(this.filePath, () =>
      this.withDistributedLock(async () => {
        // Must read after holding distributed lock, otherwise still reads stale snapshot outside others' critical section.
        const cp = await this.readRaw();
        await fn(cp);
        await this.writeRaw(cp);
        return cp;
      }),
    );
  }

  /**
 * Serialize checkpoint read-modify-write across nodes.
   *
 * Background: in service mode, all agents/sessions of same instance share the same
 * checkpoint object ({pathPrefix}/{instanceId}/.metadata/checkpoint.json),
 * and writeRaw overrides entire object. L1 Redis lock is session-level, different sessions /
 * agents can concur across nodes, thus without extra mutual exclusion, late writer would overwrite
 * earlier writer's submitted runner_states using its stale snapshot, losing L1 cursors.
   *
 * Executes directly when no lock injected (standalone / single-process): withFileLock is sufficient here.
   */
  private async withDistributedLock<T>(fn: () => Promise<T>): Promise<T> {
    const opts = this.lockOptions;
    if (!opts) return fn();

    const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS;
    const maxWaitMs = opts.maxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS;
    const renewIntervalMs = opts.renewIntervalMs ?? Math.max(1_000, Math.floor(ttlMs / 3));
    const key = `checkpoint:${opts.lockKey}`;
    const startedAt = Date.now();
    const deadline = startedAt + maxWaitMs;

    let acquired = false;
    let delayMs = 20;
    while (Date.now() < deadline) {
      try {
        acquired = await opts.lock.acquireLock(key, this.ownerId, ttlMs);
      } catch (err) {
        // Lock backend fault: cannot guarantee mutual exclusion. **Do not write** at this time, delegate to upper layer to re-enqueue.
        // (Old implementation wrote lockless here, overwriting other nodes' runner_states.)
        opts.metrics?.onBackendError?.(key, err);
        throw new CheckpointLockUnavailableError(
          `checkpoint lock backend error for ${key}: ${err instanceof Error ? err.message : String(err)}`,
          key,
        );
      }
      if (acquired) break;
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 500);
    }

    if (!acquired) {
      const waitedMs = Date.now() - startedAt;
      opts.metrics?.onRequeueRequired?.(key, waitedMs);
      // Critical behavior change: no longer degrades to lockless write.
        // Lockless write would overwrite others' submitted data with stale snapshot (lose L1 cursor → permanent repeated extraction),
        // the cost is far higher than "abandon this time, re-run after re-enqueue".
      throw new CheckpointLockUnavailableError(
        `failed to acquire ${key} within ${waitedMs}ms; skipping write (caller should requeue)`,
        key,
      );
    }
    opts.metrics?.onAcquireWait?.(key, Date.now() - startedAt);

    // ── Renewal: prevent lock being snatched after critical section exceeds TTL causing silent dual-writes ──
    let lockLost = false;
    const renewTimer = setInterval(() => {
      void (async () => {
        try {
          const renewed = await opts.lock.renewLock(key, this.ownerId, ttlMs);
          if (!renewed) {
            lockLost = true;
            clearInterval(renewTimer);
            opts.metrics?.onLockLost?.(key);
            this.logger.warn?.(`[CHECKPOINT] lock ${key} renew rejected (lost ownership)`);
          }
        } catch (err) {
          lockLost = true;
          clearInterval(renewTimer);
          opts.metrics?.onLockLost?.(key);
          this.logger.warn?.(
            `[CHECKPOINT] lock ${key} renew threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    }, renewIntervalMs);
    // Do not let renewal timer prevent process exit
    (renewTimer as unknown as { unref?: () => void }).unref?.();

    try {
      const result = await fn();
      // Lock was lost during critical section execution → this write may interleave with others, cannot be treated as success.
      if (lockLost) {
        throw new CheckpointLockUnavailableError(
          `lock ${key} was lost during the critical section; write is not trustworthy`,
          key,
        );
      }
      return result;
    } finally {
      clearInterval(renewTimer);
      try {
        // Only release when still holding lock (releasing after losing lock would mistakenly delete new holder's lock — although backend has
          // owner validation fallback, explicit skip here is clearer).
        if (!lockLost) await opts.lock.releaseLock(key, this.ownerId);
      } catch {
        // Lock automatically expires with TTL, release failure does not need to interrupt main flow
      }
    }
  }

  // ============================
  // Public API — read-only
  // ============================

  /**
   * Read the current checkpoint (unlocked snapshot).
   *
   * NOTE: This does NOT acquire the file lock. The returned snapshot may be
   * stale if a concurrent `mutate()` is in progress. This is acceptable for
   * read-only uses (status display, deciding whether to run a pipeline step).
   *
   * For read-then-write patterns, always use `mutate()` instead — it acquires
   * the lock and re-reads from disk inside the critical section, ensuring the
   * update is based on the latest state.
   */
  async read(): Promise<Checkpoint> {
    return this.readRaw();
  }

  /** Write a full checkpoint (acquires lock + atomic write). */
  async write(checkpoint: Checkpoint): Promise<void> {
    return withFileLock(this.filePath, () => this.writeRaw(checkpoint));
  }

  // ============================
  // Public API — mutating (all serialized via file lock)
  // ============================

  // ============================
  // Persona methods (L3)
  // ============================

  async markPersonaGenerated(totalProcessed: number): Promise<void> {
    await this.mutate((cp) => {
      cp.last_persona_at = totalProcessed;
      cp.last_persona_time = new Date().toISOString();
      cp.memories_since_last_persona = 0;
      cp.request_persona_update = false;
      cp.persona_update_reason = "";
    });
  }

  async clearPersonaRequest(): Promise<void> {
    await this.mutate((cp) => {
      cp.request_persona_update = false;
      cp.persona_update_reason = "";
    });
  }

  async setPersonaUpdateRequest(reason: string): Promise<void> {
    await this.mutate((cp) => {
      cp.request_persona_update = true;
      cp.persona_update_reason = reason;
    });
  }

  async incrementScenesProcessed(): Promise<void> {
    const cp = await this.mutate((cp) => {
      cp.scenes_processed += 1;
    });
    this.logger.info(`[checkpoint] incrementScenesProcessed: scenes_processed=${cp.scenes_processed}`);
  }

  // ============================
  // Per-session helpers — runner state (L0/L1 owned)
  // ============================

  /**
   * Get or create runner session state for a session.
   */
  getRunnerState(cp: Checkpoint, sessionKey: string): RunnerSessionState {
    if (!cp.runner_states) {
      cp.runner_states = {};
    }
    let state = cp.runner_states[sessionKey];
    if (!state) {
      state = { ...DEFAULT_RUNNER_STATE };
      cp.runner_states[sessionKey] = state;
    }
    return state;
  }

  // ============================
  // Per-session helpers — pipeline state (PipelineManager owned)
  // ============================

  /**
   * Get or create pipeline session state for a session.
   */
  getPipelineState(cp: Checkpoint, sessionKey: string): PipelineSessionState {
    if (!cp.pipeline_states) {
      cp.pipeline_states = {};
    }
    let state = cp.pipeline_states[sessionKey];
    if (!state) {
      state = { ...DEFAULT_PIPELINE_STATE, last_active_time: Date.now() };
      cp.pipeline_states[sessionKey] = state;
    }
    return state;
  }

  /**
   * Get all pipeline states from checkpoint.
   */
  getAllPipelineStates(cp: Checkpoint): Record<string, PipelineSessionState> {
    return cp.pipeline_states ?? {};
  }

  /**
   * Merge pipeline session states into the checkpoint (used by pipeline persister).
   * Acquires the file lock so this is safe against concurrent mutations.
   *
   * This writes ONLY to `pipeline_states`, never touching `runner_states`.
   * This is the core guarantee that eliminates the split-brain overwrite bug.
   */
  async mergePipelineStates(states: Record<string, PipelineSessionState>): Promise<void> {
    await this.mutate((cp) => {
      if (!cp.pipeline_states) cp.pipeline_states = {};
      for (const [key, pState] of Object.entries(states)) {
        cp.pipeline_states[key] = {
          ...cp.pipeline_states[key],
          ...pState,
        };
      }
    });
  }

  // ============================
  // L1-specific methods
  // ============================

  /**
   * Mark L1 extraction completed: reset sinceL1 counter, advance L1 cursor,
   * and optionally save the last scene name for cross-batch continuity.
   *
   * @param cursorRecordedAtMs - The max recorded_at epoch ms of processed L0 messages.
   *   This becomes the new `last_l1_cursor` value (recorded_at semantics, not conversation timestamp).
   */
  async markL1ExtractionComplete(
    sessionKey: string,
    memoriesExtracted: number,
    cursorRecordedAtMs?: number,
    lastSceneName?: string,
  ): Promise<void> {
    let regressed = false;
    await this.mutate((cp) => {
      const state = this.getRunnerState(cp, sessionKey);
      if (cursorRecordedAtMs) {
      // P0-2: Monotonically increasing, never fallback.
        //
      // cursorRecordedAtMs is calculated by caller based on the **lockless snapshot** at createL1Runner start,
      // spanning entire L1 LLM extraction. If cursor for this session was advanced during this time
      // (re-submit, drain, concurrent nodes), direct assignment would dial cursor back → same batch of L0
      // repeatedly extracted, new data never queues up. Taking max before write is naturally idempotent.
        if (cursorRecordedAtMs > state.last_l1_cursor) {
          state.last_l1_cursor = cursorRecordedAtMs;
        } else if (cursorRecordedAtMs < state.last_l1_cursor) {
          regressed = true;
        }
      }
      if (lastSceneName !== undefined) {
        state.last_scene_name = lastSceneName;
      }
      cp.total_memories_extracted += memoriesExtracted;
      cp.memories_since_last_persona += memoriesExtracted;
    });
    if (regressed) {
      this.logger.warn?.(
        `[checkpoint] markL1ExtractionComplete session=${sessionKey}: ` +
        `stale cursor ${cursorRecordedAtMs} < persisted value, kept the newer one` +
        `(concurrent advance detected; no rollback)`,
      );
    }
    this.logger.info(
      `[checkpoint] markL1ExtractionComplete session=${sessionKey}: ` +
      `extracted=${memoriesExtracted}, cursor=${cursorRecordedAtMs ?? "(unchanged)"}, ` +
      `lastScene="${lastSceneName ?? "(unchanged)"}"`,
    );
  }

  /**
   * Monotonically repair global counters: only elevate to expected value when persistent value < expected value.
   *
   * Replaces write({...staleSnapshot}) previously in L2 runner —— which was a whole-object
   * overwrite unprotected by distributed locks, erasing concurrent runner_states writes from other nodes.
   *
   * This method re-reads within mutate critical section, writing only scalar fields listed in params, preserving others as-is.
   *
   * @returns Whether repair actually occurred (for upper layer deciding to alert)
   */
  async repairMonotonicCounters(expected: {
    scenes_processed?: number;
    total_processed?: number;
  }): Promise<boolean> {
    let repaired = false;
    await this.mutate((cp) => {
      if (expected.scenes_processed !== undefined && cp.scenes_processed < expected.scenes_processed) {
        cp.scenes_processed = expected.scenes_processed;
        repaired = true;
      }
      if (expected.total_processed !== undefined && cp.total_processed < expected.total_processed) {
        cp.total_processed = expected.total_processed;
        repaired = true;
      }
    });
    return repaired;
  }

  // ============================
  // Atomic capture (race-condition fix)
  // ============================

  /**
   * Atomically read the per-session cursor, execute the capture callback,
   * and advance the cursor — all within a single file-lock critical section.
   *
   * This eliminates the race window that existed when `read()` (unlocked) and
   * `advanceSessionCapturedTimestamp()` (locked) were separate calls:
   * two concurrent `agent_end` events could both read the same stale cursor
   * and record duplicate messages.
   *
   * ⚠️ Note: n is business callback (recordConversation → write L0), **must** stay within critical section,
   * otherwise atomicity of "read cursor → capture → advance cursor" is broken, concurrent agent_end will record repeatedly.
   * This makes this method's critical section significantly longer than other mutate calls; safety relies on withDistributedLock's
   * **renewal mechanism** (renewLock) holding lock continuously, instead of relying on TTL to cover worst duration.
   *
   * The callback receives `afterTimestamp` (the current per-session cursor)
   * and must return either:
   *   - `{ maxTimestamp, messageCount }` to advance the cursor, or
   *   - `null` to leave the cursor unchanged (nothing captured).
   *
   * L0 conversation count is also incremented inside the lock when messages
   * are captured, removing the need for a separate `incrementL0ConversationCount()` call.
   *
   * @param sessionKey   Per-session identifier
   * @param pluginStartTimestamp  Cold-start floor (used when no cursor exists yet)
   * @param fn  Async callback that performs the actual capture (recordConversation, etc.)
   */
  async captureAtomically(
    sessionKey: string,
    pluginStartTimestamp: number | undefined,
    fn: (afterTimestamp: number) => Promise<{ maxTimestamp: number; messageCount: number } | null>,
  ): Promise<void> {
    await this.mutate(async (cp) => {
      // Read the per-session cursor inside the lock
      const state = this.getRunnerState(cp, sessionKey);
      let afterTimestamp = state.last_captured_timestamp || 0;

      // Cold-start guard (same logic that was previously in auto-capture.ts)
      if (afterTimestamp === 0 && pluginStartTimestamp && pluginStartTimestamp > 0) {
        afterTimestamp = pluginStartTimestamp;
      }

      const result = await fn(afterTimestamp);

      if (result) {
        // Advance per-session cursor (runner-owned)
        state.last_captured_timestamp = result.maxTimestamp;
        // Global stats (aggregate only — not used for filtering)
        cp.last_captured_timestamp = Math.max(cp.last_captured_timestamp, result.maxTimestamp);
        cp.total_processed += result.messageCount;
        // Increment L0 conversation count (was a separate mutate() call before)
        cp.l0_conversations_count += 1;
      }
    });
  }

}
