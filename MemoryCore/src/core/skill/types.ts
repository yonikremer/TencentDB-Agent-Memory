/**
 * Type definitions for the Skill module — v2 redesign (2026-06-17).
 *
 * Host-neutral. No imports from openclaw / hermes / automation projects.
 * Design document: docs/design/2026-06-17-skill-redesign-v2.md
 */

// ============================
// Configuration types (input from user / openclaw.json)
// ============================

/**
 * User-facing skill configuration. All fields optional; defaults applied
 * by `resolveSkillConfig`.
 */
export interface SkillConfigInput {
  enabled?: boolean;

  /** Override for skill metadata + vector store backend. Falls back to outer storeBackend, then 'sqlite'. */
  storeBackend?: "sqlite" | "tcvdb";

  /** Override for skill content (SKILL.md + resources) backend. Falls back to env probe → 'local'. */
  contentBackend?: "local" | "cos";

  routing?: {
    mode?: "bm25" | "embedding" | "hybrid";
    hybridAlpha?: number;
    searchTopK?: number;
    charBudgetPercent?: number;
    fastPathMinNameLength?: number;
  };

  extraction?: {
    enabled?: boolean;
    toolCallThreshold?: number;
    model?: string;
    maxIterations?: number;
    /**
     * Single "archive size" knob (bytes). Default 40960 (40KB). Derives 7 internal fields:
     *   • Handler bytesThreshold / requestCompressThresholdBytes = archiveBytes
     *   • Oversize fallback chunkMaxBytes = 2 × archiveBytes
     *   • Oversize fallback headKeepBytes / tailKeepBytes = archiveBytes
     *   • Extractor transcript truncation headChars / tailChars = archiveBytes
     * Semantics: archive payload target size = archiveBytes, upper cap = 2 × archiveBytes.
     */
    archiveBytes?: number;
    /** Skill review single LLM call output token cap. Unspecified -> inherits top-level llm.maxTokens. */
    maxTokens?: number;
    /**
     * Extractor injects a pre-retrieved skill list into transcript before handing to review LLM
     * (obtained by extractor running skill_list itself). Controls maximum item count for this list,
     * shared cap for relevant retrieval (LLM generated query + BM25 search) and recent fallback
     * (ordered by updated_at DESC pagination). Default 20; <=0 or non-integer warns and falls back to 20.
     */
    prefixSkillsLimit?: number;
  };

  /**
   * Compression rules for head/tail of a single large tool message. Only affects head/tail splitting
   * when single tool_call / tool_result content exceeds threshold; user/assistant/system are never compressed.
   */
  compress?: {
    /** Single tool message content threshold in bytes to trigger compression. Default 2048 (2KB). */
    toolContentThresholdBytes?: number;
    /** Head bytes retained after compression. Default 1024 (1KB). */
    headBytes?: number;
    /** Tail bytes retained after compression. Default 1024 (1KB). */
    tailBytes?: number;
  };

  resources?: {
    maxResourceSizeBytes?: number;
    downloadDir?: string;
    allowExecutable?: boolean;
  };

  /** Old version TTL in days. Default 0 (disabled). Setting 7 = non-head versions expire 7 days after creation. */
  versionTtlDays?: number;

  /**
   * Skill extraction worker pool (introduced 2026-07-30). One pool per process, sharing single
   * skill agent queue across all instances, N stateless worker loops in pool pop jobs from queue.
   * See docs/design/2026-07-30-skill-worker-instance-decoupling.md for details.
   */
  worker?: {
    /** Worker count in pool, process-wide skill extraction concurrency cap. Default 60. Overridable via env TDAI_SKILL_WORKER_CONCURRENCY. */
    concurrency?: number;
    /** Single dequeueAgent spin deadline (ms). Default 5000. */
    brpopBlockMs?: number;
    /** extract-lock TTL (ms), protects serial execution per (instance, agent). Default 600_000 (10 min). */
    extractLockTtlMs?: number;
    /** extract-lock renewal interval (ms), default ttl / 4. */
    extractLockRenewIntervalMs?: number;
  };
}

// ============================
// Resolved configuration (after defaults + downgrade decisions)
// ============================

export interface ResolvedSkillConfig {
  enabled: true; // when this object exists, skill is enabled
  storeBackend: "sqlite" | "tcvdb";
  contentBackend: "local" | "cos";

  routing: {
    mode: "bm25" | "embedding" | "hybrid";
    hybridAlpha: number;
    searchTopK: number;
    charBudgetPercent: number;
    fastPathMinNameLength: number;
  };

  extraction: {
    enabled: boolean;
    toolCallThreshold: number;
    model?: string;
    maxIterations: number;
    /** Archive size knob (bytes). User-facing config source; 7 fields below are derived from it. */
    archiveBytes: number;
    /** Skill review single LLM call output token cap; unspecified -> runner inherits llm.maxTokens. */
    maxTokens?: number;
    /**
     * Extractor pre-retrieved skill list item limit (shared by relevant BM25 search & recent fallback).
     * Default 20.
     */
    prefixSkillsLimit: number;
    // ↓↓↓ Below 7 fields derived from archiveBytes, not configured directly by user ↓↓↓
    /** Handler: cumulative buffer bytes >= triggers archiving. = archiveBytes. */
    bytesThreshold: number;
    /** Handler: single add request >= forces compressed path. = archiveBytes. */
    requestCompressThresholdBytes: number;
    /** Oversize fallback: archive payload > triggers split. = 2 × archiveBytes. */
    chunkMaxBytes: number;
    /** Oversize fallback: retained head bytes after split. = archiveBytes. */
    headKeepBytes: number;
    /** Oversize fallback: retained tail bytes after split. = archiveBytes. */
    tailKeepBytes: number;
    /** Extractor transcript truncation: retained head characters. = archiveBytes (byte count approx as char count). */
    headChars: number;
    /** Extractor transcript truncation: retained tail characters. = archiveBytes. */
    tailChars: number;
  };

  /** Compression for single large tool message head/tail, parameters aligned with CompressOptions. */
  compress: {
    toolContentThresholdBytes: number;
    headBytes: number;
    tailBytes: number;
  };

  resources: {
    maxResourceSizeBytes: number;
    downloadDir: string;
    allowExecutable: boolean;
  };

  /** Old version TTL in seconds. 0 = disabled. */
  versionTtlSeconds: number;

  /** Skill extraction worker pool config (2026-07-30). See SkillConfigInput.worker comment. */
  worker: {
    concurrency: number;
    brpopBlockMs: number;
    extractLockTtlMs: number;
    extractLockRenewIntervalMs: number;
  };

  /** Records of automatic downgrades made during resolution. */
  degradations: SkillDegradation[];
}

export interface SkillDegradation {
  field: string;
  from: string;
  to: string;
  reason: string;
  level: "info" | "warn";
}

// ============================
// Probe inputs to resolveSkillConfig
// ============================

/**
 * Information about ambient capabilities that resolveSkillConfig uses
 * to make downgrade decisions. Keep this minimal and explicit; no
 * implicit env/process reads inside resolveSkillConfig itself.
 */
export interface SkillEnvProbe {
  /** Outer storeBackend from MemoryTdaiConfig. */
  outerStoreBackend?: "sqlite" | "tcvdb";

  /** TCVDB credentials present (url + apiKey + database all set). */
  hasTcvdbCredentials: boolean;

  /** COS credentials present (secretId + secretKey + bucket all set). */
  hasCosCredentials: boolean;

  /** Embedding subsystem usable (enabled + provider valid + dimensions > 0). */
  embeddingAvailable: boolean;

  /**
   * Whether the host provides an LLMRunnerFactory. When false and
   * extraction.enabled=true, we mark extraction as degraded (it stays
   * "enabled" but will return [] at runtime).
   */
  llmRunnerAvailable: boolean;
}

// ════════════════════════════════════════════════════════════════════════
//  v2 Data Plane Contract (2026-06-17 redesign)
// ════════════════════════════════════════════════════════════════════════

/**
 * Business identity 4-tuple. All optional.
 * team_id and agent_id must both be passed or both omitted (guaranteed by gateway schema layer cross-field validation).
 */
export interface IdFields {
  user_id?: string;
  team_id?: string;
  agent_id?: string;
  task_id?: string;
}

/** skill status. Aligned with interface.yaml: active or archived. */
export type SkillStatus = "active" | "archived";

/** Single resource metadata in manifest_json column. Bytes are not in this type. */
export interface SkillManifestEntry {
  /** Path relative to `files/`, UNIX style, no `..` / absolute paths allowed. E.g., "scripts/run.sh" */
  path: string;
  size_bytes: number;
  mime_type: string;
  is_executable: boolean;
}

// ============================
// Skill dedup / propose types (M13 — two-step confirmation)
// ============================

export interface SkillSimilarityResult {
  name: string;
  description: string;
  similarity: number;
}

export interface SkillProposeResult {
  propose_id: string;
  proposed: {
    name: string;
    description: string;
  };
  similar_skills: SkillSimilarityResult[];
}

/**
 * A single row of skill main table. Each row = (skill_id, version) immutable snapshot.
 *
 * - Fields correspond to `skills` table (see skill-store-ddl.ts SKILLS_DDL)
 * - `manifest` is structured form of deserialized `manifest_json` column
 * - `is_head` is boolean (0/1 INTEGER in DB)
 */
export interface Skill {
  row_id: string;
  skill_id: string;
  version: number;
  is_head: boolean;

  user_id: string;
  owner_agent_id: string;
  team_id: string;
  task_id: string;

  name: string;
  description: string;
  content: string;
  content_hash: string;
  manifest: SkillManifestEntry[];
  storage_dir: string;

  status: SkillStatus;
  metadata_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

/** Input params for `appendVersion`. Store internally derives version+1 based on head. */
export interface AppendVersionInput {
  /** Writer identity. Defaults to "default" if omitted. */
  user_id?: string;
  team_id?: string;
  agent_id?: string;
  task_id?: string;

  /** Business primary key — generated by caller on first creation; subsequent versions of same skill share skill_id. */
  skill_id: string;

  name: string;
  description: string;
  content: string;
  content_hash: string;
  manifest: SkillManifestEntry[];
  storage_dir: string;

  /** Only specified by caller as owner_agent_id on create; subsequent versions validated by store and inherited from head. */
  owner_agent_id?: string;

  metadata_json?: string;
}

/** Query params for `listSkills`. Only returns rows matching head + status condition. All 4 IDs optional, filtered if provided. */
export interface ListSkillsOptions {
  team_id?: string;
  owner_agent_id?: string;
  user_id?: string;
  task_id?: string;
  name_prefix?: string;
  status?: SkillStatus[];
  limit?: number;
  offset?: number;
}

/** Query params for `searchSkills`. Only matches head + active rows. All 4 IDs optional, filtered if provided. */
export interface SearchSkillsOptions {
  team_id?: string;
  query: string;
  queryEmbedding?: Float32Array;
  topK?: number;
  /**
   * Retrieval mode (design §3.5.7).
   *   - 'bm25'      : FTS5 BM25 only
   *   - 'embedding' : vec0 KNN only (requires queryEmbedding)
   *   - 'hybrid'    : BM25 + KNN RRF fusion (requires queryEmbedding)
   * Fallbacks to bm25 if unpassed / embedding not configured.
   */
  mode?: "bm25" | "embedding" | "hybrid";
  /** Optional: filter search results by owner agent. */
  agent_id?: string;
  /** Optional: filter search results by task. */
  task_id?: string;
  /** Optional: filter search results by user. */
  user_id?: string;
}

/** Structured conversation message for extraction interface. Aligned with interface.yaml §SkillImportMessage. */
export interface ExtractMessage {
  role: "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  timestamp?: string;
}

/**
 * LLM runner shape used by Skill Review Agent. Constructed at boot side and injected into SkillExtractor.
 * Compatible with StandaloneLLMRunner.run in src/adapters/standalone/llm-runner.ts.
 */
export interface ExtractorLLMRunner {
  run(params: {
    prompt: string;
    systemPrompt?: string;
    /** Tool dict (Vercel AI SDK shape). Drives tool-call loop when enableTools=true. */
    tools?: Record<string, unknown>;
    enableTools?: boolean;
    maxIterations?: number;
    taskId: string;
    timeoutMs?: number;
    /** Worker cancels LLM call via abort signal when lock expires. */
    signal?: AbortSignal;
  }): Promise<string>;
}

