/**
 * SkillBufferStorage — encapsulates all COS object reads/writes described in §4.
 *
 * Path rules (mounted under the global memory PathPrefix, subPath defaults to "skill_buffer"):
 *   Session level:
 *     {subPath}/{space}/{user}/{team}/{agent}/{session}/data-current.jsonl
 *     {subPath}/{space}/{user}/{team}/{agent}/{session}/data-<ts>.jsonl
 *     {subPath}/{space}/{user}/{team}/{agent}/{session}/meta.json
 *   Agent level:
 *     {subPath}/{space}/{user}/{team}/{agent}/_tasks.json
 *
 * Reuses the existing memory StorageAdapter (Local or COS).
 *
 * Read/write rules:
 *   - data-current: plain JSON (no append semantics; each write is a full overwrite)
 *   - meta:         plain JSON (session is serial, no CAS)
 *   - archive:      plain JSON (exists() check before write; already existing is treated as success)
 *   - _tasks.json:  plain JSON (read-modify-write, protected by a short Redis lock in upper-layer SkillAgentTaskQueue)
 */

import type { StorageAdapter } from "../../storage/adapter.js";

export interface SessionKey {
  /**
   * 2026-07-30: Added instance_id so that when trigger.archive constructs an AgentTuple
   * and pushes it to the queue, the worker can dynamically resolve the corresponding
   * instance's COS / VDB / LLM resources after dequeuing, without relying on the
   * historical coupling of "per-instance workers bound to resources".
   * The buffer-storage internals (sessionDir/agentDir/tasksKey) do not use instance_id
   * (that part is provided by CosStorageBackend's per-instance prefix); it is only
   * carried as tuple ownership info.
   */
  instance_id: string;
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  session_id: string;
}

// AgentTuple 5-segment type is single-sourced from agent-task-queue; re-exported here
// so old import paths continue to work.
// buffer-storage's agentDir/tasksKey only uses user/team/agent (instance/space is provided
// by the upper-layer StorageAdapter's per-instance prefix), but types stay consistent for cross-module passing.
export type { AgentTuple } from "./agent-task-queue.js";
import type { AgentTuple } from "./agent-task-queue.js";

/** meta.json structure (§4.2). Only holds counters. */
export interface SessionMeta {
  session_id: string;
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  tool_call_count: number;
  byte_count: number;
  last_appended_at_ms?: number;
  last_archived_at_ms?: number;
}

/** _tasks.json single task entry (§4.3). */
export interface SkillTaskEntry {
  task_id: string;
  session_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  space_id: string;
  task_ref_id?: string;
  archive_key: string;
  archived_at_ms: number;
  enqueued_at_ms: number;
  /**
   * Exclusive to direct-trigger (`/v3/skill/extract`): the extraction prompt for the main Agent,
   * stored in SkillTaskEntry.reason, passed through to extractor.extract when the Worker consumes it.
   * Not set on the conversation/add path.
   */
  reason?: string;
  /**
   * Exclusive to direct-trigger: extractor LLM iteration limit. Not set on the conversation/add path.
   * Passed through as `extractor.extract({ options: { max_iterations } })` when the Worker consumes it.
   */
  max_iterations?: number;
  /**
   * Cumulative **permanent** failure count (type B: 400/422/JSON parse/schema errors).
   * Type A transient errors (401/403/429/5xx/network/timeout) are not counted, to avoid
   * conflating them with type B errors.
   * When this reaches the Worker's `permanentMaxRetries` threshold (default 3), the task
   * is moved to `_tasks_dlq.json` (see dlqKey below).
   */
  retry_count?: number;
  /**
   * Error message from the most recent failure (truncated to <=1024 chars by the Worker),
   * for debugging only; has no effect on Worker scheduling logic.
   */
  last_error?: string;
}

/** Overall structure of `_tasks.json`. */
export interface AgentTasksDoc {
  team_id: string;
  agent_id: string;
  updated_at_ms: number;
  tasks: SkillTaskEntry[];
}

/**
 * `_tasks_dlq.json` single dead-letter entry.
 *
 * DLQ is persisted only — not served as an endpoint: recover manually with `cat` / `mv`,
 * or have a Grafana alert script scan the file directly. No TTL or size limit for now
 * (one file per agent; users handle large files themselves).
 */
export interface SkillDeadTaskEntry extends SkillTaskEntry {
  /** Wall-clock timestamp when the entry was appended to the DLQ. */
  dead_lettered_at_ms: number;
}

/** Overall structure of `_tasks_dlq.json`. */
export interface AgentDeadTasksDoc {
  team_id: string;
  agent_id: string;
  updated_at_ms: number;
  tasks: SkillDeadTaskEntry[];
}

/** data-current / archive buffer content. Uses { messages: [...] } instead of raw JSONL, simplifying read/write. */
export interface BufferedMessages {
  messages: Array<Record<string, unknown>>;
}

export interface SkillBufferStorageOptions {
  storage: StorageAdapter;
  /** COS sub-path prefix. Default: "skill_buffer". */
  subPath?: string;
}

const DEFAULT_SUB_PATH = "skill_buffer";

export class SkillBufferStorage {
  private readonly storage: StorageAdapter;
  private readonly subPath: string;

  constructor(opts: SkillBufferStorageOptions) {
    this.storage = opts.storage;
    this.subPath = (opts.subPath ?? DEFAULT_SUB_PATH).replace(/\/+$/, "");
  }

  // ── Path helpers ──────────────────────────────────────────────────────────

  // Path rules align with design doc §15.3: SkillBufferStorage only handles levels below subPath
  // ({user}/{team}/{agent}/...), space_id/instanceId is provided by the upper-layer StorageAdapter's
  // per-instance prefix. Including space_id would cause it to appear again under CosStorageBackend's
  // prefix (`.../{instanceId}/`).
  private sessionDir(sess: SessionKey): string {
    return `${this.subPath}/${sess.user_id}/${sess.team_id}/${sess.agent_id}/${sess.session_id}`;
  }

  private agentDir(agent: AgentTuple): string {
    return `${this.subPath}/${agent.user_id}/${agent.team_id}/${agent.agent_id}`;
  }

  currentKey(sess: SessionKey): string {
    return `${this.sessionDir(sess)}/data-current.jsonl`;
  }

  metaKey(sess: SessionKey): string {
    return `${this.sessionDir(sess)}/meta.json`;
  }

  archiveKey(sess: SessionKey, archivedAtMs: number): string {
    return `${this.sessionDir(sess)}/data-${archivedAtMs}.jsonl`;
  }

  tasksKey(agent: AgentTuple): string {
    return `${this.agentDir(agent)}/_tasks.json`;
  }

  dlqKey(agent: AgentTuple): string {
    return `${this.agentDir(agent)}/_tasks_dlq.json`;
  }

  // ── data-current ──────────────────────────────────────────────────────────

  async readCurrent(sess: SessionKey): Promise<BufferedMessages> {
    const raw = await this.storage.readFile(this.currentKey(sess));
    if (!raw) return { messages: [] };
    try {
      const parsed = JSON.parse(raw) as BufferedMessages;
      if (!parsed.messages) return { messages: [] };
      return { messages: parsed.messages };
    } catch {
      // Corrupted → treat as empty
      return { messages: [] };
    }
  }

  async writeCurrent(sess: SessionKey, buf: BufferedMessages): Promise<void> {
    await this.storage.writeFile(this.currentKey(sess), JSON.stringify(buf));
  }

  // ── session meta.json ────────────────────────────────────────────────────

  async readMeta(sess: SessionKey): Promise<SessionMeta> {
    const raw = await this.storage.readFile(this.metaKey(sess));
    if (!raw) return this.defaultMeta(sess);
    try {
      const parsed = JSON.parse(raw) as Partial<SessionMeta>;
      return {
        ...this.defaultMeta(sess),
        ...parsed,
        // Force critical fields to match (prevent old object session_id/space_id from being overwritten)
        session_id: sess.session_id,
        space_id: sess.space_id,
        user_id: sess.user_id,
        team_id: sess.team_id,
        agent_id: sess.agent_id,
      };
    } catch {
      return this.defaultMeta(sess);
    }
  }

  async writeMeta(sess: SessionKey, meta: SessionMeta): Promise<void> {
    await this.storage.writeFile(this.metaKey(sess), JSON.stringify(meta));
  }

  private defaultMeta(sess: SessionKey): SessionMeta {
    return {
      session_id: sess.session_id,
      space_id: sess.space_id,
      user_id: sess.user_id,
      team_id: sess.team_id,
      agent_id: sess.agent_id,
      tool_call_count: 0,
      byte_count: 0,
    };
  }

  // ── archive ────────────────────────────────────────────────────────────

  /**
   * Write an archive file; if the key already exists, treat it as success (aligns with design §7.4 ⑤).
   *
   * Note: we don't use If-None-Match: * headers (not exposed by the storage abstraction layer);
   * instead we do a two-step exists() → putObject. Same session is serialized by the proxy,
   * and archived_at_ms is monotonically increasing (millisecond timestamps), so collisions are
   * practically impossible.
   */
  async writeArchive(sess: SessionKey, archivedAtMs: number, buf: BufferedMessages): Promise<void> {
    const key = this.archiveKey(sess, archivedAtMs);
    if (await this.storage.exists(key)) {
      // Treat as success, skip write
      return;
    }
    await this.storage.writeFile(key, JSON.stringify(buf));
  }

  async readArchive(archiveKey: string): Promise<BufferedMessages | null> {
    const raw = await this.storage.readFile(archiveKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as BufferedMessages;
    } catch {
      return null;
    }
  }

  // ── agent _tasks.json ────────────────────────────────────────────────────

  async readTasks(agent: AgentTuple): Promise<AgentTasksDoc> {
    const raw = await this.storage.readFile(this.tasksKey(agent));
    if (!raw) return this.defaultTasks(agent);
    try {
      const parsed = JSON.parse(raw) as Partial<AgentTasksDoc>;
      return {
        team_id: agent.team_id,
        agent_id: agent.agent_id,
        updated_at_ms: parsed.updated_at_ms ?? 0,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      };
    } catch {
      return this.defaultTasks(agent);
    }
  }

  async writeTasks(agent: AgentTuple, doc: AgentTasksDoc): Promise<void> {
    await this.storage.writeFile(this.tasksKey(agent), JSON.stringify(doc));
  }

  private defaultTasks(agent: AgentTuple): AgentTasksDoc {
    return {
      team_id: agent.team_id,
      agent_id: agent.agent_id,
      updated_at_ms: 0,
      tasks: [],
    };
  }

  // ── agent _tasks_dlq.json (dead-letter queue) ─────────────────────────────────────
  //
  // DLQ is only appended by the Worker (and Worker already holds extract-lock, so only one
  // writer per agent exists), so no tasks-mutex protection is needed — but read-modify-write
  // still requires read before write to avoid truncating old content.

  async readDlq(agent: AgentTuple): Promise<AgentDeadTasksDoc> {
    const raw = await this.storage.readFile(this.dlqKey(agent));
    if (!raw) return this.defaultDlq(agent);
    try {
      const parsed = JSON.parse(raw) as Partial<AgentDeadTasksDoc>;
      return {
        team_id: agent.team_id,
        agent_id: agent.agent_id,
        updated_at_ms: parsed.updated_at_ms ?? 0,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      };
    } catch {
      return this.defaultDlq(agent);
    }
  }

  async appendDlq(agent: AgentTuple, dead: SkillDeadTaskEntry): Promise<void> {
    const doc = await this.readDlq(agent);
    doc.tasks.push(dead);
    doc.updated_at_ms = dead.dead_lettered_at_ms;
    await this.storage.writeFile(this.dlqKey(agent), JSON.stringify(doc));
  }

  private defaultDlq(agent: AgentTuple): AgentDeadTasksDoc {
    return {
      team_id: agent.team_id,
      agent_id: agent.agent_id,
      updated_at_ms: 0,
      tasks: [],
    };
  }
}
