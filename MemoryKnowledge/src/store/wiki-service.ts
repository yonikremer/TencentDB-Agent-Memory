/**
 * WikiService — Asynchronous orchestration for wiki assets (symmetric with CodeGraphService).
 *
 * IKnowledgeStore (metadata/status) + BuildQueue (background serialization) + injectable worker
 * (actual ingest / index building). State machine: pending → processing(scanning/ingesting)
 * → ready / failed(+sync_error). memory + team isolation, idempotency (returns existing row for identical memory+team+name),
 * soft delete + directory cleanup. Physical directory: {dataRoot}/{service_id}/{team_id}/{wiki_id}/ (001 multi-tenancy).
 *
 * File layer (doc 11 spec): raw / page each has a set of ls/read/write/rm, aligned with L2 Scenario.
 * - raw/* operates only on raw/sources/ and does not trigger ingest.
 * - page/* operates on wiki/; writes automatically inject frontmatter `locked: true`, and deletes invoke
 *   lib layer cascadeDeleteWikiPagesWithRefs for reference cascading.
 */

import { join, resolve, normalize } from "node:path";
import {
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

import type {
  AuditAction,
  IKnowledgeStore,
  WikiRow,
  ListOpts,
  CountOpts,
} from "./types.js";
import { BuildQueue } from "./build-queue.js";
import {
  initIndexDb,
  withWriteDb,
  getReadDb,
  evictWikiDb,
  upsertSource,
  listSources,
  deleteSources,
  sha256,
  type SourceStatus,
} from "../engines/wiki/index-db.js";

export interface WikiBuildContext {
  wikiId: string;
  serviceId: string;
  teamId: string;
  name: string;
  dir: string;
  setInternalStatus: (s: string) => void;
  /** Single ingest run ID generation; shared by progress/final callbacks to prevent out-of-order Panel packets */
  ingestRunId: string;
}

export interface WikiBuildResult {
  pageCount?: number;
}

export type WikiWorker = (ctx: WikiBuildContext) => Promise<WikiBuildResult | void>;

/**
 * ingest result (discriminated union):
 *   - ok        Enqueued for rebuild;
 *   - not_found memory/team/id mismatch;
 *   - busy      Currently pending/processing (concurrency rejection, corresponds to HTTP 409), step is internal phase (nullable).
 */
export type IngestResult =
  | { kind: "ok"; row: WikiRow }
  | { kind: "not_found" }
  | { kind: "busy"; status: "pending" | "processing"; step: string | null };

export interface WikiServiceLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface WikiServiceOptions {
  store: IKnowledgeStore;
  dataRoot: string;
  worker: WikiWorker;
  queue?: BuildQueue;
  logger?: WikiServiceLogger;
  /** Callback config for TMC status notifications. Optional. */
  callbackConfig?: {
    tmcCallbackUrl: string;
    /** Per-instance LLM resolver for summary generation (keyed by service_id). */
    resolveLlm: (serviceId: string) => import("../config.js").LlmConfig;
  };
}

export interface CreateWikiParams {
  service_id: string;
  team_id: string;
  name: string;
  source_type?: string;
  source_url?: string;
  owner_user_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  visibility?: string;
  service_url?: string;
}

// ── File layer result types (aligned with OpenAPI YAML schema) ──

export interface RawFileEntry {
  filename: string;
  size: number;
  /** Source file lifecycle status (uploaded/ingested/failed, design 003). */
  status: SourceStatus;
  /** Initial upload timestamp (immutable thereafter). */
  created_at: string;
  /** Most recent content modification timestamp. */
  updated_at: string;
  /** Last modified by user_id (no historical audit stream). */
  last_modified_by: string | null;
  /** Most recent successful extraction timestamp (null if not extracted). */
  ingested_at: string | null;
  /** @deprecated Backward compatible field, equal to created_at. */
  uploaded_at: string;
}

export interface RawWriteResult {
  filename: string;
  size: number;
}

export interface RawReadItem {
  filename: string;
  content?: string;
  not_found?: boolean;
}

export interface RawWriteManyItem {
  filename: string;
  size: number;
}

export interface RawRmResult {
  deleted_files: string[];
  deleted_pages: string[];
  rewritten_pages: number;
}

export interface PageWriteResult {
  ref: string;
  locked_injected: boolean;
}

export interface PageReadItem {
  ref: string;
  content?: string;
  not_found?: boolean;
}

export interface PageWriteManyItem {
  ref: string;
  locked_injected: boolean;
}

export interface PageRmResult {
  deleted_pages: string[];
  rewritten_files: number;
}

/**
 * Return wrapper for write operations:
 * - `null`: wiki does not exist or does not belong to memory/team
 * - `"processing"`: wiki is currently in processing state, rejecting write
 * - `"invalid_path"`: path traversal check failed
 * - `"forbidden_path"`: writing to forbidden paths such as structural files
 * - `"too_large"`: exceeds size limit
 * - Otherwise: actual result object
 */
export type WriteOutcome<T> =
  | T
  | null
  | "processing"
  | "invalid_path"
  | "forbidden_path"
  | "too_large";

const PAGE_WRITE_MAX_BYTES = 512 * 1024;
const RAW_WRITE_MAX_BYTES = 5 * 1024 * 1024;
const PAGE_RM_MAX = 20;
const RAW_RM_MAX = 50;
const RAW_READ_MAX = 50;
const RAW_WRITE_MAX = 50;
const PAGE_READ_MAX = 20;
const PAGE_WRITE_MAX = 20;

/** Structural files under wiki/ that page/write and page/rm are forbidden to touch (including with .md stripped). */
const PAGE_FORBIDDEN_REFS = new Set([
  "index",
  "schema",
  "purpose",
  "wiki/index",
  "wiki/schema",
  "wiki/purpose",
]);

export class WikiService {
  private readonly store: IKnowledgeStore;
  private readonly dataRoot: string;
  private readonly worker: WikiWorker;
  private readonly queue: BuildQueue;
  private readonly logger?: WikiServiceLogger;
  private readonly callbackConfig?: {
    tmcCallbackUrl: string;
    resolveLlm: (serviceId: string) => import("../config.js").LlmConfig;
  };
  /**
   * In-flight delete flag: set when delete hits a wiki that is queued or executing,
   * read by worker at checkpoints to decide aborting. In-memory state only (same id serialized by SerialQueue +
   * Node single thread, read/write has no concurrency). Removed after cleanup finishes.
   */
  private readonly cancelled = new Set<string>();

  constructor(opts: WikiServiceOptions) {
    this.store = opts.store;
    this.dataRoot = opts.dataRoot;
    this.worker = opts.worker;
    this.queue = opts.queue ?? new BuildQueue();
    this.logger = opts.logger;
    this.callbackConfig = opts.callbackConfig;
  }

  dirFor(serviceId: string, teamId: string, wikiId: string): string {
    return join(this.dataRoot, serviceId, teamId, wikiId);
  }

  /**
   * Creates wiki metadata + directory shell. **Does NOT automatically ingest**.
   * Idempotent: returns existing row for identical (service_id, team_id, name).
   */
  create(params: CreateWikiParams): { row: WikiRow; existed: boolean } {
    const { row, existed } = this.store.createWiki(params);
    if (!existed) {
      const dir = this.dirFor(row.service_id, row.team_id, row.wiki_id);
      mkdirSync(join(dir, "raw", "sources"), { recursive: true });
      // Explicitly create index.db (4 tables including source) — rawWrite/rawLs directly read/write source table thereafter (design 006/003).
      try {
        initIndexDb(dir);
      } catch (err) {
        this.logger?.warn?.(`[wiki] initIndexDb failed for ${row.wiki_id}: ${String(err)}`);
      }
      this.audit(row, "create", `create wiki ${row.name}`, params.user_id);
    }
    return { row, existed };
  }

  /** Persist service_url for a wiki. Returns updated row or null. */
  updateServiceUrl(serviceId: string, wikiId: string, serviceUrl: string): WikiRow | null {
    this.store.updateWikiStatus(serviceId, wikiId, { service_url: serviceUrl });
    return this.store.getWikiById(serviceId, wikiId);
  }

  /** Update wiki metadata (name, summary). Returns updated row or null. */
  updateMeta(serviceId: string, wikiId: string, patch: { name?: string; summary?: string | null }): WikiRow | null {
    return this.store.updateWikiMeta(serviceId, wikiId, patch);
  }

  /**
   * Explicitly triggers ingest (LLM processing raw → page + building index).
   * Returns immediately, executes asynchronously in background. Returns not_found on memory/team mismatch; returns busy on pending/processing.
   */
  ingest(serviceId: string, teamId: string, wikiId: string, requesterUserId?: string): IngestResult {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return { kind: "not_found" };
    // Concurrency rejection: rejects directly if queued/executing without overwriting status, re-enqueuing, or writing audit.
    if (row.status === "pending" || row.status === "processing") {
      return { kind: "busy", status: row.status, step: row.internal_status };
    }
    const nextVersion = row.version + 1;
    this.store.updateWikiStatus(serviceId, wikiId, {
      status: "pending",
      internal_status: null,
      sync_error: null,
      version: nextVersion,
    });
    this.audit({ ...row, version: nextVersion }, "ingest", "manual ingest", requesterUserId);
    const fresh = this.store.getWiki(serviceId, teamId, wikiId);
    if (fresh) this.enqueueBuild(fresh);
    return fresh ? { kind: "ok", row: fresh } : { kind: "not_found" };
  }

  /** sync semantics = re-running ingest (control plane explicit trigger). */
  sync(serviceId: string, teamId: string, wikiId: string, requesterUserId?: string): IngestResult {
    return this.ingest(serviceId, teamId, wikiId, requesterUserId);
  }

  get(serviceId: string, teamId: string, wikiId: string): WikiRow | null {
    return this.store.getWiki(serviceId, teamId, wikiId);
  }

  /** Queries by globally unique wiki_id (still scoped by service_id to prevent cross-tenant access). Dedicated for spec id-only endpoints. */
  getById(serviceId: string, wikiId: string): WikiRow | null {
    return this.store.getWikiById(serviceId, wikiId);
  }

  list(serviceId: string, teamId: string, opts?: ListOpts): WikiRow[] {
    return this.store.listWikis(serviceId, teamId, opts);
  }

  count(serviceId: string, teamId: string, opts?: CountOpts): number {
    return this.store.countWikis(serviceId, teamId, opts);
  }

  /**
   * Deletes wiki (008 / 007 §5.5). Deletable under any status (including pending/processing).
   * Returns false on memory/team mismatch; otherwise hard deletes + four resource cleanups, returning true.
   *
   * If resource is currently queued/executing, sets cancelled flag first to notify worker to abort at checkpoint; then immediately
   * hard deletes + cleans up (does not wait for worker). If worker re-checks before ending and finds deleted state, it skips ready/callback and performs
   * idempotent cleanup once more with no leftovers.
   */
  delete(serviceId: string, teamId: string, wikiId: string): boolean {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return false;

    if (row.status === "pending" || row.status === "processing") {
      this.cancelled.add(wikiId);
    }

    this.audit(row, "delete", null);
    this.cleanupResources(serviceId, teamId, wikiId);
    // Do not delete cancelled flag here (covers window where delete is prior to worker checkpoint);
    // removed by finishCancelled when worker ends. Cleanup is idempotent, repeated calls are harmless.
    return true;
  }

  /**
   * Four resource types idempotent cleanup (order: release connections first, then delete disk). Each step has independent try/catch for exception safety.
   *   1. index.db read pool: evictWikiDb (idempotent; worker withWriteDb finally already closes write connections)
   *   2. Metadata row: Hard delete (safe even matching 0 rows, supports worker + delete dual cleanup)
   *   3. Disk directory (wiki/ raw/ index.db and -wal/-shm): rmSync recursive+force (idempotent)
   * Queued tasks in BuildQueue are skipped by runBuild entry checking cancelled/row existence, no handling needed here.
   */
  private cleanupResources(serviceId: string, teamId: string, wikiId: string): void {
    try {
      evictWikiDb(wikiId);
    } catch (err) {
      this.logger?.warn?.(`[wiki] evict index.db failed ${wikiId}: ${String(err)}`);
    }
    try {
      this.store.deleteWiki(serviceId, teamId, wikiId);
    } catch (err) {
      this.logger?.warn?.(`[wiki] hard-delete row failed ${wikiId}: ${String(err)}`);
    }
    try {
      rmSync(this.dirFor(serviceId, teamId, wikiId), { recursive: true, force: true });
    } catch (err) {
      this.logger?.warn?.(`[wiki] rm dir failed ${wikiId}: ${String(err)}`);
    }
  }

  /**
   * Worker checkpoint: whether wiki has been deleted (cancelled flag hit, or row no longer in DB).
   * Covered by dual criteria to handle both delete-during-run and delete-already-done orderings.
   */
  private isDeleted(serviceId: string, wikiId: string): boolean {
    return this.cancelled.has(wikiId) || this.store.getWikiById(serviceId, wikiId) === null;
  }

  /**
   * Finalization after worker checkpoint determines "deleted": idempotently cleans up disk/connections worker may have just written,
   * and removes cancelled flag.
   */
  private finishCancelled(serviceId: string, teamId: string, wikiId: string): void {
    this.cleanupResources(serviceId, teamId, wikiId);
    this.cancelled.delete(wikiId);
    this.logger?.info?.(`[wiki] ${wikiId} build aborted (deleted during processing)`);
  }

  /** Writes a wiki audit record. Failure does not block main flow. */
  private audit(row: WikiRow, action: AuditAction, detail: string | null, requesterUserId?: string): void {
    try {
      this.store.appendWikiAudit({
        service_id: row.service_id,
        asset_id: row.wiki_id,
        version: row.version,
        action,
        // Prefer recording trigger user (initiator of ingest/create), falling back to creator on row.
        user_id: requesterUserId ?? row.user_id,
        agent_id: row.agent_id,
        detail,
      });
    } catch (err) {
      this.logger?.warn?.(`[wiki] audit ${action} failed: ${String(err)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // File layer — raw/* (sources under raw/sources/)
  // ═══════════════════════════════════════════════════════════════════

  /** Lists source files under raw/sources/ (queries source table, design 003 §3.5). Returns null if wiki does not exist. */
  rawLs(serviceId: string, teamId: string, wikiId: string): RawFileEntry[] | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    const dir = this.dirFor(serviceId, teamId, wikiId);
    try {
      const db = getReadDb(wikiId, dir);
      return listSources(db).map((s) => ({
        filename: s.filename,
        size: s.size,
        status: s.status,
        created_at: s.created_at,
        updated_at: s.updated_at,
        last_modified_by: s.last_modified_by,
        ingested_at: s.ingested_at,
        uploaded_at: s.created_at, // Backward compatible field
      }));
    } catch {
      // index.db not created yet (legacy wiki / never rawWrite) → no source registration.
      return [];
    }
  }

  /** Reads content of a single raw file. Returns null if file does not exist (including wiki not found). */
  rawRead(serviceId: string, teamId: string, wikiId: string, filename: string): string | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    const safe = this.resolveRawPath(sourcesDir, filename);
    if (!safe) return null;
    try {
      return readFileSync(safe, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Batch reads raw files.
   * - wiki does not exist → null
   * - Any filename path traversal → "invalid_path"
   * - Exceeding RAW_READ_MAX → Throws error (router converts to 400)
   * Missing individual files do not trigger errors; corresponding item is marked not_found:true (spec: overall still 200).
   */
  rawReadMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    filenames: string[],
  ): WriteOutcome<RawReadItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (filenames.length > RAW_READ_MAX) {
      throw new Error(`filenames exceeds max ${RAW_READ_MAX}`);
    }
    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    // Validate path legality for all items first (any invalid item fails entire batch with 400)
    const safePaths: string[] = [];
    for (const fn of filenames) {
      const safe = this.resolveRawPath(sourcesDir, fn);
      if (!safe) return "invalid_path";
      safePaths.push(safe);
    }
    const items: RawReadItem[] = [];
    for (let i = 0; i < filenames.length; i++) {
      const filename = filenames[i];
      try {
        const content = readFileSync(safePaths[i], "utf-8");
        items.push({ filename, content });
      } catch {
        items.push({ filename, not_found: true });
      }
    }
    return items;
  }

  /**
   * Writes/overwrites a single raw file (upsert) + registers in source table (design 003 §3.4).
   * - wiki does not exist → null
   * - In processing state → "processing"
   * - Path traversal → "invalid_path"
   * - Exceeds 5MB → "too_large"
   */
  rawWrite(
    serviceId: string,
    teamId: string,
    wikiId: string,
    filename: string,
    content: string,
    userId?: string,
  ): WriteOutcome<RawWriteResult> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";

    const size = Buffer.byteLength(content, "utf-8");
    if (size > RAW_WRITE_MAX_BYTES) return "too_large";

    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    const safe = this.resolveRawPath(sourcesDir, filename);
    if (!safe) return "invalid_path";

    mkdirSync(sourcesDir, { recursive: true });
    writeFileSync(safe, content, "utf-8");
    this.registerSources(serviceId, teamId, wikiId, [{ filename, content, size }], userId);
    return { filename, size };
  }

  /**
   * Batch writes raw files (atomic batch).
   * - Validate all items first: path traversal → "invalid_path"; any item exceeding 5MB → "too_large"
   * - After all checks pass, write file by file to disk; if any write fails, rollback previously written files (removing newly created ones not originally present), ensuring all-or-nothing atomicity.
   * Error codes match rawWrite.
   */
  rawWriteMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    files: { filename: string; content: string }[],
    userId?: string,
  ): WriteOutcome<RawWriteManyItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (files.length > RAW_WRITE_MAX) {
      throw new Error(`files exceeds max ${RAW_WRITE_MAX}`);
    }

    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    type Plan = {
      filename: string;
      safePath: string;
      content: string;
      size: number;
      preExistingContent: string | null; // Record pre-existing content before writing for rollback restoration
    };
    const plans: Plan[] = [];
    for (const { filename, content } of files) {
      if (typeof content !== "string") return "invalid_path";
      const size = Buffer.byteLength(content, "utf-8");
      if (size > RAW_WRITE_MAX_BYTES) return "too_large";
      const safe = this.resolveRawPath(sourcesDir, filename);
      if (!safe) return "invalid_path";
      let pre: string | null = null;
      try {
        pre = readFileSync(safe, "utf-8");
      } catch {
        pre = null;
      }
      plans.push({ filename, safePath: safe, content, size, preExistingContent: pre });
    }

    mkdirSync(sourcesDir, { recursive: true });
    const written: Plan[] = [];
    try {
      for (const p of plans) {
        writeFileSync(p.safePath, p.content, "utf-8");
        written.push(p);
      }
    } catch (err) {
      // Rollback: restore previous content of each written file (delete if didn't exist originally)
      for (const p of written) {
        try {
          if (p.preExistingContent === null) {
            rmSync(p.safePath, { force: true });
          } else {
            writeFileSync(p.safePath, p.preExistingContent, "utf-8");
          }
        } catch {
          // If rollback also fails, log and rely on caller re-running ingest as fallback
        }
      }
      throw err;
    }

    // Register source table after all writes succeed (queries first then updates; idempotent if sha unchanged).
    this.registerSources(
      serviceId,
      teamId,
      wikiId,
      plans.map((p) => ({ filename: p.filename, content: p.content, size: p.size })),
      userId,
    );
    return plans.map(({ filename, size }) => ({ filename, size }));
  }

  /**
   * Batch deletes raw files + cascade cleans up downstream pages.
   * Invokes lib layer deleteSourceFiles, which determines page fate internally.
   * - wiki does not exist → null
   * - processing → "processing"
   * - filenames contain path traversal → "invalid_path"
   * - Exceeding 50 → Throws error (router converts to 400)
   */
  async rawRm(
    serviceId: string,
    teamId: string,
    wikiId: string,
    filenames: string[],
  ): Promise<WriteOutcome<RawRmResult>> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (filenames.length > RAW_RM_MAX) {
      throw new Error(`filenames exceeds max ${RAW_RM_MAX}`);
    }

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const sourcesDir = join(projectPath, "raw", "sources");
    const fullPaths: string[] = [];
    for (const fn of filenames) {
      const safe = this.resolveRawPath(sourcesDir, fn);
      if (!safe) return "invalid_path";
      fullPaths.push(safe);
    }

    // Cascade delete: deletes raw source and cleans up pages referencing it (driven by frontmatter sources).
    const { deleteSourceFiles } = await import(
      "../engines/wiki/ingest-v2/cascade.js"
    );
    const result = await deleteSourceFiles(projectPath, fullPaths, {
      logReason: "wiki/raw/rm",
    });

    // Delete corresponding source rows (corresponds to file cascade delete, design 003 §5).
    try {
      initIndexDb(projectPath);
      withWriteDb(projectPath, (db) => deleteSources(db, filenames));
    } catch (err) {
      this.logger?.warn?.(`[wiki] source rows delete failed: ${String(err)}`);
    }

    return {
      deleted_files: filenames,
      deleted_pages: result.deletedWikiPaths.map((p: string) =>
        this.absToPageRef(projectPath, p),
      ),
      rewritten_pages: result.rewrittenSourcePages,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // File layer — page/* (processed pages under wiki/)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Lists page files under wiki/ (recursively scans .md to extract frontmatter).
   * Returns empty array when status !== "ready".
   */
  pageLs(serviceId: string, teamId: string, wikiId: string): { id: string; title: string; type: string; path: string; description?: string; locked?: boolean }[] | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status !== "ready") return [];

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const wikiDir = join(projectPath, "wiki");
    if (!existsSync(wikiDir)) return [];

    const items: { id: string; title: string; type: string; path: string; description?: string; locked?: boolean }[] = [];
    this.scanPagesRecursive(wikiDir, wikiDir, items);
    return items;
  }

  /** Reads raw content of a single page. ref can be page id or relPath. */
  pageRead(serviceId: string, teamId: string, wikiId: string, ref: string): string | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const safe = this.resolvePageRef(projectPath, ref);
    if (!safe) return null;
    try {
      return readFileSync(safe, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Batch reads page raw content.
   * - wiki does not exist → null
   * - Any ref path traversal → "invalid_path"
   * - Exceeding PAGE_READ_MAX → Throws error
   * Missing individual refs do not trigger errors; corresponding item is marked not_found:true (spec: overall still 200).
   */
  pageReadMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    refs: string[],
  ): WriteOutcome<PageReadItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (refs.length > PAGE_READ_MAX) {
      throw new Error(`refs exceeds max ${PAGE_READ_MAX}`);
    }
    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const safePaths: string[] = [];
    for (const r of refs) {
      // Using allowMissing for read is insufficient — not_found must also be a legal path, so here we
      // distinguish "path legal but file does not exist (not_found)" from "path illegal (invalid_path)"
      const safe = this.resolvePageRef(projectPath, r, { allowMissing: true });
      if (!safe) return "invalid_path";
      safePaths.push(safe);
    }
    const items: PageReadItem[] = [];
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      try {
        const content = readFileSync(safePaths[i], "utf-8");
        items.push({ ref, content });
      } catch {
        items.push({ ref, not_found: true });
      }
    }
    return items;
  }

  /**
   * Writes/overwrites a single page (upsert). Automatically injects `locked: true` in frontmatter.
   * - wiki does not exist → null
   * - processing → "processing"
   * - Path traversal → "invalid_path"
   * - Structural file → "forbidden_path"
   * - Exceeds 512KB → "too_large"
   */
  pageWrite(
    serviceId: string,
    teamId: string,
    wikiId: string,
    ref: string,
    content: string,
  ): WriteOutcome<PageWriteResult> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";

    const size = Buffer.byteLength(content, "utf-8");
    if (size > PAGE_WRITE_MAX_BYTES) return "too_large";

    if (this.isForbiddenPageRef(ref)) return "forbidden_path";

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const safe = this.resolvePageRef(projectPath, ref, { allowMissing: true });
    if (!safe) return "invalid_path";

    const { content: finalContent, lockedInjected } = injectLockedTrue(content);

    mkdirSync(join(safe, ".."), { recursive: true });
    writeFileSync(safe, finalContent, "utf-8");
    return { ref, locked_injected: lockedInjected };
  }

  /**
   * Batch writes pages (atomic batch). Automatically injects `locked: true` in frontmatter for each item.
   * - Validate all first: processing → "processing"; path traversal → "invalid_path";
   *   structural file → "forbidden_path"; exceeds 512KB → "too_large"
   * - After all checks pass, write file by file to disk; if any fails, rollback written files.
   */
  pageWriteMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    pages: { ref: string; content: string }[],
  ): WriteOutcome<PageWriteManyItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (pages.length > PAGE_WRITE_MAX) {
      throw new Error(`pages exceeds max ${PAGE_WRITE_MAX}`);
    }

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    type Plan = {
      ref: string;
      safePath: string;
      finalContent: string;
      lockedInjected: boolean;
      preExistingContent: string | null;
    };
    const plans: Plan[] = [];
    for (const { ref, content } of pages) {
      if (typeof content !== "string") return "invalid_path";
      if (this.isForbiddenPageRef(ref)) return "forbidden_path";
      const size = Buffer.byteLength(content, "utf-8");
      if (size > PAGE_WRITE_MAX_BYTES) return "too_large";
      const safe = this.resolvePageRef(projectPath, ref, { allowMissing: true });
      if (!safe) return "invalid_path";
      const { content: finalContent, lockedInjected } = injectLockedTrue(content);
      let pre: string | null = null;
      try {
        pre = readFileSync(safe, "utf-8");
      } catch {
        pre = null;
      }
      plans.push({ ref, safePath: safe, finalContent, lockedInjected, preExistingContent: pre });
    }

    const written: Plan[] = [];
    try {
      for (const p of plans) {
        mkdirSync(join(p.safePath, ".."), { recursive: true });
        writeFileSync(p.safePath, p.finalContent, "utf-8");
        written.push(p);
      }
    } catch (err) {
      for (const p of written) {
        try {
          if (p.preExistingContent === null) {
            rmSync(p.safePath, { force: true });
          } else {
            writeFileSync(p.safePath, p.preExistingContent, "utf-8");
          }
        } catch {
          // best-effort rollback
        }
      }
      throw err;
    }

    return plans.map(({ ref, lockedInjected }) => ({ ref, locked_injected: lockedInjected }));
  }

  /**
   * Batch deletes pages + cascade cleans up references. Invokes lib layer cascadeDeleteWikiPagesWithRefs.
   * - wiki does not exist → null
   * - processing → "processing"
   * - Contains path traversal → "invalid_path"
   * - Contains structural file → "forbidden_path"
   * - Exceeds 20 → Throws error
   */
  async pageRm(
    serviceId: string,
    teamId: string,
    wikiId: string,
    refs: string[],
  ): Promise<WriteOutcome<PageRmResult>> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (refs.length > PAGE_RM_MAX) {
      throw new Error(`refs exceeds max ${PAGE_RM_MAX}`);
    }

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const fullPaths: string[] = [];
    for (const r of refs) {
      if (this.isForbiddenPageRef(r)) return "forbidden_path";
      const safe = this.resolvePageRef(projectPath, r);
      if (!safe) return "invalid_path";
      fullPaths.push(safe);
    }

    const { cascadeDeleteWikiPagesWithRefs } = await import(
      "../engines/wiki/ingest-v2/cascade.js"
    );
    const result = await cascadeDeleteWikiPagesWithRefs(projectPath, fullPaths);

    return {
      deleted_pages: result.deletedPaths.map((p: string) =>
        this.absToPageRef(projectPath, p),
      ),
      rewritten_files: result.rewrittenFiles,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Registers a batch of source files in source table (used by rawWrite/rawWriteMany).
   * Ensures index.db exists (idempotent initIndexDb), calls upsertSource for each file in a write transaction
   * (queries first then updates: new file set to uploaded / sha changed resets to uploaded / sha unchanged is idempotent).
   * Registration failure does not block main disk write flow (file already on disk) — logs warn and relies on subsequent ingest/rawLs fallback.
   */
  private registerSources(
    serviceId: string,
    teamId: string,
    wikiId: string,
    files: { filename: string; content: string; size: number }[],
    userId?: string,
  ): void {
    const dir = this.dirFor(serviceId, teamId, wikiId);
    try {
      initIndexDb(dir);
      withWriteDb(dir, (db) => {
        for (const f of files) {
          upsertSource(db, {
            filename: f.filename,
            sha256: sha256(f.content),
            size: f.size,
            userId: userId ?? null,
          });
        }
      });
    } catch (err) {
      this.logger?.warn?.(`[wiki] source register failed for ${wikiId}: ${String(err)}`);
    }
  }

  private resolveRawPath(sourcesDir: string, filename: string): string | null {
    if (!filename || filename.includes("..") || filename.startsWith("/")) return null;
    const normalized = normalize(filename);
    if (normalized.startsWith("..") || normalized.startsWith("/")) return null;
    // Convert resolve(sourcesDir) to absolute path to avoid comparison failure when sourcesDir is relative
    // (such as KNOWLEDGE_DATA_DIR=./data).
    const base = resolve(sourcesDir);
    const safe = resolve(base, normalized);
    const dirWithSep = base.endsWith("/") ? base : base + "/";
    if (safe !== base && !safe.startsWith(dirWithSep)) return null;
    return safe;
  }

  /**
   * Resolves page ref (id or relPath) → absolute path. Must reside under wiki/ subtree.
   * - allowMissing=true used for write, allows path not existing yet
   * - allowMissing=false used for read/rm, requires file to already exist
   */
  private resolvePageRef(
    projectPath: string,
    ref: string,
    opts: { allowMissing?: boolean } = {},
  ): string | null {
    if (!ref || ref.includes("..") || ref.startsWith("/")) return null;
    const cleanRef = ref.replace(/^wiki\//, "");
    if (cleanRef.includes("..")) return null;

    // Resolve into absolute path to prevent comparison failure when projectPath is relative.
    const wikiDir = resolve(projectPath, "wiki");
    const wikiDirSep = wikiDir.endsWith("/") ? wikiDir : wikiDir + "/";

    // Try original name first, then try appending .md extension.
    const candidates = cleanRef.endsWith(".md") ? [cleanRef] : [cleanRef + ".md", cleanRef];
    for (const c of candidates) {
      const safe = resolve(wikiDir, c);
      if (safe !== wikiDir && !safe.startsWith(wikiDirSep)) continue;
      if (opts.allowMissing) {
        // write path append .md: allow either candidate
        return c.endsWith(".md") ? safe : null;
      }
      if (existsSync(safe)) return safe;
    }
    if (opts.allowMissing) {
      // When no .md candidate matches, force appending .md
      const safe = resolve(wikiDir, cleanRef.endsWith(".md") ? cleanRef : cleanRef + ".md");
      if (safe === wikiDir || !safe.startsWith(wikiDirSep)) return null;
      return safe;
    }
    return null;
  }

  /** Converts wiki/.../page.md absolute path back to ref (e.g. "concepts/redis"). */
  private absToPageRef(projectPath: string, abs: string): string {
    const wikiDir = resolve(projectPath, "wiki");
    const prefix = wikiDir.endsWith("/") ? wikiDir : wikiDir + "/";
    if (!abs.startsWith(prefix)) return abs;
    return abs.slice(prefix.length).replace(/\.md$/, "");
  }

  private isForbiddenPageRef(ref: string): boolean {
    const cleanRef = ref.replace(/^wiki\//, "").replace(/\.md$/, "");
    return PAGE_FORBIDDEN_REFS.has(cleanRef) || PAGE_FORBIDDEN_REFS.has(`wiki/${cleanRef}`);
  }

  private scanPagesRecursive(
    baseDir: string,
    dir: string,
    out: { id: string; title: string; type: string; path: string; description?: string; locked?: boolean }[],
  ): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry === "media") continue;
        this.scanPagesRecursive(baseDir, full, out);
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      let content = "";
      try {
        content = readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      const rel = full.slice(baseDir.length + 1).replace(/\\/g, "/");
      const id = rel.replace(/\.md$/, "");
      const fm = parseFrontmatterMin(content);
      out.push({
        id,
        title: fm.title || entry.replace(/\.md$/, "").replace(/-/g, " "),
        type: fm.type || "other",
        path: `wiki/${rel}`,
        ...(fm.description ? { description: fm.description } : {}),
        locked: fm.locked,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════

  private enqueueBuild(row: WikiRow): void {
    this.queue.enqueue(row.wiki_id, () => this.runBuild(row.service_id, row.wiki_id, row.team_id, row.name));
  }

  private async runBuild(serviceId: string, wikiId: string, teamId: string, name: string): Promise<void> {
    // Entry checkpoint: deleted during pending → skips, does not set processing or ingest.
    if (this.isDeleted(serviceId, wikiId)) {
      this.finishCancelled(serviceId, teamId, wikiId);
      return;
    }
    this.store.updateWikiStatus(serviceId, wikiId, {
      status: "processing",
      internal_status: "scanning",
      sync_error: null,
    });
    // Progress/final callbacks share same run ID generation, Panel can reject late progress packets after clear
    const ingestRunId = randomUUID();
    try {
      const result = await this.worker({
        wikiId,
        serviceId,
        teamId,
        name,
        dir: this.dirFor(serviceId, teamId, wikiId),
        setInternalStatus: (s) =>
          this.store.updateWikiStatus(serviceId, wikiId, { status: "processing", internal_status: s }),
        ingestRunId,
      });
      // Completion checkpoint: deleted during processing → skips ready/audit/callback, performs idempotent cleanup.
      if (this.isDeleted(serviceId, wikiId)) {
        this.finishCancelled(serviceId, teamId, wikiId);
        return;
      }
      this.store.updateWikiStatus(serviceId, wikiId, {
        status: "ready",
        internal_status: null,
        sync_error: null,
        page_count: result?.pageCount ?? null,
        last_sync_at: new Date().toISOString(),
      });
      const synced = this.store.getWikiById(serviceId, wikiId);
      if (synced) {
        this.audit(synced, "ready", result?.pageCount != null ? `pages: ${result.pageCount}` : null);
      }
      this.logger?.info?.(`[wiki] ${wikiId} ready (pages: ${result?.pageCount ?? '?'})`);

      // Auto-generate summary + callback TMC
      await this.onBuildComplete(synced, "ready", null, ingestRunId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Worker threw error, but if deleted in the interim, treat as cancellation rather than failure: skip failed status/callback, perform cleanup.
      if (this.isDeleted(serviceId, wikiId)) {
        this.finishCancelled(serviceId, teamId, wikiId);
        return;
      }
      this.store.updateWikiStatus(serviceId, wikiId, {
        status: "failed",
        internal_status: null,
        sync_error: msg.slice(0, 500),
      });
      const failed = this.store.getWikiById(serviceId, wikiId);
      if (failed) this.audit(failed, "failed", msg.slice(0, 500));
      this.logger?.warn?.(`[wiki] ${wikiId} failed: ${msg}`);

      // Callback TMC about failure
      await this.onBuildComplete(failed, "failed", msg, ingestRunId);
    }
  }

  /**
   * Post-build hook: generate summary (if synced) and callback TMC.
   * Never throws — runs after the main build is already committed.
   */
  private async onBuildComplete(
    row: WikiRow | null,
    status: "ready" | "failed",
    errorMsg: string | null,
    ingestRunId?: string,
  ): Promise<void> {
    if (!row || !this.callbackConfig) return;

    let summary: string | null = null;

    if (status === "ready") {
      // Generate summary via LLM (attempt generation even if some sources fail — as long as pages exist)
      try {
        const pages = this.pageLs(row.service_id, row.team_id, row.wiki_id) ?? [];
        this.logger?.info?.(`[wiki] summary generation start (wikiId=${row.wiki_id}, pages=${pages.length}, status=${status})`);
        const { generateWikiSummary } = await import("../callback.js");
        summary = await generateWikiSummary(
          row.wiki_id,
          row.name,
          pages.map((p) => ({ title: p.title, description: p.description })),
          this.callbackConfig.resolveLlm(row.service_id),
        );
        this.logger?.info?.(`[wiki] summary generation done (wikiId=${row.wiki_id}, len=${summary?.length ?? 0}, empty=${!summary})`);
        if (summary) {
          this.store.updateWikiStatus(row.service_id, row.wiki_id, { summary });
        }
      } catch (err) {
        this.logger?.warn?.(`[wiki] summary generation failed: ${String(err)}`);
      }
    }

    // Callback TMC
    const { callbackTMC } = await import("../callback.js");
    await callbackTMC(
      {
        knowledge_id: row.wiki_id,
        service_id: row.service_id,
        type: "wiki",
        status,
        summary,
        sync_error: errorMsg?.slice(0, 500) ?? null,
        timestamp: new Date().toISOString(),
        ...(ingestRunId ? { run_id: ingestRunId } : {}),
      },
      this.callbackConfig,
    );
  }

  async onIdle(wikiId?: string): Promise<void> {
    await this.queue.onIdle(wikiId);
  }
}

// ─── Module-level helpers (independent of class state, convenient for unit tests) ───

/** Minimal frontmatter parser (extracts title/type/description/locked), consistent style with manager. */
function parseFrontmatterMin(content: string): { title: string; type: string; description: string; locked: boolean } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : "";
  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const typeMatch = fm.match(/^type:\s*["']?(.+?)["']?\s*$/m);
  // description is written by ingest-v2 (see engines/wiki/ingest-v2/frontmatter.ts),
  // a one-sentence summary of the page — describes content better than title, used for generating wiki summary.
  const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  const lockedMatch = fm.match(/^locked:\s*(true|false)\s*$/m);
  return {
    title: titleMatch ? titleMatch[1].trim() : "",
    type: typeMatch ? typeMatch[1].trim().toLowerCase() : "",
    description: descMatch ? descMatch[1].trim() : "",
    locked: lockedMatch ? lockedMatch[1] === "true" : false,
  };
}

/**
 * Injects `locked: true` into frontmatter:
 * - Has frontmatter: if locked: field exists, force update to true; otherwise append line at end of frontmatter
 * - No frontmatter: wrap a frontmatter block (containing only locked: true) at top of file
 *
 * Returns { content, lockedInjected }; lockedInjected indicates whether locked field was actually added/modified
 * this time (if already true, lockedInjected=false because no change occurred).
 */
function injectLockedTrue(content: string): { content: string; lockedInjected: boolean } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) {
    const wrapped = `---\nlocked: true\n---\n${content.startsWith("\n") ? content.slice(1) : content}`;
    return { content: wrapped, lockedInjected: true };
  }
  const fmBody = fmMatch[1];
  const lockedMatch = fmBody.match(/^locked:\s*(true|false)\s*$/m);
  if (lockedMatch) {
    if (lockedMatch[1] === "true") return { content, lockedInjected: false };
    const newFmBody = fmBody.replace(/^locked:\s*(true|false)\s*$/m, "locked: true");
    return {
      content: content.replace(fmBody, newFmBody),
      lockedInjected: true,
    };
  }
  const newFmBody = fmBody.endsWith("\n") ? `${fmBody}locked: true` : `${fmBody}\nlocked: true`;
  return {
    content: content.replace(fmBody, newFmBody),
    lockedInjected: true,
  };
}

export const __testing = { parseFrontmatterMin, injectLockedTrue };
