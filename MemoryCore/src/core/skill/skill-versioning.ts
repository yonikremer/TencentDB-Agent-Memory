/**
 * skill-versioning — Transaction orchestration for version incrementing
 *
 * Wraps skill-store's `appendVersion` and storage's `copyTree` into an "append a new version" primitive.
 * Simplifies the implementation of 6 manage actions for SkillCore (Phase 6).
 *
 * Steps of a complete "version increment" action:
 *   1. Fetch head (if exists)
 *   2. Validate: owner / version / content changed
 *   3. storage copies head's version directory to new version directory (if head exists)
 *   4. Apply resource changes (write/remove) on the new version directory
 *   5. store.appendVersion writes DB (inside transaction)
 *   6. On failure, attempt to clean up written storage copy (best-effort)
 */

import { createHash } from "node:crypto";

import type { ISkillStore } from "./skill-store.interface.js";
import { IdempotentNoOpError, SkillStoreError } from "./skill-store.js";
import { SkillResourceStore, SkillResourceError, type SkillResourcePayload } from "./skill-resource-store.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { SkillManifestEntry, Skill } from "./types.js";

function computeContentHash(content: string): string {
  return createHash("md5").update(content, "utf-8").digest("hex");
}

export interface AppendVersionContext {
  user_id?: string;
  team_id?: string;
  agent_id?: string;
  task_id?: string;
}

export interface AppendVersionMutation {
  /** Full SKILL.md text (including frontmatter). Required by all write paths (hash validation idempotency). */
  content: string;
  /** Parsed name / description extracted from frontmatter. */
  name: string;
  description: string;
  /** Resource changes: newly added / overwritten files for this version. */
  resourcesToWrite?: SkillResourcePayload[];
  /** Resource changes: relative paths removed for this version. */
  resourcesToRemove?: string[];
  /** Optional: metadata_json directly overwrites (default keeps previous version). */
  metadata_json?: string;
}

export interface SkillVersioningOptions {
  store: ISkillStore;
  resources: SkillResourceStore;
  storage: StorageAdapter;
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  /**
   * VDB record count change callback (used to report usage to Shark).
   * Triggered upon every successful store.appendVersion / store.deleteVersion.
   * @param delta +1 indicates a new VDB document added, -N indicates N documents deleted.
   */
  onSkillVdbChanged?: (delta: number) => void;
  /**
   * Asset registration hook when v1 is first created.
   *
   * Contract:
   *  - `await` called prior to storage and DB writes (pre-consistency protection)
   *  - Throwing exception = createNewSkill failed, neither storage nor DB will be written
   *  - Upper layer implementation must be idempotent (calling multiple times with same skill_id should succeed without side effects)
   *  - Triggered only by `createNewSkill`; neither `appendNextVersion` nor TTL cleanup will trigger it
   *    (asset is unrelated to version, only recognizes skill_id)
   */
  onSkillCreated?: (params: {
    skill_id: string;
    team_id?: string;
    agent_id?: string;
    user_id?: string;
    name: string;
    description: string;
  }) => Promise<void>;
}

export class SkillVersioning {
  private readonly store: ISkillStore;
  private readonly resources: SkillResourceStore;
  private readonly storage: StorageAdapter;
  private readonly logger?: SkillVersioningOptions["logger"];
  private readonly onSkillVdbChanged?: (delta: number) => void;
  private readonly onSkillCreated?: SkillVersioningOptions["onSkillCreated"];

  constructor(opts: SkillVersioningOptions) {
    this.store = opts.store;
    this.resources = opts.resources;
    this.storage = opts.storage;
    this.logger = opts.logger;
    this.onSkillVdbChanged = opts.onSkillVdbChanged;
    this.onSkillCreated = opts.onSkillCreated;
  }

  /**
   * Creates v1 for a brand new skill. Head does not exist; caller is responsible for generating skill_id.
   *
   * Cross-system "transaction" orchestration (COS + skill DB + meta_assets):
   *
   *   1. writeResource -> COS               <- Least reliable, do first; failure has zero DB side effects
   *   2. store.appendVersion -> skill DB    <- Failure: reverse cleanup COS (cleanupVersionDir)
   *   3. onSkillCreated -> meta_assets      <- Failure: reverse delete skill DB (deleteSkill) + cleanup COS
   *
   * Why this order: Cross 3 systems without true transactions can only rely on "order + compensation". Principle is
   * **do most error-prone first, do zero side effect failure first, reliable steps last**. COS is most brittle (network/
   * auth/permission), skill DB is local transaction almost never fails, asset involves agent query/team
   * check/multi-table write but is also local DB. Original "asset write first" violated this principle: there were cases
   * where COS auth failed -> skill not stored -> asset table already had orphan row.
   *
   * Extreme cases (step 2/3 rollback also fails):
   *   - Orphan skill (skill in DB but asset missing) self-heals via `onSkillAccessed` on read,
   *     registering on next user get/readFile. Closed loop exists.
   *   - Orphan COS files only consume space, all read paths go through DB, never read by mistake.
   */
  async createNewSkill(
    skillId: string,
    ownerAgentId: string,
    ctx: AppendVersionContext,
    mut: AppendVersionMutation,
  ): Promise<Skill> {
    const newVersion = 1;
    const storageDir = this.resources.versionDir(skillId, newVersion);

    // Aggregate total size check for entire skill (design §3.5.1: <= 50MB) — pure calculation, zero side-effects.
    if (mut.resourcesToWrite && mut.resourcesToWrite.length > 0) {
      this.resources.assertTotalSize([], mut.resourcesToWrite, []);
    }

    // ── Step 1: Write COS (do the most brittle step first, zero side effects on failure) ─────────────────────
    let manifest: SkillManifestEntry[] = [];
    if (mut.resourcesToWrite && mut.resourcesToWrite.length > 0) {
      try {
        for (const p of mut.resourcesToWrite) {
          const entry = await this.resources.writeResource(skillId, newVersion, p);
          manifest.push(entry);
        }
      } catch (e) {
        // Partially written files may exist, best-effort cleanup of entire version directory
        await this.cleanupVersionDir(storageDir).catch(() => { /* ignore */ });
        throw e;
      }
    }

    // ── Step 2: Write skill DB (local transaction, almost never fails; reverse cleanup COS on failure) ────
    let row: Skill;
    try {
      row = await this.store.appendVersion({
        user_id: ctx.user_id,
        team_id: ctx.team_id,
        agent_id: ctx.agent_id,
        task_id: ctx.task_id,
        skill_id: skillId,
        name: mut.name,
        description: mut.description,
        content: mut.content,
        content_hash: computeContentHash(mut.content),
        manifest,
        storage_dir: storageDir,
        owner_agent_id: ownerAgentId,
        metadata_json: mut.metadata_json,
      });
    } catch (e) {
      await this.cleanupVersionDir(storageDir).catch(() => { /* ignore */ });
      throw e;
    }

    // ── Step 3: Register meta_assets (agent/team validation + createAsset + bind) ──
    //  Failure -> reverse delete skill DB (deleteSkill) -> reverse cleanup COS -> rethrow business error.
    //  onSkillCreated not injected (e.g., tdai-core hook not attached) -> skip directly.
    if (this.onSkillCreated) {
      try {
        await this.onSkillCreated({
          skill_id: skillId,
          team_id: ctx.team_id,
          agent_id: ctx.agent_id,
          user_id: ctx.user_id,
          name: mut.name,
          description: mut.description,
        });
      } catch (assetErr) {
        // Reverse delete skill DB. deleteSkill itself might fail (DB down),
        // but probability is extremely low; even if it fails, onSkillAccessed read self-healing can converge orphan skills.
        // reportVdbDelta=false: +1 was never reported (only reported after step 3), rollback
        // reporting -1 would cause negative deviation in shark accounting.
        try {
          await this.deleteSkill(skillId, ctx.team_id, { reportVdbDelta: false });
        } catch (rollbackErr) {
          this.logger?.error(
            `[skill-tx] rollback deleteSkill failed for ${skillId} (team=${ctx.team_id ?? "-"}): ` +
              (rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)),
          );
        }
        // COS directory already cleaned inside deleteSkill (listVersions -> rmdir), not repeated here.
        // But if deleteSkill did not run storage cleanup due to DB error, cleanup once as fallback.
        await this.cleanupVersionDir(storageDir).catch(() => { /* ignore */ });
        throw assetErr;
      }
    }

    // All system writes succeeded -> report VDB delta
    this.onSkillVdbChanged?.(1);
    return row;
  }

  /**
   * Append a new version on top of existing head. Head must exist (caller fetches via store.getHead first).
   *
   * Content unchanged (same content_hash) and no resource changes -> return head (idempotent, no storage/DB writes).
   */
  async appendNextVersion(
    head: Skill,
    ctx: AppendVersionContext,
    mut: AppendVersionMutation,
  ): Promise<Skill> {
    const newVersion = head.version + 1;
    const newStorageDir = this.resources.versionDir(head.skill_id, newVersion);
    const oldStorageDir = head.storage_dir;
    const newContentHash = computeContentHash(mut.content);

    const noContentChange = newContentHash === head.content_hash;
    const noResourceChange =
      (!mut.resourcesToWrite || mut.resourcesToWrite.length === 0) &&
      (!mut.resourcesToRemove || mut.resourcesToRemove.length === 0);

    if (noContentChange && noResourceChange) {
      return head; // Idempotent
    }

    // Aggregate total size check for entire skill (design §3.5.1: <= 50MB).
    if (
      (mut.resourcesToWrite && mut.resourcesToWrite.length > 0) ||
      (mut.resourcesToRemove && mut.resourcesToRemove.length > 0)
    ) {
      this.resources.assertTotalSize(
        head.manifest,
        mut.resourcesToWrite,
        mut.resourcesToRemove,
      );
    }

    // 1) Copy old version directory to new version directory (if old version has content)
    try {
      await this.storage.copyTree(oldStorageDir, newStorageDir);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // If old version had no directory at all (old skill created without resources), skip copy
      if (!/STORAGE_NOT_FOUND/.test(msg)) {
        throw e;
      }
    }

    // 2) Apply resource changes on top of new version directory
    let manifest: SkillManifestEntry[] = [...head.manifest];
    try {
      if (mut.resourcesToRemove) {
        for (const p of mut.resourcesToRemove) {
          await this.resources.removeResource(head.skill_id, newVersion, p);
          manifest = manifest.filter((m) => m.path !== p);
        }
      }
      if (mut.resourcesToWrite) {
        for (const p of mut.resourcesToWrite) {
          const entry = await this.resources.writeResource(head.skill_id, newVersion, p);
          // Merge to manifest (overwrite same path)
          manifest = manifest.filter((m) => m.path !== entry.path);
          manifest.push(entry);
        }
      }
    } catch (e) {
      await this.cleanupVersionDir(newStorageDir).catch(() => { /* ignore */ });
      throw e;
    }

    // 3) Write DB (inside transaction + FTS sync)
    try {
      const row = await this.store.appendVersion({
        user_id: ctx.user_id,
        team_id: ctx.team_id,
        agent_id: ctx.agent_id,
        task_id: ctx.task_id,
        skill_id: head.skill_id,
        name: mut.name,
        description: mut.description,
        content: mut.content,
        content_hash: newContentHash,
        manifest,
        storage_dir: newStorageDir,
        owner_agent_id: head.owner_agent_id,
        metadata_json: mut.metadata_json ?? head.metadata_json,
      });
      this.onSkillVdbChanged?.(1);
      return row;
    } catch (e) {
      // DB failed -> cleanup newly copied directory
      // Note: store.appendVersion no longer checks hash idempotency (handled early by short-circuit in this class),
      // thus will not throw IdempotentNoOpError; type retained for external import in one place.
      await this.cleanupVersionDir(newStorageDir).catch(() => { /* ignore */ });
      throw e;
    }
  }

  // ─────────────────────────────────────────────────
  //  helpers
  // ─────────────────────────────────────────────────

  private async cleanupVersionDir(dir: string): Promise<void> {
    if (!dir) return;
    try { await this.storage.rmdir(dir); } catch { /* ignore */ }
  }

  // ─────────────────────────────────────────────────
  //  True Deletion: Delete all versions of a skill at once (including storage and shark reporting)
  // ─────────────────────────────────────────────────

  /**
   * Physically delete an entire skill (including all version rows + storage directory per version).
   *
   * Orchestration semantics:
   *   1. Call listVersions first to get storage_dir for all versions (DB is source of truth, read first then delete)
   *   2. store.deleteAllVersions —— DELETE all version rows at once + clear fts / vec
   *   3. rmdir storage per version (failure only logs warn, no DB rollback)
   *   4. Aggregate report `onSkillVdbChanged(-N)` (N = count of rows actually deleted)
   *      —— Unlike TTL path row-by-row `onSkillVdbChanged(-1)`, delete uses bulk reporting,
   *      reducing shark HTTP requests; semantically both accumulate shark MemoryDelta.
   *
   * Returns count of rows actually deleted. Returns 0 when skill does not exist, no reporting triggered (prevents false reports).
   *
   * Permission validation (team_id / owner / expected_version) is completed by caller SkillCore.delete.
   * This method does not perform business rule validation, only physical cleanup by (skill_id, team_id).
   */
  async deleteSkill(
    skillId: string,
    teamId?: string,
    opts?: {
      /**
       * Whether to report VDB delta. Default true (normal deletion path).
       * createNewSkill's rollback path should pass false —— because corresponding +1 was never reported
       * (+1 only sent after all three steps of create are green), reporting -N in rollback would cause
       * negative deviation in shark accounting.
       */
      reportVdbDelta?: boolean;
    },
  ): Promise<number> {
    const reportDelta = opts?.reportVdbDelta ?? true;

    // 1. Fetch full version metadata first (get storage_dir). listVersions cap is 1000,
    //    version count per skill is far below this under TTL protection + business limit.
    const versions = await this.store.listVersions(skillId, teamId, { limit: 1000, offset: 0 });

    // 2. Physically delete DB rows
    const deleted = await this.store.deleteAllVersions(skillId, teamId);
    if (deleted <= 0) {
      // Nothing deleted (skill missing / team mismatch) -> no report, no storage cleanup
      return 0;
    }

    // 3. Clear storage directory (warn on failure) — using dirs obtained from listVersions,
    //    rather than concatenating paths, tolerating inconsistent legacy storage_dir naming.
    for (const v of versions) {
      if (!v.storage_dir) continue;
      try {
        await this.storage.rmdir(v.storage_dir);
      } catch {
        this.logger?.warn(`[skill-delete] storage rmdir failed for ${v.storage_dir}`);
      }
    }

    // 4. Report to shark at once (-N); no report under rollback path (see opts comment)
    if (reportDelta) {
      this.onSkillVdbChanged?.(-deleted);
    }

    return deleted;
  }

  // ─────────────────────────────────────────────────
  //  TTL: Clean up expired old versions after write
  // ─────────────────────────────────────────────────

  private static readonly KEEP_RECENT = 3;

  /**
   * Clean up expired non-head versions of specified skill (delete DB rows first, then storage directories).
   * Fire-and-forget invocation, does not throw exceptions.
   */
  async cleanupExpiredVersionsForSkill(
    skillId: string,
    ttlSeconds: number,
    now?: number,
  ): Promise<void> {
    if (ttlSeconds <= 0) return;

    const nowMs = now ?? Date.now();
    const cutoffMs = nowMs - ttlSeconds * 1000;
    const all = await this.store.listVersions(skillId);
    if (!all.length) return;

    // Archived skill group protection
    const head = all.find((v) => v.is_head);
    if (!head || head.status === "archived") return;

    // version DESC
    const sorted = [...all].sort((a, b) => b.version - a.version);
    // KEEP_RECENT protects N most recent non-head versions (even if expired)
    const protectedVersions = new Set(
      sorted.filter((v) => !v.is_head).slice(0, SkillVersioning.KEEP_RECENT).map((v) => v.version),
    );

    for (const v of sorted) {
      if (v.is_head) continue;
      if (protectedVersions.has(v.version)) continue;
      if (v.created_at_ms >= cutoffMs) continue;

      // Delete DB row (data source) first, then storage directory (auxiliary)
      const deleted = await this.store.deleteVersion(v.skill_id, v.version);
      if (!deleted) continue;

      // Report VDB deletion (negative value)
      this.onSkillVdbChanged?.(-1);

      // Storage deletion failure only logs warning, does not affect DB correctness
      try {
        await this.storage.rmdir(v.storage_dir);
      } catch {
        this.logger?.warn(`[skill-ttl] storage rmdir failed for ${v.storage_dir}`);
      }
    }
  }

}

// Re-export error types so upper layer can import from one place
export { IdempotentNoOpError, SkillStoreError, SkillResourceError };

