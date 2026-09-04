/**
 * src/core/skill/queue/types.ts
 *
 * Skill extraction interface layer type definitions.
 *
 * 2026-07-17 Refactor: The old job queue (SkillExtractJob / SkillExtractResult /
 * ISkillTaskQueue / SkillQueueConfig) was deleted along with the skill_extract convergence to the
 * new pipeline of "SkillTriggerService.archive → agent queue". This file retains
 * Worker/extractor interface layer types (ConversationMessage / ExtractedCandidate /
 * ISkillExtractor / ExtractorLogger), for reuse by conversation-add/extract-worker.ts
 * and skill-extractor.ts.
 */

// ─────────────────────────────────────────────────────────────
// Conversation / candidate shapes used inside the queue
// ─────────────────────────────────────────────────────────────

/** Shape of a single conversation message in the queue (loose role field, compatible with user/assistant/tool_*). */
export interface ConversationMessage {
  role: string;
  content: string;
}

/** Shape of a single skill candidate in extraction results. */
export interface ExtractedCandidate {
  action: "create" | "patch" | "edit" | "update" | "write_file" | "files_write";
  name: string;
  skill_id?: string;
  version?: number;
  description?: string;
  /** Pass-through field: kept for compatibility with old result persistence payload. */
  content?: string;
  old_string?: string;
  new_string?: string;
  file_path?: string;
  file_type?: "text" | "executable" | "binary";
  confidence?: number;
  reason?: string;
}

/**
 * Minimal extractor interface called by Worker. SkillExtractor only needs to expose this method.
 * This way the queue does not depend on specific classes, and tests can mock directly.
 */
export interface ISkillExtractor {
  extract(input: {
    task_id?: string;
    taskId?: string;                // Compatible field
    team_id: string;
    user_id?: string;
    /** owner agent id; V2 adapter uses this to verify owner write permission. */
    agent_id?: string;
    /**
     * Pass-through of Langfuse top-level sessionId. Worker reads from SkillTaskEntry.session_id,
     * passing all the way to telemetry metadata of runner.run. When missing, Langfuse trace's
     * sessionId will be null —— filtering by session on the page will not show this skill extraction.
     */
    session_id?: string;
    /**
     * Instance id (= space_id / instanceId). Passed through to runner telemetry as instanceId,
     * otherwise instanceId on Langfuse trace will degrade to "unknown", and llm_call metric
     * will be skipped due to `if (params.instanceId)` gating.
     */
    space_id?: string;
    conversation: ConversationMessage[];
    context?: { loaded_skills?: string[] };
    signal?: AbortSignal;
    /**
     * direct-trigger scenario: Main Agent's extraction prompt, passed to extractor to inject prompt.
     * Read by conversation-add extract-worker from SkillTaskEntry.reason.
     */
    reason?: string;
    /** direct-trigger scenario: LLM iteration limit, passed to SkillExtractor to override default. */
    options?: { max_iterations?: number };
  }): Promise<{ candidates: ExtractedCandidate[] }>;
}

/**
 * Minimal logger interface for Worker (compatible with console and project Logger).
 */
export interface ExtractorLogger {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

