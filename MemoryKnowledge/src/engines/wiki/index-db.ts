/**
 * Per-wiki `index.db` connection management (Design 006).
 *
 * Each wiki has a dedicated SQLite file `index.db` located under its data directory (sharing lifecycle with body `.md` files),
 * hosting all private index data for this wiki:
 *   - `wiki_fts`   FTS5 pre-tokenized inverted index (BM25 full-text search)
 *   - `page_meta`  Page metadata (title/type/rel_path/snippet; body stored on disk)
 *   - `graph_edge` Knowledge graph directed edges (for multi-hop BFS)
 *   - `source`     Source files as first-class entities (incremental determination + lifecycle; DDL built in this round)
 *
 * Connection strategy (Design §4):
 *   - Write (ingest/sync: rebuild FTS5 + graph_edge + update source): **Independent connection**, completed within transaction
 *     → `wal_checkpoint(TRUNCATE)` → `close()`, not entering pool to prevent race conditions with LRU eviction.
 *   - Read (search/graph): Uses **LRU connection pool**, hot wiki resident, cold wiki evicted.
 *
 * Memory ceiling = POOL_MAX × cache_size (approx. 600MB), decoupled from total wiki count; SQLite connection opening is sub-millisecond
 * and data is lazily loaded per page (not loaded fully into memory upon open), which fundamentally fixes MiniSearch 20GB OOM.
 *
 * File descriptor limits (Design §4.3): WAL takes 3 fds per connection (db+wal+shm), `POOL_MAX × 3 + margin` must be ≤ ulimit -n.
 * POOL_MAX is tied to deployment ulimit, default 300 (approx. 900 fds, recommended ulimit -n ≥ 2048).
 */

import Database from "better-sqlite3";
import { LRUCache } from "lru-cache";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Read connection pool upper limit. Linked to deployment ulimit (WAL takes 3 fds per connection, requires ulimit -n ≥ POOL_MAX*3 + margin).
 * Overridable via environment variable (for testing or special environments only), default 300.
 */
const POOL_MAX = (() => {
  const raw = process.env.KNOWLEDGE_WIKI_POOL_MAX;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 300;
})();

/** Upper limit of page cache per connection (KB); cache_size uses negative numbers for KB. */
const CACHE_KB = 2000;

/** Evict/close a read connection: checkpoint to merge WAL first, then close. Silent on failure (connection may already be broken). */
function disposeDb(db: Database.Database): void {
  try {
    if (db.open) {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    }
  } catch {
    /* best-effort: connection may already be closed or file deleted */
  }
}

/**
 * Read connection LRU pool (lru-cache, MIT): hot wiki connections resident, cold wiki evicted.
 * Eviction (exceeding max) and explicit `delete` (wiki removal) both trigger `dispose` → checkpoint + close.
 */
const readPool = new LRUCache<string, Database.Database>({
  max: POOL_MAX,
  dispose: (db) => disposeDb(db),
});

/** Default pragmas set uniformly upon opening each connection (Design §4.2). */
function applyPragmas(db: Database.Database): void {
  db.pragma("journal_mode = WAL"); // Multi-reader single-writer; ingest does not block reads during search
  db.pragma("synchronous = NORMAL"); // Safe and fast under WAL
  db.pragma(`cache_size = -${CACHE_KB}`); // Per-connection page cache limit (negative number = KB)
  db.pragma("busy_timeout = 5000"); // Write lock waits at most 5s to avoid occasional SQLITE_BUSY
}

/** Create 4 tables (idempotent). Called only during initIndexDb (explicit wiki creation). */
function initSchema(db: Database.Database): void {
  // ① BM25: FTS5 virtual table. Stores pre-tokenized space token string, Chinese bigram logic stays in JS tokenize(),
  //    FTS5 uses unicode61 to cut by space/punctuation only (consistent with configuration verified in __tests__/bm25-comparison).
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
       page_id UNINDEXED,
       title_tok,
       content_tok,
       tokenize = 'unicode61 remove_diacritics 0'
     );`,
  );

  // ② Page metadata (returned in search results, excluding body; body is on disk .md).
  db.exec(
    `CREATE TABLE IF NOT EXISTS page_meta (
       page_id   TEXT PRIMARY KEY,
       title     TEXT,
       type      TEXT,
       rel_path  TEXT,
       snippet   TEXT
     );`,
  );

  // ③ Graph directed edges (used by multi-hop BFS; loaded into memory to build small graph on query, graph data is small).
  db.exec(
    `CREATE TABLE IF NOT EXISTS graph_edge (
       source_id TEXT NOT NULL,
       target_id TEXT NOT NULL,
       PRIMARY KEY (source_id, target_id)
     );`,
  );

  // ④ Source management table (003: Source files as first-class entities). DDL built in this round to keep schema stable;
  //    Read/write methods (readSources/writeSource/markIngested/deleteSource) filled in Phase 003.
  db.exec(
    `CREATE TABLE IF NOT EXISTS source (
       filename          TEXT PRIMARY KEY,
       sha256            TEXT NOT NULL,
       size              INTEGER NOT NULL,
       status            TEXT NOT NULL,
       created_at        TEXT NOT NULL,
       updated_at        TEXT NOT NULL,
       last_modified_by  TEXT,
       ingested_at       TEXT,
       ingest_error      TEXT
     );`,
  );
}

function dbPath(wikiDir: string): string {
  return join(wikiDir, "index.db");
}

/**
 * ★ Explicit DB creation: Called once in the wiki creation API, building 4 tables. Idempotent (IF NOT EXISTS).
 * Thereafter getReadDb / withWriteDb only open existing DBs without creating tables.
 */
export function initIndexDb(wikiDir: string): void {
  const db = new Database(dbPath(wikiDir));
  applyPragmas(db);
  try {
    initSchema(db);
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

/**
 * Read connection (search/graph): pooled and reused. Database must have been created by initIndexDb.
 * If database missing → throw error (treated as "wiki not created properly / data corrupted", no silent lazy creation).
 */
export function getReadDb(wikiId: string, wikiDir: string): Database.Database {
  let db = readPool.get(wikiId);
  if (!db || !db.open) {
    const path = dbPath(wikiDir);
    if (!existsSync(path)) {
      throw new Error(`index.db missing (wiki not created?): ${wikiId}`);
    }
    db = new Database(path, { readonly: false });
    applyPragmas(db);
    readPool.set(wikiId, db);
  }
  return db;
}

/**
 * Write connection (ingest/sync/rawWrite): Created independently, checkpoint + close after completion in transaction, not pooled.
 * Rebuilds inside `fn` (FTS5 + graph_edge + page_meta + source) complete atomically in the same transaction.
 */
export function withWriteDb<T>(wikiDir: string, fn: (db: Database.Database) => T): T {
  const path = dbPath(wikiDir);
  if (!existsSync(path)) {
    throw new Error(`index.db missing (wiki not created?): ${wikiDir}`);
  }
  const db = new Database(path);
  applyPragmas(db);
  try {
    const out = db.transaction(fn)(db);
    db.pragma("wal_checkpoint(TRUNCATE)");
    return out;
  } finally {
    db.close();
  }
}

/** Wiki deletion: close read connection first (dispose internal checkpoint+close), caller then rmSync directory. */
export function evictWikiDb(wikiId: string): void {
  readPool.delete(wikiId);
}

/** Current connection count in read pool (for testing/observability). */
export function readPoolSize(): number {
  return readPool.size;
}

// ═══════════════════════════════════════════════════════════════════
// source table read/write (Design 003: source files as first-class entities + incremental extraction)
// ═══════════════════════════════════════════════════════════════════

/** Lifecycle status of a single source file (file granularity, unrelated to wiki granularity status). */
export type SourceStatus = "uploaded" | "ingested" | "failed";

/** A row in source table (returned by rawLs, used for incremental check). */
export interface SourceRow {
  filename: string;
  sha256: string;
  size: number;
  status: SourceStatus;
  created_at: string;
  updated_at: string;
  last_modified_by: string | null;
  ingested_at: string | null;
  ingest_error: string | null;
}

/** Calculates content SHA-256 (incremental check and source registration share the same sha). */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * rawWrite registers source (Design §3.4, query then update, not blind UPSERT). Must be called within withWriteDb transaction.
 * - New file → INSERT, status=uploaded, last_modified_by=creator;
 * - sha changed → UPDATE, **preserves created_at**, resets uploaded, logs last modifier, clears ingest_error;
 * - sha unchanged → Idempotent, no-op (re-uploading identical content, Option a).
 */
export function upsertSource(
  db: Database.Database,
  entry: { filename: string; sha256: string; size: number; userId?: string | null },
): "created" | "updated" | "unchanged" {
  const now = new Date().toISOString();
  const old = db.prepare("SELECT sha256 FROM source WHERE filename = ?").get(entry.filename) as
    | { sha256: string }
    | undefined;
  if (!old) {
    db.prepare(
      `INSERT INTO source(filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error)
       VALUES (?, ?, ?, 'uploaded', ?, ?, ?, NULL, NULL)`,
    ).run(entry.filename, entry.sha256, entry.size, now, now, entry.userId ?? null);
    return "created";
  }
  if (old.sha256 !== entry.sha256) {
    db.prepare(
      `UPDATE source SET sha256 = ?, size = ?, status = 'uploaded', updated_at = ?, last_modified_by = ?, ingest_error = NULL
       WHERE filename = ?`,
    ).run(entry.sha256, entry.size, now, entry.userId ?? null, entry.filename);
    return "updated";
  }
  return "unchanged";
}

/** Reads all source rows (rawLs), sorted by filename. */
export function listSources(db: Database.Database): SourceRow[] {
  return db
    .prepare(
      `SELECT filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error
       FROM source ORDER BY filename`,
    )
    .all() as SourceRow[];
}

/** Reads filename → {sha256, status} mapping (used for incremental check). */
export function readSourceStates(
  db: Database.Database,
): Map<string, { sha256: string; status: SourceStatus }> {
  const rows = db.prepare("SELECT filename, sha256, status FROM source").all() as Array<{
    filename: string;
    sha256: string;
    status: SourceStatus;
  }>;
  const m = new Map<string, { sha256: string; status: SourceStatus }>();
  for (const r of rows) m.set(r.filename, { sha256: r.sha256, status: r.status });
  return m;
}

/** Deletes source rows (rawRm / file disappeared during ingest). Called within transaction. */
export function deleteSources(db: Database.Database, filenames: string[]): void {
  if (filenames.length === 0) return;
  const stmt = db.prepare("DELETE FROM source WHERE filename = ?");
  for (const fn of filenames) stmt.run(fn);
}

/**
 * Registers extraction results for a single source post-ingest (Design §3.6 step 6, called within same transaction as index rebuild).
 * - Existing row: updates status/ingested_at/ingest_error only, **does not modify** created_at/updated_at/sha256/size
 *   (sha maintained by rawWrite, content unchanged; updated_at represents "content change", extraction is not content change);
 * - Missing row (source file lands on disk directly without rawWrite): INSERT using disk current values (created_at=updated_at=now).
 * ok=true → ingested + ingested_at; ok=false → failed + ingest_error.
 */
export function recordSourceIngestResult(
  db: Database.Database,
  entry: { filename: string; sha256: string; size: number; ok: boolean; error?: string | null },
): void {
  const now = new Date().toISOString();
  const status: SourceStatus = entry.ok ? "ingested" : "failed";
  const ingestedAt = entry.ok ? now : null;
  const ingestError = entry.ok ? null : (entry.error ?? "unknown").slice(0, 500);
  const exists = db.prepare("SELECT 1 FROM source WHERE filename = ?").get(entry.filename);
  if (exists) {
    db.prepare(
      "UPDATE source SET status = ?, ingested_at = ?, ingest_error = ? WHERE filename = ?",
    ).run(status, ingestedAt, ingestError, entry.filename);
  } else {
    db.prepare(
      `INSERT INTO source(filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(entry.filename, entry.sha256, entry.size, status, now, now, ingestedAt, ingestError);
  }
}

/**
 * Incremental classification (Design §3.6 step 3, pure function for unit testing ease):
 * Compares "disk source files" with "source table last state" to determine destination of each file.
 * - toIngest: New || extraction failed (status≠ingested, including uploaded/failed) || sha changed → needs extraction;
 * - skipped : status=ingested and sha unchanged → skip LLM (saves tokens);
 * - deleted : present in table but missing on disk → pending cascade delete + delete source row.
 */
export function classifySources(
  disk: Array<{ filename: string; sha256: string }>,
  oldStates: Map<string, { sha256: string; status: SourceStatus }>,
): { toIngest: string[]; skipped: string[]; deleted: string[] } {
  const diskNames = new Set(disk.map((d) => d.filename));
  const deleted = [...oldStates.keys()].filter((fn) => !diskNames.has(fn));
  const toIngest: string[] = [];
  const skipped: string[] = [];
  for (const d of disk) {
    const prev = oldStates.get(d.filename);
    if (!prev || prev.status !== "ingested" || prev.sha256 !== d.sha256) toIngest.push(d.filename);
    else skipped.push(d.filename);
  }
  return { toIngest, skipped, deleted };
}
