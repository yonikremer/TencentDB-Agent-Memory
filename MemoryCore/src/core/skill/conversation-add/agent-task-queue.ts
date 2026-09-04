/**
 * SkillAgentTaskQueue — agent-level scheduling signals + `_tasks.json` short lock protection.
 *
 * Corresponds to design docs §5, §9.
 *
 * Abstract interface `ISkillAgentTaskQueue` defines three sets of capabilities:
 *   1) Agent queue (List + Set): enqueueAgent / dequeueAgent / requeueAgent / removeAgent
 *   2) tasks-mutex (protects `_tasks.json` read-modify-write, TTL in seconds): withTasksMutex
 *   3) extract-lock (Worker exclusive agent extraction right, TTL 10 min): acquire/renew/releaseExtractLock
 *
 * Production implementation uses Redis (`RedisSkillAgentTaskQueue`, this file).
 * Test implementation uses memory (`LocalSkillAgentTaskQueue`, this file).
 *
 * Agent tuple serialization format:
 *   `{space}|{user}|{team}|{agent}` — identical to Redis List elements and lock key suffixes.
 */

import { randomUUID } from "node:crypto";

// ── Common types ──────────────────────────────────────────────────────────

/**
 * Agent 5-tuple: (instance_id, space_id, user_id, team_id, agent_id).
 *
 * 2026-07-30: Expanded from 4 to 5 segments: added instance_id, allowing the worker
 * to route from the queue element itself to the corresponding instance's COS / VDB / LLM resources,
 * no longer relying on the historical coupling of "per-instance workers bound to resources".
 * See docs/design/2026-07-30-skill-worker-instance-decoupling.md for details.
 *
 * Compatibility:
 *   - parseAgentTuple receiving a 4-segment string → instance_id = "__legacy__",
 *     discarded and error-logged by upper-layer worker upon encountering __legacy__.
 *   - Each segment forbids containing `|` (aligns with ID_FORBIDDEN_CHAR in add-handler),
 *     serialize throws if detected.
 */
export interface AgentTuple {
  instance_id: string;
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
}

/** Fallback instance_id value when deserializing legacy 4-segment tuples. See AgentTuple comments. */
export const LEGACY_INSTANCE_ID = "__legacy__";

const TUPLE_FORBIDDEN_CHAR = "|";

function assertTupleField(name: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[skill-agent-queue] ${name} must be a non-empty string`);
  }
  if (value.includes(TUPLE_FORBIDDEN_CHAR)) {
    throw new Error(
      `[skill-agent-queue] ${name} cannot contain '${TUPLE_FORBIDDEN_CHAR}': got ${JSON.stringify(value)}`,
    );
  }
}

export function serializeAgentTuple(a: AgentTuple): string {
  assertTupleField("instance_id", a.instance_id);
  assertTupleField("space_id", a.space_id);
  assertTupleField("user_id", a.user_id);
  assertTupleField("team_id", a.team_id);
  assertTupleField("agent_id", a.agent_id);
  return `${a.instance_id}|${a.space_id}|${a.user_id}|${a.team_id}|${a.agent_id}`;
}

export function parseAgentTuple(raw: string): AgentTuple | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length === 5) {
    const [instance_id, space_id, user_id, team_id, agent_id] = parts;
    if (!instance_id || !space_id || !user_id || !team_id || !agent_id) return null;
    return { instance_id, space_id, user_id, team_id, agent_id };
  }
  if (parts.length === 4) {
    // Legacy 4-segment: during upgrade transition, there might be old format remnants in Redis. Treat as __legacy__,
    // upper-layer workers will discard and error log upon seeing it. Returning null here would treat it as
    // corrupted data, so we don't return null to let the upper layer clearly identify it as legacy.
    const [space_id, user_id, team_id, agent_id] = parts;
    if (!space_id || !user_id || !team_id || !agent_id) return null;
    return {
      instance_id: LEGACY_INSTANCE_ID,
      space_id,
      user_id,
      team_id,
      agent_id,
    };
  }
  return null;
}

export interface ExtractLockHandle {
  key: string;      // Serialized agent tuple string
  token: string;    // Release/renew credential
}

/**
 * peekAgent implementation strategy, reflecting underlying Redis capability levels (three-tier fallback):
 *
 *   - "lmove"                — Native LMOVE k k RIGHT LEFT (Redis 6.2+), server-side atomic
 *   - "evalsha"              — SCRIPT LOAD + EVALSHA (Redis 2.6+), lua single-thread atomic equivalent
 *   - "eval"                 — Always EVAL full script (intermediary state when evalsha fails but eval works; unused currently)
 *   - "rpop_lpush_downgrade" — Final fallback: RPOP only, caller (extract-worker) requeues manually inside tasks-mutex.
 *                              **Non-atomic**, has the millisecond window from v1 §4.5; when using this path,
 *                              selfHealScan periodic scanning MUST be enabled.
 *
 * Strategy is probed by `RedisSkillAgentTaskQueue.probePeekStrategy` on the first peekAgent call,
 * result is cached in the instance, branching directly thereafter. See docs/design/2026-07-21-skill-worker-crash-recovery.md §5.
 */
export type PeekStrategy = "lmove" | "evalsha" | "eval" | "rpop_lpush_downgrade";

export interface ISkillAgentTaskQueue {
  // ── Agent queue ──
  /**
   * Idempotent enqueue. If Set already contains it, skip LPUSH. Returns whether this was a "new enqueue" (true if newly added to Set).
   */
  enqueueAgent(tuple: AgentTuple): Promise<boolean>;
  /**
   * BRPOP-style dequeue. Blocks until element exists or times out; returns null on timeout.
   * Note: Dequeues only pop from the List; Set is not deleted (Worker decides whether to requeue or remove after processing).
   */
  dequeueAgent(blockMs: number): Promise<AgentTuple | null>;
  /**
   * At-least-once peek: after getting the agent, it remains in the List (atomic LMOVE semantics:
   * pop tail → push head). If worker crashes at any time, next peek/dequeue can grab it again,
   * fully closing the "taken but not fully processed" millisecond window inherited from v1 §4.5.
   *
   * Semantics:
   *   - blockMs=0    → Tries peek once and returns (List empty immediately null)
   *   - blockMs>0    → Polls every pollIntervalMs until grabbed or timeout, timeout null
   *   - When grabbed: agent's position in List = head (equivalent to RPOP + LPUSH), next peek can still grab same agent
   *
   * Three-tier fallback see `PeekStrategy`; when using rpop_lpush_downgrade, caller must manually requeue (atomicity lost).
   */
  peekAgent(blockMs: number): Promise<AgentTuple | null>;
  /**
   * Returns current underlying peek strategy. Used by extract-worker to determine if it's on degraded path (requiring explicit requeue).
   * If unprobed before calling, returns default value (usually "lmove", optimistic preset).
   */
  getPeekStrategy(): PeekStrategy;
  /**
   * Called when tasks are still non-empty after processing, pushes back to head (equivalent to rotating to tail of queue). Set preserved.
   */
  requeueAgent(tuple: AgentTuple): Promise<void>;
  /**
   * Takes the agent offline when tasks are empty: SREM Set; cleans up any remaining traces in List as well.
   */
  removeAgent(tuple: AgentTuple): Promise<void>;

  /**
   * Forcibly purges Set + List remnants by raw string (skips tuple serialize).
   *
   * 2026-08-03: under peek semantics, legacy 4-segment tuples are repeatedly moved to the head by LMOVE, causing
   * empty loops. This interface allows callers to clear them via SREM + LREM directly by raw string.
   * Also used in selfHealScan to clean up legacy 4-segment remnants.
   */
  purgeRawAgent(raw: string): Promise<void>;

  // ── Primitives required by selfHealScan (2026-08-03 crash-recovery PR-3) ──────────────
  /**
   * One-time snapshot of all raw strings in pending-agents-set for selfHealScan traversal.
   * Redis uses SMEMBERS, Local returns Array.from(set).
   */
  scanAgentSet(): Promise<string[]>;

  /**
   * Checks if List contains the specified raw. Redis uses LPOS (6.0.6+), Local iterates array.
   */
  listContains(raw: string): Promise<boolean>;

  /**
   * Directly LPUSH to List by raw string, skipping SADD (caller guarantees it exists in Set).
   * Used when selfHealScan patches List: SMEMBERS already got raw so it's in Set, just patch List.
   */
  enqueueRawAgent(raw: string): Promise<void>;

  // ── tasks-mutex (short lock protecting `_tasks.json` read-modify-write) ──
  /**
   * Contends for tasks-mutex to execute fn; on failure, **backs off and retries until waitDeadlineMs**, lock has lockTtlMs fallback to prevent deadlocks.
   *
   * Reasons for separating the two params (old implementation used the same value for deadline and ttl → 30 concurrent same-agent ops all timed out at 500):
   *   - `lockTtlMs`: the lock's own expiration time in Redis; used to automatically release if holding process crashes (a few seconds is enough).
   *   - `waitDeadlineMs`: max time caller is willing to block queuing; should be >> lockTtlMs,
   *     covering the cumulative critical section time needed for N concurrent queueers (e.g., 30 * 300ms critical sections = 9s,
   *     waitDeadline must be at least 15-30s to avoid false timeouts).
   */
  withTasksMutex<T>(
    tuple: AgentTuple,
    opts: { lockTtlMs: number; waitDeadlineMs: number },
    fn: () => Promise<T>,
  ): Promise<T>;

  // ── extract-lock (Worker exclusive agent extraction right) ──
  acquireExtractLock(tuple: AgentTuple, ttlMs: number): Promise<ExtractLockHandle | null>;
  renewExtractLock(handle: ExtractLockHandle, ttlMs: number): Promise<boolean>;
  releaseExtractLock(handle: ExtractLockHandle): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────
// Local (in-memory) implementation — for unit tests only
// ────────────────────────────────────────────────────────────────────────────

interface WaitingConsumer {
  resolve: (t: AgentTuple | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LocalSkillAgentTaskQueue implements ISkillAgentTaskQueue {
  private readonly list: string[] = [];      // head = LPUSH, tail = RPOP —— matches Redis semantics
  private readonly set = new Set<string>();
  private readonly tasksMutex = new Map<string, { token: string; expireAt: number }>();
  private readonly extractLocks = new Map<string, { token: string; expireAt: number }>();
  private readonly waiters: WaitingConsumer[] = [];

  private notify(): void {
    while (this.waiters.length > 0 && this.list.length > 0) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      const raw = this.list.pop()!; // RPOP
      const parsed = parseAgentTuple(raw);
      w.resolve(parsed);
    }
  }

  async enqueueAgent(tuple: AgentTuple): Promise<boolean> {
    const key = serializeAgentTuple(tuple);
    const added = !this.set.has(key);
    if (added) {
      this.set.add(key);
      this.list.unshift(key); // LPUSH
    }
    this.notify();
    return added;
  }

  async dequeueAgent(blockMs: number): Promise<AgentTuple | null> {
    if (this.list.length > 0) {
      const raw = this.list.pop()!; // RPOP
      return parseAgentTuple(raw);
    }
    if (blockMs <= 0) return null;
    return new Promise<AgentTuple | null>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, blockMs);
      this.waiters.push({ resolve, timer });
    });
  }

  /**
   * at-least-once peek: memory version = single-process Node, pop + unshift naturally atomic.
   * Semantics match Redis 6.2+ LMOVE k k RIGHT LEFT.
   */
  async peekAgent(blockMs: number): Promise<AgentTuple | null> {
    const deadline = Date.now() + Math.max(0, blockMs);
    while (true) {
      if (this.list.length > 0) {
        const raw = this.list.pop()!;    // RPOP
        this.list.unshift(raw);          // LPUSH
        return parseAgentTuple(raw);
      }
      if (blockMs === 0) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      // No blocking wakeups like Redis in Node memory implementation, polling 20ms is fine
      await sleep(Math.min(20, remaining));
    }
  }

  getPeekStrategy(): PeekStrategy {
    return "lmove"; // Semantically equivalent, single-process memory atomic
  }

  async requeueAgent(tuple: AgentTuple): Promise<void> {
    const key = serializeAgentTuple(tuple);
    // Push back to head (LPUSH semantics); Set preserved
    this.set.add(key);
    this.list.unshift(key);
    this.notify();
  }

  async removeAgent(tuple: AgentTuple): Promise<void> {
    const key = serializeAgentTuple(tuple);
    this.set.delete(key);
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i] === key) this.list.splice(i, 1);
    }
  }

  async purgeRawAgent(raw: string): Promise<void> {
    this.set.delete(raw);
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i] === raw) this.list.splice(i, 1);
    }
  }

  async scanAgentSet(): Promise<string[]> {
    return Array.from(this.set);
  }

  async listContains(raw: string): Promise<boolean> {
    return this.list.includes(raw);
  }

  async enqueueRawAgent(raw: string): Promise<void> {
    this.list.unshift(raw);
    this.notify();
  }

  // ── mutex ──

  async withTasksMutex<T>(
    tuple: AgentTuple,
    opts: { lockTtlMs: number; waitDeadlineMs: number },
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = `mutex:${serializeAgentTuple(tuple)}`;
    const deadline = Date.now() + opts.waitDeadlineMs;
    while (true) {
      const now = Date.now();
      const cur = this.tasksMutex.get(key);
      if (!cur || cur.expireAt <= now) {
        const token = randomUUID();
        this.tasksMutex.set(key, { token, expireAt: now + opts.lockTtlMs });
        try {
          return await fn();
        } finally {
          const held = this.tasksMutex.get(key);
          if (held && held.token === token) this.tasksMutex.delete(key);
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`[skill-agent-queue] tasks-mutex wait timeout for ${key}`);
      }
      await sleep(10);
    }
  }

  // ── extract lock ──

  async acquireExtractLock(tuple: AgentTuple, ttlMs: number): Promise<ExtractLockHandle | null> {
    const key = serializeAgentTuple(tuple);
    const now = Date.now();
    const cur = this.extractLocks.get(key);
    if (cur && cur.expireAt > now) return null;
    const token = randomUUID();
    this.extractLocks.set(key, { token, expireAt: now + ttlMs });
    return { key, token };
  }

  async renewExtractLock(handle: ExtractLockHandle, ttlMs: number): Promise<boolean> {
    const cur = this.extractLocks.get(handle.key);
    if (!cur || cur.token !== handle.token) return false;
    cur.expireAt = Date.now() + ttlMs;
    return true;
  }

  async releaseExtractLock(handle: ExtractLockHandle): Promise<void> {
    const cur = this.extractLocks.get(handle.key);
    if (!cur) return;
    if (cur.token !== handle.token) return;
    this.extractLocks.delete(handle.key);
  }

  // ── test helpers ──

  /** For tests: peek current state. */
  _snapshot(): { list: string[]; set: string[] } {
    return { list: [...this.list], set: [...this.set] };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ────────────────────────────────────────────────────────────────────────────
// Redis implementation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Minimal ioredis client subset, avoids directly importing Redis types (maintains consistency with existing redis-queue-v2).
 *
 * 2026-08-03: `lmove` / `evalsha` / `script` methods are used by peekAgent as three-tier fallbacks.
 * All three are optional — they might be absent on old/degraded Redis (LMOVE < 6.2), forbidden (cluster policy restricts EVAL),
 * or omitted by the client library. If missing, peekAgent automatically degrades to the next fallback level in sequence.
 */
export interface RedisLike {
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  lpush(key: string, ...values: string[]): Promise<number>;
  lrem(key: string, count: number, value: string): Promise<number>;
  brpop(key: string, timeoutSec: number): Promise<[string, string] | null>;
  rpop(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  pexpire(key: string, ms: number): Promise<number>;
  // ── Optional (called on-demand during probe, if missing → drop to next fallback) ──
  lmove?(src: string, dst: string, srcSide: string, dstSide: string): Promise<string | null>;
  evalsha?(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  script?(subcommand: string, ...args: string[]): Promise<string>;
  /**
   * LPOS queries raw's position in List (Redis 6.0.6+); null = absent. Falls back to
   * `LRANGE + JS traversal` if missing, see RedisSkillAgentTaskQueue.listContains implementation.
   */
  lpos?(key: string, value: string): Promise<number | null>;
  /** LRANGE serves as a fallback when lpos is unavailable. */
  lrange?(key: string, start: number, stop: number): Promise<string[]>;
}

export interface RedisSkillAgentTaskQueueOptions {
  client: RedisLike;
  /** Redis key prefix, defaults to "skill". */
  keyPrefix?: string;
  /**
   * dequeueAgent polling interval ms, defaults to 200.
   *
   * 2026-07-21 — Historically dequeueAgent used `BRPOP <key> 5`. Zero-latency wakeups were
   * achieved, but BRPOP is a **blocking command**, so other skill commands sharing the same ioredis
   * connection (`SET NX PX` contending for tasks-mutex, `SADD`/`LPUSH` enqueueAgent, `EVAL` releasing
   * locks) all had to queue behind BRPOP. Handlers archiving 3 times would hit the BRPOP window
   * taking ≈ 15s. Changed to non-blocking `RPOP` + `setTimeout(pollIntervalMs)` polling, freeing up the
   * main connection, restoring handler-side Redis IO to millisecond levels; trade-off is at most pollInterval
   * wakeup latency (default 200ms, skill extraction itself LLM takes 10+ seconds, this delay is unnoticeable).
   *
   * Semantics align with memory-side `RedisStateBackend.consumeTask`
   * (redis-backend.ts:312 — XREADGROUP without BLOCK, outer sleep 200ms).
   */
  pollIntervalMs?: number;
}

/**
 * Default Redis key prefix.
 *
 * Production recommendation: pass a prefix like `${memoryPrefix}:skill-conv` at the wire layer, linking it to memory's
 * `keyPrefix` (e.g., `tdai_memory_prod_v3`), avoiding collisions across different environment Redis instances.
 * Default `"skill-conv"` is only a fallback when not explicitly provided.
 */
const DEFAULT_PREFIX = "skill-conv";

const LUA_RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const LUA_RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * peek lua: atomic "RPOP tail + LPUSH head", semantics identical to LMOVE k k RIGHT LEFT.
 * Used only when falling back to EVALSHA/EVAL on Redis < 6.2.
 *
 * KEYS[1] = pending-agents list
 * return  = raw string retrieved or nil
 */
const LUA_PEEK = `
local raw = redis.call('RPOP', KEYS[1])
if raw then
  redis.call('LPUSH', KEYS[1], raw)
end
return raw
`;

/**
 * Checks if a Redis error message indicates "command unsupported" (LMOVE in Redis < 6.2 or some mocks).
 * Semantic boundary: only matches "command unrecognized / disabled" category; other errors (disconnected, auth failed)
 * must bubble up to the caller to avoid misjudged degradation to non-atomic paths.
 */
function isUnknownCommand(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return /ERR\s+unknown command/i.test(msg) || /command\s+.*\s+is not allowed/i.test(msg);
}

/**
 * Checks if EVALSHA returned NOSCRIPT (Redis restarted / script cache cleared). When NOSCRIPT is received,
 * it should SCRIPT LOAD then EVALSHA again, rather than degrading as a failure.
 */
function isNoScript(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return /NOSCRIPT/i.test(msg);
}

/**
 * Checks if EVAL / SCRIPT is rejected by cluster policy (permission / cluster disabled). This category is
 * also "capability unsupported" like unknown-command, needing fallback to the next tier.
 */
function isEvalDisabled(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return (
    /command\s+'?EVAL'?\s+is not allowed/i.test(msg) ||
    /NOPERM/i.test(msg) ||
    /ERR\s+unknown command\s+'?(EVAL|EVALSHA|SCRIPT)/i.test(msg)
  );
}

export class RedisSkillAgentTaskQueue implements ISkillAgentTaskQueue {
  private readonly client: RedisLike;
  private readonly listKey: string;
  private readonly setKey: string;
  private readonly extractLockPrefix: string;
  private readonly tasksMutexPrefix: string;
  private readonly pollIntervalMs: number;

  constructor(opts: RedisSkillAgentTaskQueueOptions) {
    this.client = opts.client;
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
    const prefix = opts.keyPrefix ?? DEFAULT_PREFIX;
    // Key layout (aligns with §5 & §21.5):
    //   {prefix}:pending-agents         — List (LPUSH enqueue / RPOP poll dequeue)
    //   {prefix}:pending-agents-set     — Set (SADD/SREM idempotent deduplication)
    //   {prefix}:extract-lock:{tuple}   — Worker exclusive agent extraction right (10min TTL)
    //   {prefix}:tasks-mutex:{tuple}    — Protects _tasks.json read-modify-write (5s TTL)
    this.listKey = `${prefix}:pending-agents`;
    this.setKey = `${prefix}:pending-agents-set`;
    this.extractLockPrefix = `${prefix}:extract-lock:`;
    this.tasksMutexPrefix = `${prefix}:tasks-mutex:`;
  }

  async enqueueAgent(tuple: AgentTuple): Promise<boolean> {
    const raw = serializeAgentTuple(tuple);
    const added = await this.client.sadd(this.setKey, raw);
    if (added === 1) {
      await this.client.lpush(this.listKey, raw);
      return true;
    }
    return false;
  }

  async dequeueAgent(blockMs: number): Promise<AgentTuple | null> {
    // Non-blocking RPOP + sleep polling, rejects BRPOP. See comments at pollIntervalMs.
    //
    // blockMs=0 —— tries only once, returns null immediately if list is empty.
    // blockMs>0 —— tries every pollIntervalMs until element grabbed or deadline crossed.
    const deadline = Date.now() + Math.max(0, blockMs);
    while (true) {
      const raw = await this.client.rpop(this.listKey);
      if (raw !== null) return parseAgentTuple(raw);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      // take the min of pollInterval and remaining, ensuring it returns promptly when blockMs < pollInterval.
      await sleep(Math.min(this.pollIntervalMs, remaining));
    }
  }

  /**
   * At-least-once peek — details in ISkillAgentTaskQueue.peekAgent doc + docs/design/2026-07-21 §5.
   *
   * Mainline uses Redis 6.2+ `LMOVE k k RIGHT LEFT`; Old Redis uses EVALSHA via LUA_PEEK script;
   * Falls back to non-atomic RPOP when EVAL is forbidden (caller responsible for requeueing in mutex).
   *
   * Probing: determines strategy via `probePeekStrategy` on first call and caches it (idempotent, concurrency-safe).
   */
  async peekAgent(blockMs: number): Promise<AgentTuple | null> {
    if (!this.peekProbed) await this.probePeekStrategy();
    const deadline = Date.now() + Math.max(0, blockMs);
    while (true) {
      const raw = await this.executePeek();
      if (raw !== null) return parseAgentTuple(raw);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await sleep(Math.min(this.pollIntervalMs, remaining));
    }
  }

  getPeekStrategy(): PeekStrategy {
    return this.peekStrategy;
  }

  // ── peek three-tier fallback probe ─────────────────────────────────────────────────
  //
  // First peekAgent call triggers a probe once, caches result in peekStrategy, branches directly thereafter.
  // Probing itself might grab an element (null/no-op on empty list; on non-empty list, element remains in List after LMOVE, semantics intact).
  //
  // Concurrency safety: `probePromise` guarantees first concurrent calls only probe once, other callers wait for the result.
  // If probing throws an error (not "capability unsupported"), it won't cache, retries probing next time.

  private peekStrategy: PeekStrategy = "lmove";     // Optimistic default
  private peekScriptSha: string | null = null;
  private peekProbed = false;
  private probePromise: Promise<void> | null = null;

  private async probePeekStrategy(): Promise<void> {
    if (this.peekProbed) return;
    if (this.probePromise) {
      await this.probePromise;
      return;
    }
    this.probePromise = (async () => {
      // Level 1: Probe LMOVE. Try once on the real listKey — getting null also counts as success
      // (as long as unknown-command is not thrown). On non-empty lists, grabbed element remains in List, semantics correct.
      try {
        if (typeof this.client.lmove === "function") {
          await this.client.lmove(this.listKey, this.listKey, "RIGHT", "LEFT");
          this.peekStrategy = "lmove";
          this.peekProbed = true;
          return;
        }
      } catch (err) {
        if (!isUnknownCommand(err)) throw err; // Non-capability issues bubble up
      }

      // Level 2: Probe EVALSHA + SCRIPT LOAD.
      if (typeof this.client.script === "function" && typeof this.client.evalsha === "function") {
        try {
          this.peekScriptSha = await this.client.script("LOAD", LUA_PEEK);
          // Immediately verify it runs with EVALSHA (returning null on empty list is OK)
          await this.client.evalsha(this.peekScriptSha, 1, this.listKey);
          this.peekStrategy = "evalsha";
          this.peekProbed = true;
          return;
        } catch (err) {
          if (!isEvalDisabled(err) && !isUnknownCommand(err)) throw err;
        }
      }

      // Level 3: Final fallback — non-atomic RPOP.
      // Triggers P1 alert; caller (extract-worker) must use getPeekStrategy to detect this path
      // and do explicit requeue inside tasks-mutex (v1 §4.5 original plan), and pool must enable
      // periodic selfHealScan (delivered in PR-3).
      this.peekStrategy = "rpop_lpush_downgrade";
      this.peekProbed = true;
    })().finally(() => {
      this.probePromise = null;
    });
    await this.probePromise;
  }

  private async executePeek(): Promise<string | null> {
    switch (this.peekStrategy) {
      case "lmove":
        // After successful probe, unknown-command won't hit; no fallback drop here (let errors bubble),
        // preventing silent degradation from midway Redis version switches.
        return this.client.lmove!(this.listKey, this.listKey, "RIGHT", "LEFT");

      case "evalsha":
        try {
          return (await this.client.evalsha!(this.peekScriptSha!, 1, this.listKey)) as
            | string
            | null;
        } catch (err) {
          if (isNoScript(err)) {
            // Redis restart lost script cache: re-LOAD then EVALSHA once more.
            // Retries only once; if NOSCRIPT persists, bubbles up (indicates client/server anomaly, shouldn't silently degrade).
            this.peekScriptSha = await this.client.script!("LOAD", LUA_PEEK);
            return (await this.client.evalsha!(this.peekScriptSha, 1, this.listKey)) as
              | string
              | null;
          }
          throw err;
        }

      case "eval":
        return (await this.client.eval(LUA_PEEK, 1, this.listKey)) as string | null;

      case "rpop_lpush_downgrade": {
        // Non-atomic: RPOP only, caller requeues manually inside mutex. Semantics identical to dequeueAgent popping once.
        return this.client.rpop(this.listKey);
      }
    }
  }

  async requeueAgent(tuple: AgentTuple): Promise<void> {
    const raw = serializeAgentTuple(tuple);
    // Idempotent: ensures it's also in Set
    await this.client.sadd(this.setKey, raw);
    await this.client.lpush(this.listKey, raw);
  }

  async removeAgent(tuple: AgentTuple): Promise<void> {
    const raw = serializeAgentTuple(tuple);
    await this.client.srem(this.setKey, raw);
    // Remnants might still be in List (Worker already popped, so it's gone; this is a fallback)
    await this.client.lrem(this.listKey, 0, raw);
  }

  async purgeRawAgent(raw: string): Promise<void> {
    // Purge Set + List directly by raw string, skipping tuple serialize. Used for legacy 4-segment cleanup
    // + fallback for corrupt residuals in selfHealScan.
    await this.client.srem(this.setKey, raw);
    await this.client.lrem(this.listKey, 0, raw);
  }

  async scanAgentSet(): Promise<string[]> {
    return this.client.smembers(this.setKey);
  }

  async listContains(raw: string): Promise<boolean> {
    if (typeof this.client.lpos === "function") {
      const pos = await this.client.lpos(this.listKey, raw);
      return pos !== null && pos >= 0;
    }
    if (typeof this.client.lrange === "function") {
      // Fallback: LRANGE to get all and traverse. At scale, List length = active agents, typically <= thousands, acceptable.
      const all = await this.client.lrange(this.listKey, 0, -1);
      return all.includes(raw);
    }
    // Both missing → conservatively assume List has it (skipping one LPUSH is better than falsely repeating LPUSH; next
    // selfHealScan round will retry anyway).
    return true;
  }

  async enqueueRawAgent(raw: string): Promise<void> {
    // Set already has it (caller guarantees), only need to patch List.
    await this.client.lpush(this.listKey, raw);
  }

  async withTasksMutex<T>(
    tuple: AgentTuple,
    opts: { lockTtlMs: number; waitDeadlineMs: number },
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = this.tasksMutexPrefix + serializeAgentTuple(tuple);
    const token = randomUUID();
    const deadline = Date.now() + opts.waitDeadlineMs;
    while (true) {
      // SET NX PX: short TTL fallback for crash scenarios; waitDeadline covers concurrent queuing time
      const ok = await this.client.set(key, token, "NX", "PX", opts.lockTtlMs);
      if (ok === "OK") {
        try {
          return await fn();
        } finally {
          try {
            await this.client.eval(LUA_RELEASE, 1, key, token);
          } catch {
            /* swallow */
          }
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`[skill-agent-queue] tasks-mutex wait timeout for ${key}`);
      }
      await sleep(20 + Math.floor(Math.random() * 30));
    }
  }

  async acquireExtractLock(tuple: AgentTuple, ttlMs: number): Promise<ExtractLockHandle | null> {
    const key = this.extractLockPrefix + serializeAgentTuple(tuple);
    const token = randomUUID();
    const ok = await this.client.set(key, token, "NX", "PX", ttlMs);
    if (ok !== "OK") return null;
    return { key, token };
  }

  async renewExtractLock(handle: ExtractLockHandle, ttlMs: number): Promise<boolean> {
    const raw = handle.key.startsWith(this.extractLockPrefix)
      ? handle.key
      : this.extractLockPrefix + handle.key;
    const result = await this.client.eval(LUA_RENEW, 1, raw, handle.token, ttlMs);
    return result === 1;
  }

  async releaseExtractLock(handle: ExtractLockHandle): Promise<void> {
    const raw = handle.key.startsWith(this.extractLockPrefix)
      ? handle.key
      : this.extractLockPrefix + handle.key;
    try {
      await this.client.eval(LUA_RELEASE, 1, raw, handle.token);
    } catch {
      /* swallow */
    }
  }
}
