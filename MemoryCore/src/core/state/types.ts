/**
 * IStateBackend — Pipeline State Backend Abstraction Layer
 *
 * Architecture doc §5.1 / Requirement #7.1
 *
 * Core/Worker/Timer Scanner programs against this interface; backend is switched via config:
 * - LocalStateBackend  (single-machine, zero external dependencies)
 * - RemoteStateBackend (service-mode deployment)
 *
 * Interface extracted from the existing MemoryPipelineManager:
 * - Buffer    ← messageBuffers (Map<string, CapturedMessage[]>)
 * - State     ← sessionStates  (Map<string, PipelineSessionState>)
 * - Timer     ← ManagedTimer (l1Idle, l2Schedule)
 * - Queue     ← SerialQueue (l1Queue, l2Queue, l3Queue)
 * - Lock      ← l3Running / l3Pending mutex
 * - Capture   ← notifyConversation atomic count+threshold+enqueue operation
 */

// ============================
// Pipeline Session State
// ============================

/** Reuses the PipelineSessionState fields from the existing checkpoint.ts */
export interface PipelineSessionState {
  conversation_count: number;
  last_extraction_time: string;
  last_extraction_updated_time: string;
  last_active_time: number;
  l2_pending_l1_count: number;
  warmup_threshold: number;
  l2_last_extraction_time: string;
}

export const DEFAULT_PIPELINE_STATE: PipelineSessionState = {
  conversation_count: 0,
  last_extraction_time: "",
  last_extraction_updated_time: "",
  last_active_time: 0,
  l2_pending_l1_count: 0,
  warmup_threshold: 0,
  l2_last_extraction_time: "",
};

// ============================
// Timer
// ============================

export interface TimerEntry {
  /** Present for local timers so expiry callbacks preserve Instance routing. */
  instanceId?: string;
  member: string;
  fireAtMs: number;
}

// ============================
// Task Queue
// ============================

export interface TaskPayload {
  id: string;
  type: "L1" | "L2" | "L3" | "flush" | "offload-l1" | "offload-l15" | "offload-l2";
  instanceId: string;
  sessionId: string;
  /**
   * Tenant identity (optional). The v2 pipeline uses (teamId, agentId) to determine lock
   * granularity and Redis hash tags, avoiding single-instance large-key hotspots.
   * The offload subsystem does not depend on this.
   * When absent, locks/keys fall back to instance-level (compatible with older callers).
   */
  teamId?: string;
  agentId?: string;
  priority: number; // 0=high, 1=normal, 2=low
  data?: Record<string, unknown>;
  createdAt: number;
}

// ============================
// Capture Atomic
// ============================

export interface CaptureAtomicParams {
  instanceId: string;
  sessionId: string;
  /** Same as TaskPayload.teamId / agentId — determines the hash slot for buffer + state. */
  teamId?: string;
  agentId?: string;
  /** Optional message payload for callers that still use StateBackend buffering. */
  messageJson?: string;
  threshold: number;
  fireAtMs: number;
  timerMember: string;
  taskPayload: TaskPayload;
  nowMs: number;
  /** Number of conversation rounds added in this call (each role=user message counts as one round). Default 1. */
  rounds: number;
}

export interface CaptureAtomicResult {
  triggered: boolean;
  conversationCount: number;
}

// ============================
// IStateBackend
// ============================

export interface IStateBackend {
  // ═══ Buffer ═══
  // teamId/agentId are optional; when absent, the Redis backend hash tag falls back to {p:inst} (legacy layout).
  // Recommended: v2 pipeline callers should always pass these to avoid concentrating a single instance into one hash slot (hot key).
  appendBuffer(instanceId: string, sessionId: string, message: string, teamId?: string, agentId?: string): Promise<void>;
  drainBuffer(instanceId: string, sessionId: string, teamId?: string, agentId?: string): Promise<string[]>;
  getBufferLength(instanceId: string, sessionId: string, teamId?: string, agentId?: string): Promise<number>;

  // ═══ Session State ═══
  getSessionState(instanceId: string, sessionId: string, teamId?: string, agentId?: string): Promise<PipelineSessionState | null>;
  updateSessionState(instanceId: string, sessionId: string, patch: Partial<PipelineSessionState>, teamId?: string, agentId?: string): Promise<void>;
  deleteSessionState(instanceId: string, sessionId: string, teamId?: string, agentId?: string): Promise<void>;
  /**
   * List all active sessions under an instance (used by standalone-mode persister to replay checkpoints).
   * In cluster mode, hash tags scatter across nodes so this method only covers a single node;
   * service-mode persisters do not set this so it will not be called — exists only for standalone compatibility.
   */
  listActiveSessions(instanceId: string): Promise<string[]>;

  // ═══ Timer ═══
  setTimer(instanceId: string, member: string, fireAtMs: number): Promise<void>;
  setTimerIfEarlier(instanceId: string, member: string, fireAtMs: number): Promise<boolean>;
  removeTimer(instanceId: string, member: string): Promise<void>;
  getExpiredTimers(instanceId: string, nowMs: number): Promise<TimerEntry[]>;

  // ═══ Task Queue ═══
  enqueueTask(task: TaskPayload): Promise<void>;
  consumeTask(workerId: string, blockMs?: number): Promise<TaskPayload | null>;
  ackTask(taskId: string): Promise<void>;
  getQueueDepth(): Promise<{ high: number; low: number }>;
  /**
   * Snapshot of all tasks currently waiting in the queue (not yet consumed).
   * Used by `/v2/pipeline/status` to compute per-L-type queue stats with full
   * type/sessionId/instanceId info (queue is single-shared, but task.type
   * distinguishes L1/L2/L3 — see TaskPayload).
   *
   * Optional because remote queue implementations may opt out of expensive
   * full queue scans. Local backend (standalone) MUST implement.
   */
  listQueuedTasks?(): Promise<TaskPayload[]>;
  /** Claim pending messages that timed out without ACK (XPENDING + XCLAIM) */
  claimStaleTasks?(workerId: string, minIdleMs: number, count: number): Promise<TaskPayload[]>;

  // ═══ Lock ═══
  acquireLock(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
  renewLock(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string, ownerId: string): Promise<void>;

  // ═══ Atomic Capture ═══
  captureAtomic(params: CaptureAtomicParams): Promise<CaptureAtomicResult>;

  // ═══ Instance Lifecycle ═══
  /**
   * Purge all state associated with an instance: buffers, sessions, timers.
   * Called when an instance is destroyed.
   * @returns Counts of cleaned resources.
   */
  purgeInstance?(instanceId: string): Promise<{ sessions: number; timers: number; buffers: number }>;

  // ═══ Lifecycle ═══
  initialize?(): Promise<void>;
  destroy?(): Promise<void>;
}
