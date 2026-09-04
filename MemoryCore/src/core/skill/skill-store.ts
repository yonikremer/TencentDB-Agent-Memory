/**
 * SqliteSkillStore — New skill data access layer.
 *
 * Design goals:
 *   - Single table multi-row multi-version: each (skill_id, version) record per row, is_head=1 marks current version
 *   - Five-tuple identity fields: user_id / owner_agent_id / team_id / task_id / skill_id
 *   - Unaware of bindings / floating / drafts / conflicts
 *   - Write path: old head updated to 0 -> INSERT new row -> fts5 sync (atomic transaction)
 *   - Read path: all queries enforce team_id filtering
 *
 * See docs/design/2026-06-17-skill-redesign-v2.md §2 / §5 for details.
 *
 * Note: This file was added in Phase 2. When Phase 10 cleanup occurred, old `skill-store.ts` was removed,
 * and this file was renamed to `skill-store.ts`.
 */

import type { DatabaseSync } from "node:sqlite";

import { randomBase62 } from "../../utils/short-id.js";
import { SKILLS_DDL, SKILL_FTS_DDL, SKILL_VEC_DDL_TEMPLATE, FTS_CONTENT_MAX } from "./skill-store-ddl.js";
import { buildFtsQuery, tokenizeForFts } from "../store/sqlite.js";
import type { ISkillStore, ExpiredVersionMeta, SkillStoreCapabilities, SkillSearchResult } from "./skill-store.interface.js";
import type {
  AppendVersionInput,
  ListSkillsOptions,
  SearchSkillsOptions,
  SkillManifestEntry,
  SkillStatus,
  Skill,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════════
//  Error Types
// ═══════════════════════════════════════════════════════════════════════

export type SkillErrorCode =
  | "SKILL_NAME_DUPLICATE"
  | "SKILL_NOT_FOUND";

export class SkillStoreError extends Error {
  constructor(public readonly code: SkillErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "SkillStoreError";
  }
}

/**
 * Thrown when content_hash of appendVersion strictly matches current head.
 * Left to caller on how to handle (typically idempotent return of head). Store layer does not silently swallow.
 */
export class IdempotentNoOpError extends Error {
  constructor(public readonly head: Skill) {
    super("IDEMPOTENT_NO_OP: content_hash unchanged");
    this.name = "IdempotentNoOpError";
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Logger Interface
// ═══════════════════════════════════════════════════════════════════════

export interface StoreLogger {
  debug?(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

// ═══════════════════════════════════════════════════════════════════════
//  Options
// ═══════════════════════════════════════════════════════════════════════

export interface SqliteSkillStoreOptions {
  db: DatabaseSync;
  /** Embedding dimension. 0 = do not create skill_vec virtual table. */
  dimensions: number;
  logger?: StoreLogger;
  /** Injected now (ms). Default Date.now. For testing. */
  now?: () => number;
  /** Injected ULID generator. Default see defaultUlid(). For testing. */
  ulid?: () => string;
}

// ═══════════════════════════════════════════════════════════════════════
//  Internal Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * row_id generator — Physical primary key per row (TEXT PRIMARY KEY).
 * Separated from skill_id: skill_id shared across versions, row_id unique per row.
 * base62 12 chars (~71 bit CSPRNG true entropy); no base36 pseudo-randomness hazards.
 */
function defaultUlid(): string {
  return randomBase62(12);
}

interface SkillRowRaw {
  row_id: string;
  skill_id: string;
  version: number;
  is_head: number;

  user_id: string;
  owner_agent_id: string;
  team_id: string;
  task_id: string;

  name: string;
  description: string;
  content: string;
  content_hash: string;
  manifest_json: string;
  storage_dir: string;

  status: string;
  metadata_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

function toSkill(raw: SkillRowRaw): Skill {
  let manifest: SkillManifestEntry[];
  try {
    manifest = JSON.parse(raw.manifest_json);
    if (!Array.isArray(manifest)) manifest = [];
  } catch {
    manifest = [];
  }
  return {
    row_id: raw.row_id,
    skill_id: raw.skill_id,
    version: raw.version,
    is_head: raw.is_head === 1,
    user_id: raw.user_id,
    owner_agent_id: raw.owner_agent_id,
    team_id: raw.team_id,
    task_id: raw.task_id,
    name: raw.name,
    description: raw.description,
    content: raw.content,
    content_hash: raw.content_hash,
    manifest,
    storage_dir: raw.storage_dir,
    status: raw.status as SkillStatus,
    metadata_json: raw.metadata_json,
    created_at_ms: raw.created_at_ms,
    updated_at_ms: raw.updated_at_ms,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Store Implementation
// ═══════════════════════════════════════════════════════════════════════

export class SqliteSkillStore implements ISkillStore {
  private readonly db: DatabaseSync;
  private readonly dimensions: number;
  private readonly logger?: StoreLogger;
  private readonly now: () => number;
  private readonly ulid: () => string;
  private vecAvailable = false;
  private degraded = false;

  constructor(opts: SqliteSkillStoreOptions) {
    this.db = opts.db;
    this.dimensions = Math.max(0, Math.floor(opts.dimensions ?? 0));
    this.logger = opts.logger;
    this.now = opts.now ?? (() => Date.now());
    this.ulid = opts.ulid ?? defaultUlid;
  }

  /** Create tables and indexes. Idempotent. Migrates legacy indexes and FTS schema. */
  init(): void {
    this.db.exec(SKILLS_DDL);
    // Migration: drop legacy (team_id, name) unique index (changed to team_id + owner_agent_id + name after v2 refactor)
    this.db.exec("DROP INDEX IF EXISTS uniq_skills_team_name_head");
    this.db.exec(SKILL_FTS_DDL);
    // Migration: detect if skill_fts lacks owner_agent_id column (old schema had only 5 columns)
    this.migrateFtsSchema();
    if (this.dimensions > 0) {
      try {
        const ddl = SKILL_VEC_DDL_TEMPLATE.replace(/__DIM__/g, String(this.dimensions));
        this.db.exec(ddl);
        this.vecAvailable = true;
      } catch (e) {
        this.logger?.warn(`[skill-store] vec0 init failed: ${(e as Error).message}; downgrade to bm25-only`);
        this.vecAvailable = false;
      }
    }
  }

  /**
   * Detect and migrate skill_fts table schema.
   *
   * Background: legacy FTS DDL only had 5 columns (name, description, content, skill_id, team_id),
   * while new version added owner_agent_id / task_id / user_id columns. But CREATE VIRTUAL TABLE IF NOT EXISTS
   * will not modify existing tables, causing "no such column" errors when querying/writing 8 columns in new code.
   *
   * Migration strategy: Detect missing owner_agent_id -> DROP legacy FTS table -> Recreate -> Backfill head rows from skills main table.
   * Safer than ALTER (FTS5 does not support ALTER), and does not lose any data (main table is sole source of truth).
   */
  private migrateFtsSchema(): void {
    // Detection: skip if skill_fts table does not exist (created automatically by SKILL_FTS_DDL on first launch)
    const tableCheck = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_fts'")
      .get() as { name: string } | undefined;
    if (!tableCheck) return;

    // Check if existing skill_fts contains owner_agent_id column
    const cols = this.db
      .prepare("PRAGMA table_info('skill_fts')")
      .all() as Array<{ cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>;
    const colNames = new Set(cols.map((c) => c.name));

    // New version requires owner_agent_id / task_id / user_id, legacy version had 5 columns lacking these 3
    if (colNames.has("owner_agent_id")) return; // Already new schema, no migration needed

    this.logger?.info("[skill-store] migrating skill_fts schema: old columns missing owner_agent_id/task_id/user_id");

    // Step 1: Read all head rows from main table (for backfill)
    interface HeadRow {
      skill_id: string;
      name: string;
      description: string;
      content: string;
      team_id: string;
      owner_agent_id: string;
      task_id: string;
      user_id: string;
    }
    const headRows = this.db
      .prepare("SELECT skill_id, name, description, content, team_id, owner_agent_id, task_id, user_id FROM skills WHERE is_head=1 AND status='active'")
      .all() as unknown as HeadRow[];

    // Step 2: DROP old table -> Recreate new schema (atomic transaction)
    this.db.exec("BEGIN");
    try {
      this.db.exec("DROP TABLE IF EXISTS skill_fts");
      this.db.exec(SKILL_FTS_DDL);

      // Step 3: Backfill all head rows into FTS
      const insertStmt = this.db.prepare(
        "INSERT INTO skill_fts (name, description, content, skill_id, team_id, owner_agent_id, task_id, user_id) VALUES (?,?,?,?,?,?,?,?)",
      );
      for (const row of headRows) {
        const ftsContent = row.content.length > FTS_CONTENT_MAX
          ? row.content.slice(0, FTS_CONTENT_MAX)
          : row.content;
        insertStmt.run(
          tokenizeForFts(row.name),
          tokenizeForFts(row.description),
          tokenizeForFts(ftsContent),
          row.skill_id,
          row.team_id,
          row.owner_agent_id,
          row.task_id,
          row.user_id,
        );
      }

      this.db.exec("COMMIT");
      this.logger?.info(`[skill-store] fts migration done: rebuilt skill_fts with ${headRows.length} head rows`);
    } catch (e) {
      this.db.exec("ROLLBACK");
      this.logger?.error(`[skill-store] fts migration failed: ${(e as Error).message}`);
      // Even if migration fails, do not throw exception — gateway can still start, though skill search might degrade
      // Will retry on next startup (since SKILL_FTS_DDL will recreate an empty table after skill_fts is dropped)
    }
  }

  /** Whether in degraded mode (SQLite connection anomaly, etc.) */
  isDegraded(): boolean {
    return this.degraded;
  }

  /** Get store capability declaration */
  getCapabilities(): SkillStoreCapabilities {
    return {
      vectorSearch: this.vecAvailable,
      ftsSearch: true,
      nativeHybridSearch: false,
      sparseVectors: false,
    };
  }

  /** Close store (no-op under SQLite mode, connection managed externally) */
  close(): void {
    this.degraded = true;
  }

  // ────────────────────────────────────────────────────────────────────
  //  appendVersion
  //
  //  Note: store no longer performs content_hash idempotency checks — this layer only handles "writing a new version row".
  //  Idempotency semantics (both content + manifest unchanged -> do not write new version) are evaluated by skill-versioning at
  //  the upper layer, because only it knows both content_hash and new manifest_json simultaneously.
  // ────────────────────────────────────────────────────────────────────
  async appendVersion(input: AppendVersionInput): Promise<Skill> {
    const tid = input.team_id ?? "default";
    const head = await this.getHead(input.skill_id, tid);

    // [4] Same team, agent, and active head with same name (and not an update to the same skill_id) -> duplicate name
    if (!head) {
      const oid = input.owner_agent_id ?? "default";
      const dupRaw = this.db
        .prepare(
          "SELECT * FROM skills WHERE team_id=? AND owner_agent_id=? AND name=? AND is_head=1 AND status='active' LIMIT 1",
        )
        .get(tid, oid, input.name) as SkillRowRaw | undefined;
      if (dupRaw) {
        throw new SkillStoreError("SKILL_NAME_DUPLICATE", `name '${input.name}' already exists for agent in team`);
      }
    } else {
      // Existing history for same skill_id -> name is immutable
      if (head.name !== input.name) {
        throw new SkillStoreError("SKILL_NAME_DUPLICATE", "name change is not allowed across versions");
      }
    }

    const newVersion = head ? head.version + 1 : 1;
    const ownerForRow = head ? head.owner_agent_id : (input.owner_agent_id ?? "default");
    // user_id records the actor of this operation, not the initial creator. Subsequent versions take input.user_id.
    const userIdForRow = input.user_id ?? "default";
    const ts = this.now();
    const newRowId = this.ulid();

    // Transaction: old head updated to 0 -> INSERT new row -> FTS5 sync
    // node:sqlite currently lacks db.transaction() helper, manual BEGIN/COMMIT is used.
    // Must remain synchronous (no await in between), matching sqlite-transaction-guard design.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (head) {
        this.db
          .prepare("UPDATE skills SET is_head=0 WHERE skill_id=? AND version=?")
          .run(head.skill_id, head.version);
      }

      this.db
        .prepare(
          `INSERT INTO skills (
            row_id, skill_id, version, is_head,
            user_id, owner_agent_id, team_id, task_id,
            name, description, content, content_hash, manifest_json, storage_dir,
            status, metadata_json, created_at_ms, updated_at_ms
          ) VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?)`,
        )
        .run(
          newRowId,
          input.skill_id,
          newVersion,
          1,
          userIdForRow,
          ownerForRow,
          tid,
          input.task_id ?? "default",
          input.name,
          input.description,
          input.content,
          input.content_hash,
          JSON.stringify(input.manifest ?? []),
          input.storage_dir,
          "active",
          input.metadata_json ?? "{}",
          ts,
          ts,
        );

      // FTS sync: delete all old index rows for skill_id -> insert new head only
      this.db.prepare("DELETE FROM skill_fts WHERE skill_id=?").run(input.skill_id);
      const ftsContent = input.content.length > FTS_CONTENT_MAX
        ? input.content.slice(0, FTS_CONTENT_MAX)
        : input.content;
      // Use jieba pre-segmentation (consistent with L0/L1 FTS), allowing unicode61 tokenizer to split Chinese by spaces.
      // If jieba is unavailable, tokenizeForFts returns original text directly.
      const ftsName = tokenizeForFts(input.name);
      const ftsDescription = tokenizeForFts(input.description);
      const ftsContentTokenized = tokenizeForFts(ftsContent);
      this.db
        .prepare(
          "INSERT INTO skill_fts (name, description, content, skill_id, team_id, owner_agent_id, task_id, user_id) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(ftsName, ftsDescription, ftsContentTokenized, input.skill_id, tid, ownerForRow, input.task_id ?? "default", userIdForRow);

      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }

    // Fetch inserted row (read outside transaction to minimize lock holding time)
    const inserted = this.db
      .prepare("SELECT * FROM skills WHERE row_id=?")
      .get(newRowId) as SkillRowRaw;
    return toSkill(inserted);
  }

  // ────────────────────────────────────────────────────────────────────
  //  archiveHead
  // ────────────────────────────────────────────────────────────────────
  async archiveHead(skillId: string, teamId?: string): Promise<{ archived: boolean }> {
    const where = teamId ? "skill_id=? AND team_id=? AND is_head=1" : "skill_id=? AND is_head=1";
    const args: unknown[] = teamId ? [this.now(), skillId, teamId] : [this.now(), skillId];
    const r = this.db
      .prepare(`UPDATE skills SET status='archived', updated_at_ms=? WHERE ${where}`)
      .run(...args);

    // Removed from FTS after archiving (no longer searchable)
    if ((r.changes ?? 0) > 0) {
      this.db.prepare("DELETE FROM skill_fts WHERE skill_id=?").run(skillId);
      return { archived: true };
    }

    // Check if previously archived (still counted as success / idempotent)
    const checkWhere = teamId
      ? "skill_id=? AND team_id=? AND is_head=1 AND status='archived'"
      : "skill_id=? AND is_head=1 AND status='archived'";
    const checkArgs = teamId ? [skillId, teamId] : [skillId];
    const exists = this.db.prepare(`SELECT 1 FROM skills WHERE ${checkWhere} LIMIT 1`).get(...checkArgs);
    return { archived: !!exists };
  }

  // ────────────────────────────────────────────────────────────────────
  //  getHead / getByVersion / listVersions
  // ────────────────────────────────────────────────────────────────────
  /**
   * Get current head, enforcing `status='active'`. Archived skills treated as non-existent.
   *
   * Aligned with TCVDB side `_getHeadAsync` semantics (filter always carries `status="active"`).
   * To retrieve archived rows, use {@link getHeadIncludingArchived}.
   */
  async getHead(skillId: string, teamId?: string): Promise<Skill | null> {
    if (teamId) {
      const raw = this.db
        .prepare("SELECT * FROM skills WHERE skill_id=? AND team_id=? AND is_head=1 AND status='active' LIMIT 1")
        .get(skillId, teamId) as SkillRowRaw | undefined;
      return raw ? toSkill(raw) : null;
    }
    const raw = this.db
      .prepare("SELECT * FROM skills WHERE skill_id=? AND is_head=1 AND status='active' LIMIT 1")
      .get(skillId) as SkillRowRaw | undefined;
    return raw ? toSkill(raw) : null;
  }

  /**
   * Get current head, regardless of status. Only for delete idempotent fallback reads / compensation tasks / control panel.
   * Standard read/write paths **should not** call this method.
   */
  async getHeadIncludingArchived(skillId: string, teamId?: string): Promise<Skill | null> {
    if (teamId) {
      const raw = this.db
        .prepare("SELECT * FROM skills WHERE skill_id=? AND team_id=? AND is_head=1 LIMIT 1")
        .get(skillId, teamId) as SkillRowRaw | undefined;
      return raw ? toSkill(raw) : null;
    }
    const raw = this.db
      .prepare("SELECT * FROM skills WHERE skill_id=? AND is_head=1 LIMIT 1")
      .get(skillId) as SkillRowRaw | undefined;
    return raw ? toSkill(raw) : null;
  }

  async getByVersion(skillId: string, version: number, teamId?: string): Promise<Skill | null> {
    if (teamId) {
      const raw = this.db
        .prepare("SELECT * FROM skills WHERE skill_id=? AND version=? AND team_id=? LIMIT 1")
        .get(skillId, version, teamId) as SkillRowRaw | undefined;
      return raw ? toSkill(raw) : null;
    }
    const raw = this.db
      .prepare("SELECT * FROM skills WHERE skill_id=? AND version=? LIMIT 1")
      .get(skillId, version) as SkillRowRaw | undefined;
    return raw ? toSkill(raw) : null;
  }

  async listVersions(
    skillId: string,
    teamId?: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<Skill[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);
    if (teamId) {
      const rows = this.db
        .prepare("SELECT * FROM skills WHERE skill_id=? AND team_id=? ORDER BY version DESC LIMIT ? OFFSET ?")
        .all(skillId, teamId, limit, offset) as SkillRowRaw[];
      return rows.map(toSkill);
    }
    const rows = this.db
      .prepare("SELECT * FROM skills WHERE skill_id=? ORDER BY version DESC LIMIT ? OFFSET ?")
      .all(skillId, limit, offset) as SkillRowRaw[];
    return rows.map(toSkill);
  }

  /** Total number of versions under this skill_id (optional team_id filtering). */
  async countVersions(skillId: string, teamId?: string): Promise<number> {
    if (teamId) {
      const row = this.db
        .prepare("SELECT COUNT(*) AS c FROM skills WHERE skill_id=? AND team_id=?")
        .get(skillId, teamId) as { c: number };
      return row.c;
    }
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM skills WHERE skill_id=?")
      .get(skillId) as { c: number };
    return row.c;
  }

  // ────────────────────────────────────────────────────────────────────
  //  listSkills
  // ────────────────────────────────────────────────────────────────────
  async listSkills(opts: ListSkillsOptions): Promise<{ items: Skill[]; total: number }> {
    const status = opts.status?.length ? opts.status : (["active"] as SkillStatus[]);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);

    const where: string[] = ["is_head=1"];
    const args: unknown[] = [];

    // Four IDs: filter if provided, unrestricted if omitted
    if (opts.team_id) {
      where.push("team_id=?");
      args.push(opts.team_id);
    }
    if (opts.owner_agent_id) {
      where.push("owner_agent_id=?");
      args.push(opts.owner_agent_id);
    }
    if (opts.user_id) {
      where.push("user_id=?");
      args.push(opts.user_id);
    }
    if (opts.task_id) {
      where.push("task_id=?");
      args.push(opts.task_id);
    }

    where.push(`status IN (${status.map(() => "?").join(",")})`);
    args.push(...status);

    if (opts.name_prefix) {
      where.push("name LIKE ?");
      args.push(`${opts.name_prefix}%`);
    }

    const whereSql = where.join(" AND ");

    const totalRow = this.db.prepare(`SELECT COUNT(*) AS c FROM skills WHERE ${whereSql}`).get(...args) as { c: number };
    const rows = this.db
      .prepare(`SELECT * FROM skills WHERE ${whereSql} ORDER BY updated_at_ms DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as SkillRowRaw[];

    return { items: rows.map(toSkill), total: totalRow.c };
  }

  // ────────────────────────────────────────────────────────────────────
  //  searchSkills (BM25 implementation only; vec part combined by hybrid callers)
  // ────────────────────────────────────────────────────────────────────
  async searchSkills(opts: SearchSkillsOptions): Promise<SkillSearchResult[]> {
    const topK = Math.min(Math.max(opts.topK ?? 10, 1), 50);
    const query = (opts.query ?? "").trim();
    if (!query) return [];

    // mode pass-through: current store implements BM25 path only.
    // - 'bm25' / unpassed -> directly execute BM25 (default)
    // - 'embedding' / 'hybrid' but vec unavailable or no queryEmbedding -> downgrade to BM25 + warn log
    // True hybrid (RRF) / pure vec paths are follow-up items; mode will not be silently swallowed at contract level.
    const requestedMode = opts.mode ?? "bm25";
    const wantsVec = requestedMode === "embedding" || requestedMode === "hybrid";
    if (wantsVec && (!this.vecAvailable || !opts.queryEmbedding)) {
      this.logger?.warn(
        `[skill-store] search mode='${requestedMode}' downgraded to 'bm25' ` +
          `(vec_available=${this.vecAvailable}, has_embedding=${!!opts.queryEmbedding})`,
      );
    }
    // Pure embedding path not yet implemented -> fallback to BM25; hybrid likewise falls back to BM25 (subsequent RRF fusion).

    // FTS5 Query: use buildFtsQuery (consistent with L0/L1 jieba segmentation + quote wrapping + OR join).
    // jieba cutForSearch handles Chinese segmentation properly; falls back to Unicode regex splitting.
    // Each token is wrapped in double quotes to prevent FTS5 reserved keywords (AND/OR/NOT/NEAR) from being misparsed as boolean operators.
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    // FTS5 snippet(table, col, prefix, suffix, ellipsis, tokenCount)
    // col=2 -> skill_fts.content (DDL column order: name=0, description=1, content=2, skill_id=3, team_id=4, owner_agent_id=5, task_id=6, user_id=7).
    // 16 token snippet with <mark> highlights.
    //
    // Four IDs filtered directly at FTS5 layer (added if passed), avoiding inefficient path of searching full set then back-filtering.
    let ftsRows: Array<{ skill_id: string; bm25: number; snippet: string }>;
    try {
      const ftsArgs: Array<string | number> = [ftsQuery];
      let ftsWhere = "skill_fts MATCH ?";
      if (opts.team_id) {
        ftsWhere += " AND team_id=?";
        ftsArgs.push(opts.team_id);
      }
      if (opts.agent_id) {
        ftsWhere += " AND owner_agent_id=?";
        ftsArgs.push(opts.agent_id);
      }
      if (opts.task_id) {
        ftsWhere += " AND task_id=?";
        ftsArgs.push(opts.task_id);
      }
      if (opts.user_id) {
        ftsWhere += " AND user_id=?";
        ftsArgs.push(opts.user_id);
      }
      ftsArgs.push(topK * 2);
      ftsRows = this.db
        .prepare(
          `SELECT skill_id,
                  bm25(skill_fts) AS bm25,
                  snippet(skill_fts, 2, '<mark>', '</mark>', '…', 16) AS snippet
           FROM skill_fts
           WHERE ${ftsWhere}
           ORDER BY bm25 LIMIT ?`,
        )
        .all(...ftsArgs) as Array<{ skill_id: string; bm25: number; snippet: string }>;
    } catch (e) {
      this.logger?.warn(`[skill-store] fts query failed: ${(e as Error).message}`);
      return [];
    }

    // Backfill query on main table: verify is_head=1 AND status='active' (FTS5 does not contain these two fields)
    const hits: Array<{ skill: Skill; score: number; snippet: string }> = [];
    for (const r of ftsRows) {
      const row = this.db
        .prepare(
          `SELECT * FROM skills WHERE skill_id=? AND is_head=1 AND status='active' LIMIT 1`,
        )
        .get(r.skill_id) as SkillRowRaw | undefined;
      if (!row) continue;
      // Smaller bm25 means higher relevance -> converted to score where larger is better
      hits.push({
        skill: toSkill(row),
        score: -r.bm25,
        snippet: r.snippet ?? "",
      });
      if (hits.length >= topK) break;
    }
    return hits;
  }

  // ────────────────────────────────────────────────────────────────────
  //  TTL Cleanup
  // ────────────────────────────────────────────────────────────────────

  /** Query expired non-head versions with created_at_ms < cutoffMs. */
  async findExpiredVersions(cutoffMs: number): Promise<ExpiredVersionMeta[]> {
    const rows = this.db
      .prepare(
        `SELECT skill_id, version, is_head, status, storage_dir, created_at_ms
         FROM skills WHERE is_head=0 AND status='active' AND created_at_ms < ?
         ORDER BY skill_id ASC, version ASC`,
      )
      .all(cutoffMs) as Array<{
        skill_id: string;
        version: number;
        is_head: number;
        status: string;
        storage_dir: string;
        created_at_ms: number;
      }>;
    return rows.map((r) => ({
      skill_id: r.skill_id,
      version: r.version,
      is_head: r.is_head === 1,
      status: r.status as SkillStatus,
      storage_dir: r.storage_dir,
      created_at_ms: r.created_at_ms,
    }));
  }

  /** Physically delete specified version row (safety lock: is_head=0 only). */
  async deleteVersion(skillId: string, version: number): Promise<boolean> {
    const r = this.db
      .prepare("DELETE FROM skills WHERE skill_id=? AND version=? AND is_head=0")
      .run(skillId, version);
    return (r.changes ?? 0) > 0;
  }

  /**
   * Physically delete all version rows under the same skill_id (including head + archived) + clear fts / vec.
   * Returns count of rows actually deleted. `SkillCore.delete` takes this path; permission validation is caller's responsibility.
   */
  async deleteAllVersions(skillId: string, teamId?: string): Promise<number> {
    const where = teamId ? "skill_id=? AND team_id=?" : "skill_id=?";
    const args: unknown[] = teamId ? [skillId, teamId] : [skillId];
    const r = this.db.prepare(`DELETE FROM skills WHERE ${where}`).run(...args);
    const changes = r.changes ?? 0;
    // DELETE from auxiliary tables only when main table rows were actually deleted — prevents accidental fts clearing on cross-team validation failures
    if (changes > 0) {
      try {
        this.db.prepare("DELETE FROM skill_fts WHERE skill_id=?").run(skillId);
      } catch {
        // fts may have already been cleared by archiveHead, second deletion is idempotent
      }
      if (this.vecAvailable) {
        try {
          this.db.prepare("DELETE FROM skill_vec WHERE skill_id=?").run(skillId);
        } catch {
          /* non-fatal */
        }
      }
    }
    return changes;
  }

  // ────────────────────────────────────────────────────────────────────
  //  Embedding Maintenance
  // ────────────────────────────────────────────────────────────────────
  upsertEmbedding(skillId: string, embedding: Float32Array): void {
    if (!this.vecAvailable) return;
    if (embedding.length !== this.dimensions) {
      this.logger?.warn(`[skill-store] embedding dim mismatch: ${embedding.length} vs ${this.dimensions}`);
      return;
    }
    try {
      this.db.prepare("DELETE FROM skill_vec WHERE skill_id=?").run(skillId);
      this.db.prepare("INSERT INTO skill_vec (skill_id, embedding) VALUES (?, ?)").run(skillId, Buffer.from(embedding.buffer));
    } catch (e) {
      this.logger?.warn(`[skill-store] upsertEmbedding failed: ${(e as Error).message}`);
    }
  }

  deleteEmbedding(skillId: string): void {
    if (!this.vecAvailable) return;
    try {
      this.db.prepare("DELETE FROM skill_vec WHERE skill_id=?").run(skillId);
    } catch (e) {
      this.logger?.warn(`[skill-store] deleteEmbedding failed: ${(e as Error).message}`);
    }
  }
}

