/**
 * ISkillStore — Skill Storage Layer Interface Abstraction
 *
 * Decouples SkillCore / SkillVersioning from specific storage implementations (SQLite / TCVDB).
 * SqliteSkillStore (Standalone mode) and TcvdbSkillStore (Service mode)
 * each implement this interface, and consumers rely solely on the interface.
 *
 * Design documents:
 *   - docs/design/2026-06-25-skill-service-mode-design.md §6.1
 *   - docs/design/2026-06-17-skill-redesign-v2.md
 */

import type {
  AppendVersionInput,
  ListSkillsOptions,
  SearchSkillsOptions,
  Skill,
  SkillStatus,
} from "./types.js";

// ─── Capabilities ──────────────────────────────────────────────────────────

/** Store capabilities declaration, used for retrieval fallback evaluation */
export interface SkillStoreCapabilities {
  /** Dense vector search available */
  vectorSearch: boolean;
  /** BM25 sparse vector search available */
  ftsSearch: boolean;
  /** Native hybridSearch in TCVDB available (false in local mode) */
  nativeHybridSearch: boolean;
  /** Sparse vector support */
  sparseVectors: boolean;
}

// ─── Search Result ─────────────────────────────────────────────────────────

export interface SkillSearchResult {
  skill: Skill;
  score: number;
  snippet?: string;
}

// ─── TTL Cleanup Meta ──────────────────────────────────────────────────────

/** Expired version metadata used for TTL cleanup (lightweight, content/manifest not read). */
export interface ExpiredVersionMeta {
  skill_id: string;
  version: number;
  is_head: boolean;
  status: SkillStatus;
  storage_dir: string;
  created_at_ms: number;
}

// ─── Store Interface ───────────────────────────────────────────────────────

export interface ISkillStore {
  // ── Lifecycle ──
  /** Initialize storage (create tables/collections, etc.). */
  init(): void;
  /** Whether in degraded mode (unavailable) */
  isDegraded(): boolean;
  /** Get store capability declaration */
  getCapabilities(): SkillStoreCapabilities;
  /** Close storage (release connections, etc.) */
  close(): void;

  // ── CRUD ──
  /** Append a version row. Store is not responsible for idempotency checks (handled by upper layer SkillVersioning). */
  appendVersion(input: AppendVersionInput): Promise<Skill>;
  /**
   * Get current head version (is_head=1 and status='active').
   *
   * Semantics: `archived` is treated as "logical deletion", invisible to any external read interfaces—returns null in all such cases.
   * To view an archived head, use {@link getHeadIncludingArchived} (used only by internal paths like `SkillCore.delete`
   * idempotent fallback reads, TTL cleaner, admin console, etc.).
   */
  getHead(skillId: string, teamId?: string): Promise<Skill | null>;
  /**
   * Get current head version, including archived.
   *
   * For internal use only:
   *   - `SkillCore.delete` needs to get archived head to achieve idempotent `{ archived: true }`
   *   - Background compensation tasks scan for drift between archived skill and asset
   *   - Control panel "recycle bin" view
   *
   * Standard read/write paths **should not** call this method—use `getHead`.
   */
  getHeadIncludingArchived(skillId: string, teamId?: string): Promise<Skill | null>;
  /** Get specified version row */
  getByVersion(skillId: string, version: number, teamId?: string): Promise<Skill | null>;
  /** Mark head as archived (soft delete) */
  archiveHead(skillId: string, teamId?: string): Promise<{ archived: boolean }>;

  // ── Query ──
  /** List head rows, supporting 5-tuple filtering + pagination */
  listSkills(opts: ListSkillsOptions): Promise<{ items: Skill[]; total: number }>;
  /** Search skills (BM25 / embedding / hybrid, decided by implementation) */
  searchSkills(opts: SearchSkillsOptions): Promise<SkillSearchResult[]>;
  /** List all versions of a skill (DESC) */
  listVersions(skillId: string, teamId?: string, pagination?: { limit?: number; offset?: number }): Promise<Skill[]>;
  /** Total number of versions for a skill */
  countVersions(skillId: string, teamId?: string): Promise<number>;

  // ── TTL Cleanup ──
  /** Query expired non-head versions where created_at_ms < cutoffMs (full scan across all teams). */
  findExpiredVersions(cutoffMs: number): Promise<ExpiredVersionMeta[]>;
  /** Physically delete specified version row (is_head=0 only). Returns whether row was actually deleted. */
  deleteVersion(skillId: string, version: number): Promise<boolean>;
  /**
   * Physically delete **all version rows** under the same skill_id (including head + archived).
   * Returns count of rows actually deleted (may be 0 if skill does not exist or team mismatch).
   *
   * Used for the true deletion path of `SkillCore.delete`, opposite to `deleteVersion`'s head protection:
   * Takes responsibility for "clearing all at once with skill as the unit", permission validation is performed first by caller
   * (SkillCore).
   *
   * Semantics:
   *   - `teamId` passed → WHERE enforced filter, no effect across teams (returns 0)
   *   - `teamId` omitted → cross-team deletion (for admin console / background compensation tasks, business paths should not call)
   */
  deleteAllVersions(skillId: string, teamId?: string): Promise<number>;
}

