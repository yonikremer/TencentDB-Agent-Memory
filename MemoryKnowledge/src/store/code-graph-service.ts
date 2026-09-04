/**
 * CodeGraphService — Asynchronous orchestration for code-graph assets.
 *
 * Glues IKnowledgeStore (metadata/status) + BuildQueue (background serialization) + injectable
 * worker (actual git clone + codegraph index building) together to achieve:
 *   - create/sync returns immediately (fire-and-forget), control plane polls status;
 *   - State machine: pending → processing(cloning/indexing) → ready / failed(+sync_error);
 *   - memory + team isolation, idempotency (returns existing row for identical memory+team+repo+branch), hard delete + four resource cleanups.
 *
 * delete semantics (008 / 007 §5.5): Deletable under any status (including pending/processing).
 * Uses in-memory cancelled flag to signal in-flight worker abort (no DB write, no soft delete); worker checks
 * checkpoints before completion, skips ready/callback if deleted, and performs idempotent cleanup. Cleanup covers four resource types:
 * instance pool (memory) → metadata row (hard delete) → disk directory (rmSync), with step-by-step try/catch
 * ensuring failure in any step does not affect others (exception safe + idempotent). Remote metadata reporting is not implemented in this phase.
 *
 * worker injection facilitates unit testing (no real git/codegraph needed); production implementation is at router assembly.
 * Physical directory: {dataRoot}/{service_id}/{team_id}/{code_graph_id}/ (001 multi-tenancy).
 */

import { join } from "node:path";
import { rmSync } from "node:fs";

import type {
  AuditAction,
  CodeGraphRow,
  IKnowledgeStore,
  ListOpts,
  CountOpts,
} from "./types.js";
import { BuildQueue } from "./build-queue.js";

export interface CodeGraphBuildContext {
  codeGraphId: string;
  serviceId: string;
  teamId: string;
  repoUrl: string;
  branch: string;
  /** Local working directory for this asset (checkout + index location). */
  dir: string;
  /** Worker callable to update fine-grained internal status (cloning → indexing). */
  setInternalStatus: (s: string) => void;
}

export interface CodeGraphBuildResult {
  commitHash?: string;
  stats?: { files: number; nodes: number; edges: number };
}

export type CodeGraphWorker = (ctx: CodeGraphBuildContext) => Promise<CodeGraphBuildResult>;

/**
 * sync result (discriminated union):
 *   - ok        Enqueued for rebuild;
 *   - not_found memory/team/id mismatch;
 *   - busy      Currently pending/processing (concurrency rejection, corresponds to HTTP 409), step is internal phase (nullable).
 */
export type SyncResult =
  | { kind: "ok"; row: CodeGraphRow }
  | { kind: "not_found" }
  | { kind: "busy"; status: "pending" | "processing"; step: string | null };

export interface CodeGraphServiceLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CodeGraphServiceOptions {
  store: IKnowledgeStore;
  /** knowledge data root directory; asset directory = {dataRoot}/{service_id}/{team_id}/{code_graph_id}/. */
  dataRoot: string;
  worker: CodeGraphWorker;
  queue?: BuildQueue;
  logger?: CodeGraphServiceLogger;
  /** Callback config for TMC status notifications. Optional. */
  callbackConfig?: { tmcCallbackUrl: string };
  /**
   * Releases memory resources occupied by this code-graph (instance pool + close index handles).
   * Injected rather than depending directly on module, keeping store layer free of reverse dependencies on assembly layer. Idempotent: safe for repeated calls.
   * Provided by module.ts assembly (wraps instancePool.delete + closeIndex).
   */
  releaseInstance?: (codeGraphId: string) => void;
}

export interface CreateCodeGraphParams {
  service_id: string;
  team_id: string;
  repo_url: string;
  branch: string;
  repo_name?: string;
  owner_user_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  visibility?: string;
}

export class CodeGraphService {
  private readonly store: IKnowledgeStore;
  private readonly dataRoot: string;
  private readonly worker: CodeGraphWorker;
  private readonly queue: BuildQueue;
  private readonly logger?: CodeGraphServiceLogger;
  private readonly callbackConfig?: { tmcCallbackUrl: string };
  private readonly releaseInstance?: (codeGraphId: string) => void;
  /**
   * In-flight delete flag: set when delete hits a resource that is queued or executing,
   * read by worker at checkpoints to decide aborting. In-memory state only (same id serialized by SerialQueue +
   * Node single thread, read/write has no concurrency). Removed after cleanup finishes.
   */
  private readonly cancelled = new Set<string>();

  constructor(opts: CodeGraphServiceOptions) {
    this.store = opts.store;
    this.dataRoot = opts.dataRoot;
    this.worker = opts.worker;
    this.queue = opts.queue ?? new BuildQueue();
    this.logger = opts.logger;
    this.callbackConfig = opts.callbackConfig;
    this.releaseInstance = opts.releaseInstance;
  }

  dirFor(serviceId: string, teamId: string, codeGraphId: string): string {
    return join(this.dataRoot, serviceId, teamId, codeGraphId);
  }

  /**
   * Idempotent creation and async graph building.
   * - Already exists (same memory+team+repo+branch) → Returns existing row directly without rebuilding graph.
   * - New creation → Inserts row with pending status + background graph building.
   */
  create(params: CreateCodeGraphParams): { row: CodeGraphRow; existed: boolean } {
    const { row, existed } = this.store.createCodeGraph(params);
    if (!existed) {
      this.audit(row, "create", `clone ${row.repo_url}@${row.branch}`, params.user_id);
      this.enqueueBuild(row);
    }
    return { row, existed };
  }

  /** Persist service_url for a code-graph. Returns updated row or null. */
  updateServiceUrl(serviceId: string, codeGraphId: string, serviceUrl: string): CodeGraphRow | null {
    this.store.updateCodeGraphStatus(serviceId, codeGraphId, { service_url: serviceUrl });
    return this.store.getCodeGraphById(serviceId, codeGraphId);
  }

  /** Update code-graph metadata (repo_name, summary). Returns updated row or null. */
  updateMeta(serviceId: string, codeGraphId: string, patch: { repo_name?: string; summary?: string | null }): CodeGraphRow | null {
    return this.store.updateCodeGraphMeta(serviceId, codeGraphId, patch);
  }

  /** Re-fetches + rebuilds (control plane explicit trigger). Returns not_found on memory/team mismatch; returns busy on pending/processing. */
  sync(serviceId: string, teamId: string, codeGraphId: string, requesterUserId?: string): SyncResult {
    const row = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (!row) return { kind: "not_found" };
    // Concurrency rejection: rejects directly if queued/executing without overwriting status, re-enqueuing, or writing audit.
    if (row.status === "pending" || row.status === "processing") {
      return { kind: "busy", status: row.status, step: row.internal_status };
    }
    const nextVersion = row.version + 1;
    this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
      status: "pending",
      internal_status: null,
      sync_error: null,
      version: nextVersion,
    });
    this.audit({ ...row, version: nextVersion }, "ingest", "manual sync", requesterUserId);
    const fresh = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (fresh) this.enqueueBuild(fresh);
    return fresh ? { kind: "ok", row: fresh } : { kind: "not_found" };
  }

  get(serviceId: string, teamId: string, codeGraphId: string): CodeGraphRow | null {
    return this.store.getCodeGraph(serviceId, teamId, codeGraphId);
  }

  /** Queries by globally unique code_graph_id (still scoped by service_id to prevent cross-tenant access). Dedicated for spec id-only endpoints. */
  getById(serviceId: string, codeGraphId: string): CodeGraphRow | null {
    return this.store.getCodeGraphById(serviceId, codeGraphId);
  }

  list(serviceId: string, teamId: string, opts?: ListOpts): CodeGraphRow[] {
    return this.store.listCodeGraphs(serviceId, teamId, opts);
  }

  count(serviceId: string, teamId: string, opts?: CountOpts): number {
    return this.store.countCodeGraphs(serviceId, teamId, opts);
  }

  /**
   * Deletes code-graph (008 / 007 §5.5). Deletable under any status (including pending/processing).
   * Returns false on memory/team mismatch; otherwise hard deletes + four resource cleanups, returning true.
   *
   * If resource is currently queued/executing (pending/processing), sets cancelled flag first to notify worker
   * to abort at checkpoint; then immediately hard deletes + cleans up (does not wait for worker). If worker re-checks before ending and finds
   * deleted state, it skips ready/callback and performs idempotent cleanup once more with no leftovers.
   */
  delete(serviceId: string, teamId: string, codeGraphId: string): boolean {
    const row = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (!row) return false;

    // Notify in-flight worker to abort (pending queued or processing executing).
    if (row.status === "pending" || row.status === "processing") {
      this.cancelled.add(codeGraphId);
    }

    this.audit(row, "delete", null);
    this.cleanupResources(serviceId, teamId, codeGraphId);

    // If worker is still running, it will see row hard-deleted (getById → null) at checkpoint and abort;
    // cancelled flag remains until worker completes to clean up on its own (see runBuild), flag is not deleted here
    // to cover the window where "delete completes before worker checkpoint". Cleanup is idempotent, repeated calls are harmless.
    return true;
  }

  /**
   * Four resource types idempotent cleanup (order: release memory/connections first, then delete disk).
   * Each step has independent try/catch — failure in any step does not affect others, ensuring exception safety.
   *   1. instance pool (memory): releaseInstance (pool.delete + closeIndex)
   *   2. Metadata row: Hard delete (safe even if matching 0 rows, supports worker + delete dual cleanup)
   *   3. Disk directory: rmSync recursive+force (idempotent)
   * Queued tasks in BuildQueue are skipped by runBuild entry checking cancelled/row existence, no handling needed here.
   */
  private cleanupResources(serviceId: string, teamId: string, codeGraphId: string): void {
    try {
      this.releaseInstance?.(codeGraphId);
    } catch (err) {
      this.logger?.warn?.(`[code-graph] release instance failed ${codeGraphId}: ${String(err)}`);
    }
    try {
      this.store.deleteCodeGraph(serviceId, teamId, codeGraphId);
    } catch (err) {
      this.logger?.warn?.(`[code-graph] hard-delete row failed ${codeGraphId}: ${String(err)}`);
    }
    try {
      rmSync(this.dirFor(serviceId, teamId, codeGraphId), { recursive: true, force: true });
    } catch (err) {
      this.logger?.warn?.(`[code-graph] rm dir failed ${codeGraphId}: ${String(err)}`);
    }
  }

  /**
   * Worker checkpoint: whether resource has been deleted (cancelled flag hit, or row no longer in DB).
   * Covered by dual criteria: (1) delete occurred during worker execution (cancelled); (2) delete completed
   * and row was hard-deleted (getById → null). Either condition considers resource deleted.
   */
  private isDeleted(serviceId: string, codeGraphId: string): boolean {
    return this.cancelled.has(codeGraphId) || this.store.getCodeGraphById(serviceId, codeGraphId) === null;
  }

  /** Writes a code-graph audit record. Failure does not block main flow. */
  private audit(row: CodeGraphRow, action: AuditAction, detail: string | null, requesterUserId?: string): void {
    try {
      this.store.appendCodeGraphAudit({
        service_id: row.service_id,
        asset_id: row.code_graph_id,
        version: row.version,
        action,
        // Prefer recording trigger user (initiator of sync/create), falling back to creator on row.
        user_id: requesterUserId ?? row.user_id,
        agent_id: row.agent_id,
        detail,
      });
    } catch (err) {
      this.logger?.warn?.(`[code-graph] audit ${action} failed: ${String(err)}`);
    }
  }

  private enqueueBuild(row: CodeGraphRow): void {
    this.queue.enqueue(row.code_graph_id, () =>
      this.runBuild(row.service_id, row.code_graph_id, row.team_id, row.repo_url, row.branch),
    );
  }

  private async runBuild(
    serviceId: string,
    codeGraphId: string,
    teamId: string,
    repoUrl: string,
    branch: string,
  ): Promise<void> {
    // Entry checkpoint: deleted during pending → skips directly, does not set processing or build graph.
    if (this.isDeleted(serviceId, codeGraphId)) {
      this.finishCancelled(serviceId, teamId, codeGraphId);
      return;
    }
    this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
      status: "processing",
      internal_status: "cloning",
      sync_error: null,
    });
    try {
      const result = await this.worker({
        codeGraphId,
        serviceId,
        teamId,
        repoUrl,
        branch,
        dir: this.dirFor(serviceId, teamId, codeGraphId),
        setInternalStatus: (s) =>
          this.store.updateCodeGraphStatus(serviceId, codeGraphId, { status: "processing", internal_status: s }),
      });
      // Completion checkpoint: deleted during processing → skips ready/audit/callback, performs idempotent cleanup.
      if (this.isDeleted(serviceId, codeGraphId)) {
        this.finishCancelled(serviceId, teamId, codeGraphId);
        return;
      }
      this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
        status: "ready",
        internal_status: null,
        sync_error: null,
        commit_hash: result.commitHash ?? null,
        stats_json: result.stats ? JSON.stringify(result.stats) : null,
        last_sync_at: new Date().toISOString(),
      });
      const synced = this.store.getCodeGraphById(serviceId, codeGraphId);
      if (synced) {
        this.audit(synced, "ready", result.stats ? JSON.stringify(result.stats) : null);
      }
      this.logger?.info?.(`[code-graph] ${codeGraphId} ready`);

      // Auto-generate summary + callback TMC
      await this.onBuildComplete(synced, "ready", null, result.stats ?? null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Worker threw error, but if deleted in the interim, treat as cancellation rather than failure: skip failed status/callback, perform cleanup.
      if (this.isDeleted(serviceId, codeGraphId)) {
        this.finishCancelled(serviceId, teamId, codeGraphId);
        return;
      }
      this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
        status: "failed",
        internal_status: null,
        sync_error: msg.slice(0, 500),
      });
      const failed = this.store.getCodeGraphById(serviceId, codeGraphId);
      if (failed) this.audit(failed, "failed", msg.slice(0, 500));
      this.logger?.warn?.(`[code-graph] ${codeGraphId} failed: ${msg}`);

      // Callback TMC about failure
      await this.onBuildComplete(failed, "failed", msg, null);
    }
  }

  /**
   * Finalization after worker checkpoint determines "deleted": idempotently cleans up disk/handles worker may have just written,
   * and removes cancelled flag (worker for this id terminates here, flag duty complete).
   */
  private finishCancelled(serviceId: string, teamId: string, codeGraphId: string): void {
    this.cleanupResources(serviceId, teamId, codeGraphId);
    this.cancelled.delete(codeGraphId);
    this.logger?.info?.(`[code-graph] ${codeGraphId} build aborted (deleted during processing)`);
  }

  /**
   * Post-build hook: generate summary (if synced) and callback TMC.
   * Never throws — runs after the main build is already committed.
   */
  private async onBuildComplete(
    row: CodeGraphRow | null,
    status: "ready" | "failed",
    errorMsg: string | null,
    stats: { files: number; nodes: number; edges: number } | null,
  ): Promise<void> {
    if (!row || !this.callbackConfig) return;

    let summary: string | null = null;

    if (status === "ready") {
      // Generate summary via template (no LLM for code-graph)
      const { generateCodeGraphSummary } = await import("../callback.js");
      summary = generateCodeGraphSummary(row.repo_name || row.repo_url, row.branch, stats);
      if (summary) {
        this.store.updateCodeGraphStatus(row.service_id, row.code_graph_id, { summary });
      }
    }

    // Callback TMC
    const { callbackTMC } = await import("../callback.js");
    await callbackTMC(
      {
        knowledge_id: row.code_graph_id,
        service_id: row.service_id,
        type: "code-graph",
        status,
        summary,
        sync_error: errorMsg?.slice(0, 500) ?? null,
        timestamp: new Date().toISOString(),
      },
      this.callbackConfig,
    );
  }

  /** Waits for background tasks to complete (tests / shutdown). */
  async onIdle(codeGraphId?: string): Promise<void> {
    await this.queue.onIdle(codeGraphId);
  }
}
