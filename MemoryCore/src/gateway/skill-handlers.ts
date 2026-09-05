/**
 * /skill/* HTTP handlers — v3 (migrated from v2, 2026-06-17).
 *
 * Corresponds to: docs/design/2026-06-17-skill-redesign-v2.md §3.5 / §3.6.
 *
 * Error code mapping (core layer SkillCoreError → HTTP envelope code):
 *   INVALID_FRONTMATTER       → 40001  (frontmatter.name inconsistent with body/head)
 *   INVALID_PATH              → 40001
 *   SKILL_NOT_OWNER           → 40301
 *   SKILL_TEAM_MISMATCH       → 40302
 *   SKILL_NOT_FOUND           → 40401
 *   SKILL_VERSION_STALE       → 40901
 *   RESOURCE_TOO_LARGE        → 41301
 *   SKILL_NAME_DUPLICATE      → 42201
 *   SKILL_PATCH_NOT_UNIQUE    → 42202
 *   SKILL_FRONTMATTER_INVALID → 42203  (frontmatter parse / length / regex)
 *   STORAGE_NOT_FOUND         → 50301  (version directory has been GC'd)
 *   QUEUE_UNAVAILABLE         → 50301  (queue not ready during extract)
 *   LLM_UNAVAILABLE           → 50302  (LLM unavailable)
 *   Others                       → 50001
 */

import { randomUUID } from "node:crypto";

import { ZodError } from "zod";

import { errorEnvelope, successEnvelope } from "./v2-router.js";
import {
  createRequestSchema,
  updateRequestSchema,
  patchRequestSchema,
  deleteRequestSchema,
  getRequestSchema,
  getByNameRequestSchema,
  listRequestSchema,
  searchRequestSchema,
  versionsRequestSchema,
  filesWriteRequestSchema,
  filesRemoveRequestSchema,
  filesReadRequestSchema,
  listingRequestSchema,
  extractRequestSchema,
  exportRequestSchema,
  conversationAddRequestSchema,
  forceArchiveRequestSchema,
} from "./skill-schemas.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import { SkillCoreError, type SkillCore } from "../core/skill/skill-core.js";
import type { SkillExtractor } from "../core/skill/skill-extractor.js";
import type { Logger } from "../core/types.js";
import type { Skill, ResolvedSkillConfig } from "../core/skill/types.js";
import { DEFAULT_COMPRESS_OPTIONS } from "../core/skill/conversation-add/message-compressor.js";
import { DEFAULT_OVERSIZE_OPTIONS } from "../core/skill/conversation-add/oversize-strategy.js";
import { prepareArchivePayload } from "../core/skill/conversation-add/prepare-archive.js";
import type { CompressibleMessage } from "../core/skill/conversation-add/message-compressor.js";
import { trace } from "../core/report/trace.js";
import { metricProducer } from "../core/report/kafka-metric-producer.js";
import { obsLogger } from "../core/report/obs-logger.js";

const TAG = "[skill-handlers]";

// [obs] All observation tracking goes through the obsLogger base (`src/core/report/obs-logger.ts`);
// Event name `skill.<xxx>.done` / `skill.<xxx>.<phase>` written as literal, fields directly
// inline dictionary. Pass undefined values directly without filtering —— same as other modules in the repository (e.g.
// core/report/traced-task-executor.ts) - kept fully consistent. Downgrade is handled inside obsLogger
// try/catch provided, business code does not add extra defense.

// ═════════════════════════════════════════════════════════════════════
//  Deps
// ═════════════════════════════════════════════════════════════════════

export interface SkillRouterDeps {
  getSkillCore: () => SkillCore | undefined;
  /** Optional. Extractor instance (driven internally by the worker). */
  getSkillExtractor?: () => SkillExtractor | undefined;
  /** Optional. Resolved skill configuration; handleListing uses searchTopK to limit the number of injected entries. */
  getResolvedSkillConfig?: () => ResolvedSkillConfig | undefined;
  logger: Logger;
  /**
   * Service mode: resolve per-instance SkillCore (TcvdbSkillStore + COS).
   * When provided, takes precedence over getSkillCore() for /v3/skill/* requests
   * that carry x-tdai-service-id.
   */
  resolveSkillCore?: (instanceId: string) => Promise<SkillCore | undefined>;
  /** Quota manager for skill count limit checks (like memory's checkMemoryQuota). */
  quotaManager?: import("../core/quota/quota-manager.js").QuotaManager;
  /**
   * Service mode: build a SkillExtractor for a given SkillCore.
   * Pass in the per-instance SkillCore (TCVDB + COS) + the instanceId of the current request, and return the extractor.
   * Used for synchronous extraction of /v3/skill/extract in service mode, replacing the standalone queue asynchronous mode.
   *
   * `instanceId` is passed to `resolveStandaloneLlmForRuntime` to construct
   * `${baseUrl}/proxy/<instanceId>/v1` — without it, in the `provider=proxy`
   * scenario, the skill extractor will directly hit the wrong upstream URL.
   */
  buildSkillExtractor?: (
    core: SkillCore,
    instanceId: string,
  ) => SkillExtractor | Promise<SkillExtractor>;
  /**
   * Obtain the MetadataService (per instance). Used to automatically register after successful handleCreate
   * skill asset (asset_id === skill_id) and bind to the owner agent's fixed-asset.
   *
   * in standalone mode, SkillCore is globally constructed by TdaiCore (without hooks), so by handler
   * Layer does this registration; in service mode, the onSkillCreated hook in buildSkillCore does the same
   * Idempotent (repeated calls have no side effects). Both paths are covered, ensuring the frontend control page always sees the skill.
   *
   * Semantics consistent with `handleConversationAdd` in v2-router using the same dep to automatically register the `chat_memory` asset
   * (see v2-router.ts:648 and metadata-service.ts:ensureSkillAsset).
   */
  getMetadataService?: (instanceId: string) => Promise<import("../metadata/service/metadata-service.js").MetadataService>;
  /**
   * `POST /v3/skill/conversation/add` + `POST /v3/skill/extract`
   * Shared wired result provider. Returns a complete set of { handler, trigger, buffer, ... }:
   *   - handleConversationAdd uses .handler
   *   - handleExtract uses .trigger
   *
   * Each tenant holds one copy in Service mode; standalone mode returns a singleton. Resolved by the wiring layer
   * (server.ts) with caching + resolution based on auth.serviceId.
   */
  resolveConversationAdd?: (instanceId: string) => Promise<
    import("../core/skill/conversation-add/wire.js").WiredConversationAddHandler | undefined
  >;
}

// ═════════════════════════════════════════════════════════════════════
// Error mapping
// ═════════════════════════════════════════════════════════════════════

const ERROR_CODE_MAP: Record<string, number> = {
  INVALID_FRONTMATTER: 40001,
  INVALID_PATH: 40001,
  SKILL_NOT_OWNER: 40301,
  SKILL_TEAM_MISMATCH: 40302,
  SKILL_NOT_FOUND: 40401,
  SKILL_VERSION_STALE: 40901,
  RESOURCE_TOO_LARGE: 41301,
  SKILL_NAME_DUPLICATE: 42201,
  SKILL_PATCH_NOT_UNIQUE: 42202,
  SKILL_FRONTMATTER_INVALID: 42203,
  STORAGE_NOT_FOUND: 50301,
  LLM_UNAVAILABLE: 50302,
  SKILL_COS_REQUIRED: 50303,
  SKILL_ID_COLLISION: 50304,
  SKILL_VERSION_EXPIRED: 41002,
  SKILL_EXPORT_TOO_LARGE: 41301,
};

function mapCoreError(e: unknown, requestId: string, deps?: SkillRouterDeps, meta?: Record<string, unknown>): ApiResponseEnvelope {
  if (e instanceof SkillCoreError) {
    const code = ERROR_CODE_MAP[e.code] ?? 50001;

    // Log a warn log when version conflict occurs, to facilitate subsequent conflict frequency statistics
    if (e.code === "SKILL_VERSION_STALE" && deps) {
      deps.logger.warn(
        `${TAG} version_conflict requestId=${requestId} skill_id=${meta?.skill_id ?? "?"} ` +
        `expected_version=${meta?.expected_version ?? "?"} detail="${e.message}"`,
      );
    }

    // Version conflict 409 response includes current_version additionally, to facilitate retry by the caller
    if (e.code === "SKILL_VERSION_STALE") {
      const match = e.message?.match(/head is (\d+)/);
      const currentVersion = match ? Number(match[1]) : undefined;
      return errorEnvelope(code, e.message, requestId, { current_version: currentVersion });
    }

    // 410 version expired, include latest_version additionally in response to facilitate caller upgrade
    if (e.code === "SKILL_VERSION_EXPIRED") {
      const match = e.message?.match(/latest version v(\d+)/);
      const latestVersion = match ? Number(match[1]) : undefined;
      return errorEnvelope(code, e.message, requestId, { latest_version: latestVersion });
    }

    return errorEnvelope(code, e.message, requestId);
  }
  return errorEnvelope(50001, (e as Error).message ?? "internal error", requestId);
}

function formatZodErr(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

// ═════════════════════════════════════════════════════════════════════
// Shared Preamble
// ═════════════════════════════════════════════════════════════════════

/**
 * Unified pre-validation: prioritize obtaining per-instance SkillCore (TCVDB + COS) via resolveSkillCore(auth.serviceId)
 * fallback to getSkillCore() (standalone)
 *
 * Fix (2026-07-04): in service mode, read handlers previously only used getSkillCore() (standalone
 * SQLite), causing reads to return empty after writing per-instance TCVDB SQLite. Now align the read/write paths to the same set
 * store parsing logic.
 */
async function precheck<T>(
  schema: { safeParse(b: unknown): { success: true; data: T } | { success: false; error: ZodError } },
  body: unknown,
  auth: V2AuthContext,
  deps: SkillRouterDeps,
  requestId: string,
): Promise<{ ok: true; core: SkillCore; data: T } | { ok: false; envelope: ApiResponseEnvelope }> {
  let core: SkillCore | undefined;
  if (deps.resolveSkillCore) {
    core = await deps.resolveSkillCore(auth.serviceId);
  }
  if (!core) {
    core = deps.getSkillCore();
  }
  if (!core) return { ok: false, envelope: errorEnvelope(404, "Skill module not enabled", requestId) };
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, envelope: errorEnvelope(40001, formatZodErr(parsed.error), requestId) };
  return { ok: true, core, data: parsed.data };
}

/**
 * Precheck for writing path: completely consistent with the precheck logic, but the name more clearly expresses the "write semantics".
 * Keep it to maintain the naming consistency of the existing handler; they can be merged, but keep backward compatibility for now.
 */
async function precheckWrite<T>(
  schema: { safeParse(b: unknown): { success: true; data: T } | { success: false; error: ZodError } },
  body: unknown,
  auth: V2AuthContext,
  deps: SkillRouterDeps,
  requestId: string,
): Promise<{ ok: true; core: SkillCore; data: T } | { ok: false; envelope: ApiResponseEnvelope }> {
  let core: SkillCore | undefined;
  if (deps.resolveSkillCore) {
    core = await deps.resolveSkillCore(auth.serviceId);
  }
  if (!core) {
    core = deps.getSkillCore();
  }
  if (!core) return { ok: false, envelope: errorEnvelope(404, "Skill module not enabled", requestId) };
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, envelope: errorEnvelope(40001, formatZodErr(parsed.error), requestId) };
  return { ok: true, core, data: parsed.data };
}

// Form Skill lines into SkillSummary format (without content; add manifest when detail is present).
// Align fields with design document §3.4 SkillSummary.
/** Deserialize skill.metadata_json into the metadata object; return undefined for invalid JSON. */
function parseMetadata(s: Skill): Record<string, unknown> | undefined {
  const raw = s.metadata_json;
  if (!raw || raw === "{}" || raw === "") return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function toSummary(s: Skill) {
  const metadata = parseMetadata(s);
  return {
    skill_id: s.skill_id,
    name: s.name,
    description: s.description,
    version: s.version,
    is_head: s.is_head,
    status: s.status,
    owner_user_id: s.user_id,
    owner_agent_id: s.owner_agent_id,
    team_id: s.team_id,
    task_id: s.task_id,
    created_at_ms: s.created_at_ms,
    updated_at_ms: s.updated_at_ms,
    ...(metadata ? { metadata } : {}),
  };
}

// ═════════════════════════════════════════════════════════════════════
//  Handlers
// ═════════════════════════════════════════════════════════════════════

export async function handleCreate(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(createRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleCreate.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  // Quota check (like memory's checkMemoryQuota)
  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleCreate.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.create(pre.data);
    try { trace.report("skill.create", { skill_id: r.skill_id, team_id: r.team_id, agent_id: r.owner_agent_id, name: r.name }); } catch { /* noop */ }

    // ── Auto-register skill assets (asset_id === skill_id) + bind to owner agent's fixed-asset ──
    //
    // Why this is done here:
    //   - In standalone mode, SkillCore is globally constructed by TdaiCore (no onSkillCreated hook);
    //   - If not registered here, metadata-layer interfaces such as asset/list-accessible / acl/* cannot find this skill,
    //     and the "Team Assets / Authorization" chain of the frontend management page is completely disconnected.
    //
    // Relationship with the service mode:
    //   - In the service mode, when gateway constructs per-instance SkillCore with buildSkillCore in service mode and attaches hooks with the same name,
    //     both paths call `metaSvc.ensureSkillAsset({ skill_id, team_id, agent_id, name })`,
    //     which is already implemented with idempotency (LRU + primary key deduplication) within metadata-service.ts, so repeated calls have no side effects.
    //
    // Failure strategy:
    //   - throw exception → create request returns error overall. Avoid "skill persisted but asset missing"
    //      of the silent-inconsistency state (users would wonder: "I created it but cannot see it").
    //   - Consistent with the approach of ensureChatMemoryAsset in v2-router.ts handleConversationAdd.
    if (deps.getMetadataService && r.team_id && r.owner_agent_id) {
      try {
        const metaSvc = await deps.getMetadataService(auth.serviceId);
        await metaSvc.ensureSkillAsset({
          skill_id: r.skill_id,
          team_id: r.team_id,
          agent_id: r.owner_agent_id,
          name: r.name,
        });
      } catch (err) {
        deps.logger.error(
          `${TAG} ensureSkillAsset failed for ${r.skill_id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        obsLogger.error("skill.handleCreate.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: r.skill_id, phase: "ensureSkillAsset" }, err instanceof Error ? err : undefined);
        return mapCoreError(err, requestId, deps, { skill_id: r.skill_id });
      }
    }

    obsLogger.info("skill.handleCreate.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, name: r.name, version: r.version });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) { obsLogger.error("skill.handleCreate.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleUpdate(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(updateRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleUpdate.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleUpdate.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.update(pre.data);
    try { trace.report("skill.update", { skill_id: r.skill_id, team_id: r.team_id, agent_id: r.owner_agent_id, name: r.name, version: r.version }); } catch { /* noop */ }
    obsLogger.info("skill.handleUpdate.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, name: r.name, version: r.version });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handleUpdate.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handlePatch(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(patchRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handlePatch.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handlePatch.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.patch(pre.data);
    try { trace.report("skill.patch", { skill_id: r.skill_id, team_id: r.team_id, agent_id: r.owner_agent_id, name: r.name, version: r.version }); } catch { /* noop */ }
    obsLogger.info("skill.handlePatch.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, name: r.name, version: r.version });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handlePatch.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleDelete(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(deleteRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleDelete.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const r = await pre.core.delete(pre.data);

    // ── asset physical deletion fallback: DELETE meta_assets + cascade clean agent bindings / ACL ──
    //
    // Why do it again here:
    //   - service mode: the onSkillArchived hook in buildSkillCore has already been called once; here again
    //     The operation is idempotent and convergent (deleteAssets treats assets that no longer exist as successful, with no side effects).
    //   - standalone mode: SkillCore is globally constructed by TdaiCore without injecting hooks (to avoid coupling
    //     MetadataService starts timing). This call from the handler layer is the sole entry point for linkage.
    //
    // Failure strategy: fire-and-forget, warn does not fall back to delete. A second delete will re-trigger the core hook
    // and this fallback, ultimately converging. Refer to the symmetric approach in ensureSkillAsset in handleCreate
    // (just opposite failure strategy: create strictly fails, delete is lenient to ensure the skill side always succeeds).
    let assetSynced = false;
    if (r.archived && deps.getMetadataService && pre.data.team_id) {
      try {
        const metaSvc = await deps.getMetadataService(_auth.serviceId);
        await metaSvc.deleteAssets([r.skill_id]);
        assetSynced = true;
      } catch (err) {
        deps.logger.warn(
          `${TAG} [skill-asset-sync] deleteAssets(archive) failed for ${r.skill_id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    try {
      trace.report("skill.delete", {
        skill_id: r.skill_id,
        team_id: pre.data.team_id,
        agent_id: pre.data.agent_id,
        asset_synced: assetSynced,
      });
    } catch { /* noop */ }
    obsLogger.info("skill.handleDelete.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, archived: r.archived, asset_synced: assetSynced });
    return successEnvelope(r, requestId);
  } catch (e) {
    obsLogger.error("skill.handleDelete.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

/**
 * `POST /v3/skill/get-by-name` —— (team_id, agent_id, skill_name) → skill details.
 *
 * See the motivation comment in `getByNameRequestSchema` in skill-schemas.ts. Implementation path:
 *   1) schema has team_id + agent_id + skill_name as required
 *   2) Get candidates (1-2 items) of (team, agent, name_prefix=name) via `SkillCore.list`
 *   3) Match one by exact name, then pass it to `SkillCore.get(skill_id)` to reuse the include_content /
 *      include_manifest / version branches, ensuring the output body is consistent with /v3/skill/get
 *
 * Not found → 40401 SKILL_NOT_FOUND (aligned with get, the agent perspective cannot tell whether it is "no such name
 * or no such id", unify one error code).
 */
export async function handleGetByName(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(getByNameRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleGetByName.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    // Use name as prefix to fetch 1-2 candidates (prefix LIKE will match neighbors with the same prefix,
    // explicitly perform an exact-match once; do not use limit=1 so that the exact match is stable).
    const listed = await pre.core.list({
      team_id: pre.data.team_id,
      agent_id: pre.data.agent_id,
      filters: { name_prefix: pre.data.skill_name },
      pagination: { limit: 10 },
    });
    const hit = listed.items.find((s) => s.name === pre.data.skill_name);
    if (!hit) {
      obsLogger.info("skill.handleGetByName.done", {
        req_id: requestId, code: 40401, dur_ms: Date.now() - t0,
        team_id: pre.data.team_id, agent_id: pre.data.agent_id, skill_name: pre.data.skill_name,
        reason: "not_found",
      });
      // Same path as handleGet SKILL_NOT_FOUND:errorEnvelope(40401, ...)
      return errorEnvelope(40401, `SKILL_NOT_FOUND: no skill named "${pre.data.skill_name}" for agent ${pre.data.agent_id}`, requestId);
    }

    // Reuse handleGet body: construct get input to go through core.get, ensuring identical behavior
    // (Including version branch, include_content / include_manifest semantics).
    const row = await pre.core.get({
      user_id: pre.data.user_id,
      team_id: pre.data.team_id,
      agent_id: pre.data.agent_id,
      task_id: pre.data.task_id,
      skill_id: hit.skill_id,
      version: pre.data.version,
      include_content: pre.data.include_content,
      include_manifest: pre.data.include_manifest,
    });
    const includeContent = pre.data.include_content ?? true;
    const includeManifest = pre.data.include_manifest ?? true;
    const data = {
      ...toSummary(row),
      ...(row.content_hash ? { content_hash: row.content_hash } : {}),
      ...(row.storage_dir ? { storage_dir: row.storage_dir } : {}),
      ...(includeContent ? { content: row.content } : {}),
      ...(includeManifest ? { manifest: row.manifest } : {}),
    };
    obsLogger.info("skill.handleGetByName.done", {
      req_id: requestId, code: 0, dur_ms: Date.now() - t0,
      skill_id: row.skill_id, version: row.version,
      content_len: row.content?.length ?? 0,
      manifest_n: row.manifest?.length ?? 0,
    });
    return successEnvelope(data, requestId);
  } catch (e) {
    obsLogger.error("skill.handleGetByName.done", {
      req_id: requestId, dur_ms: Date.now() - t0,
      skill_name: pre.data.skill_name,
    }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId);
  }
}

export async function handleGet(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(getRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleGet.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const row = await pre.core.get(pre.data);
    const includeContent = pre.data.include_content ?? true;
    const includeManifest = pre.data.include_manifest ?? true;
    // Detail view additionally includes content_hash / storage_dir (summary does not output these).
    // Refer to docs/design/2026-06-17-skill-redesign-v2.md §3.4 SkillDetail fields.
    const data = {
      ...toSummary(row),
      ...(row.content_hash ? { content_hash: row.content_hash } : {}),
      ...(row.storage_dir ? { storage_dir: row.storage_dir } : {}),
      ...(includeContent ? { content: row.content } : {}),
      ...(includeManifest ? { manifest: row.manifest } : {}),
    };
    obsLogger.info("skill.handleGet.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: row.skill_id,
      version: row.version,
      content_len: row.content?.length ?? 0,
      manifest_n: row.manifest?.length ?? 0, });
    return successEnvelope(data, requestId);
  } catch (e) { obsLogger.error("skill.handleGet.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleList(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(listRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleList.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    // Archive semantics: `filters.status` accepts an explicit `['archived']` / `['active','archived']`，
    // used only by the admin console "Recycle Bin" view. When status is omitted, only active is returned by default (see
    // SqliteSkillStore.listSkills / TcvdbSkillStore.listSkills defaults).
    // Normal business callers **should not** request archived explicitly - it is already invisible to the read/write APIs.
    const r = await pre.core.list(pre.data);
    obsLogger.info("skill.handleList.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, items: r.items.length, total: r.total });
    return successEnvelope({ items: r.items.map(toSummary), total: r.total }, requestId);
  } catch (e) { obsLogger.error("skill.handleList.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleSearch(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(searchRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleSearch.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    // scope="team" → strip agent_id so store does team-wide search (no owner filter).
    // The v3 isolation middleware already verified team_id + agent_id + user_id are present.
    const { scope, ...data } = pre.data;
    const searchInput = scope === "team"
      ? { ...data, agent_id: undefined }
      : data;
    const hits = await pre.core.search(searchInput);
    const items = hits.map((h) => ({
      ...toSummary(h.skill),
      score: h.score,
      // FTS5 snippet may be empty (content too short); fallback to description.
      snippet: h.snippet && h.snippet.length > 0 ? h.snippet : h.skill.description,
    }));
    obsLogger.info("skill.handleSearch.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, items: items.length, scope: pre.data.scope ?? "agent" });
    return successEnvelope({ items }, requestId);
  } catch (e) { obsLogger.error("skill.handleSearch.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleVersions(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(versionsRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleVersions.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const r = await pre.core.listVersions(pre.data);
    if (r.total === 0) {
      obsLogger.warn("skill.handleVersions.done", { req_id: requestId, code: 40401, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, reason: "not_found" });
      return errorEnvelope(40401, "skill not found", requestId);
    }
    const items = r.items.map((s) => ({
      ...toSummary(s),
      is_expired: (s as Skill & { is_expired: boolean }).is_expired ?? false,
    }));
    obsLogger.info("skill.handleVersions.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, items: items.length, total: r.total });
    return successEnvelope({ items, total: r.total }, requestId);
  } catch (e) { obsLogger.error("skill.handleVersions.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleFilesWrite(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(filesWriteRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleFilesWrite.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleFilesWrite.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.writeFiles(pre.data);
    obsLogger.info("skill.handleFilesWrite.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, version: r.version, files: pre.data.files.length });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handleFilesWrite.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleFilesRemove(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(filesRemoveRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleFilesRemove.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleFilesRemove.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.removeFiles(pre.data);
    obsLogger.info("skill.handleFilesRemove.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, version: r.version, paths: pre.data.paths.length });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handleFilesRemove.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleFilesRead(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(filesReadRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleFilesRead.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const r = await pre.core.readFile(pre.data);
    obsLogger.info("skill.handleFilesRead.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id,
      version: r.version,
      size_bytes: r.size_bytes,
      encoding: r.encoding, });
    return successEnvelope(r, requestId);
  } catch (e) { obsLogger.error("skill.handleFilesRead.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleExport(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(exportRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) {
    obsLogger.warn("skill.handleExport.done", {
      req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck",
    });
    return pre.envelope;
  }
  try {
    const r = await pre.core.exportSkill(pre.data);
    obsLogger.info("skill.handleExport.done", {
      req_id: requestId, code: 0, dur_ms: Date.now() - t0,
      skill_id: pre.data.skill_id, version: r.version,
      file_count: r.file_count, total_bytes: r.total_bytes,
    });
    return successEnvelope(r, requestId);
  } catch (e) {
    obsLogger.error("skill.handleExport.done", {
      req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id,
    }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId);
  }
}

export async function handleListing(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(listingRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleListing.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const charBudget = pre.data.char_budget ?? 8000;
    const query = (pre.data.query ?? "").trim();
    const useSearch = query.length > 0;

    // Read routing from config: searchTopK (max number of listings to inject) + mode (bm25/embedding/hybrid).
    const routing = deps.getResolvedSkillConfig?.()?.routing;
    const topK = routing?.searchTopK ?? 20;

    // search mode: select retrieval algorithm based on routing.mode; fallback to list head (query is empty).
    type Item = { skill_id: string; name: string; description: string; version: number };
    let items: Item[];
    let mode: "full" | "search";
    if (useSearch) {
      const hits = await pre.core.search({
        user_id: pre.data.user_id,
        team_id: pre.data.team_id,
        agent_id: pre.data.agent_id,
        query,
        top_k: topK,
        mode: routing?.mode,
      });
      items = hits.map((h) => ({
        skill_id: h.skill.skill_id,
        name: h.skill.name,
        description: h.skill.description,
        version: h.skill.version,
      }));
      mode = "search";
    } else {
      const r = await pre.core.list({
        user_id: pre.data.user_id,
        team_id: pre.data.team_id,
        agent_id: pre.data.agent_id,
        pagination: { limit: topK },
      });
      items = r.items.map((s) => ({
        skill_id: s.skill_id,
        name: s.name,
        description: s.description,
        version: s.version,
      }));
      mode = items.length < topK ? "full" : "search";
    }

    // Render listing; truncate by char_budget (keep head + explicit truncation marker).
    const lines = items.map((s) => `- ${s.name}: ${s.description}`);
    let listing = lines.length === 0
      ? "<available_skills>\n(none)\n</available_skills>"
      : `<available_skills>\n${lines.join("\n")}\n</available_skills>`;

    if (listing.length > charBudget) {
      const truncated = listing.slice(0, Math.max(0, charBudget - 32));
      listing = `${truncated}\n... [truncated]\n</available_skills>`;
    }

    obsLogger.info("skill.handleListing.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, mode,
      hits: items.length,
      listing_len: listing.length,
      truncated: listing.length >= charBudget, });
    return successEnvelope({
      mode,
      listing,
      hits: items.map((s) => ({ skill_id: s.skill_id, version: s.version, name: s.name })),
    }, requestId);
  } catch (e) { obsLogger.error("skill.handleListing.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

/**
 * `POST /v3/skill/extract` — direct-trigger archive a session slice.
 *
 * Before the refactor it was "enqueue to the Redis job queue + poll /result"; after the refactor it goes through conversation/add
 * It uses the exact same downstream (`SkillTriggerService.archive()` → agent queue → reuse
 * `SkillConversationExtractWorker`), just without writing data-current/meta, one call
 * produces one independent archive + one SkillTaskEntry.
 *
 * See `docs/design/2026-07-17-skill-extract-direct-trigger-plan.md`.
 */
export async function handleExtract(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  // [obs] handler internal segmentation goes through obsLogger: one info event per segment, with structured fields
  // (req_id / dur_ms / …), which can be linked throughout by req_id; obsLogger has internal try/catch,
  // so even if the logger backend is down, it won't affect business.
  const t0 = Date.now();

  const t0Parse = Date.now();
  const parsed = extractRequestSchema.safeParse(body);
  obsLogger.info("skill.handleExtract.schema_parse", {
    req_id: requestId, dur_ms: Date.now() - t0Parse, ok: parsed.success,
  });
  if (!parsed.success) {
    obsLogger.warn("skill.handleExtract.done", { req_id: requestId, code: 40001, dur_ms: Date.now() - t0, reason: "schema" });
    return errorEnvelope(40001, formatZodErr(parsed.error), requestId);
  }
  const input = parsed.data;

  if (!deps.resolveConversationAdd) {
    obsLogger.warn("skill.handleExtract.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired" });
    return errorEnvelope(50301, "skill extract not wired (resolveConversationAdd missing)", requestId);
  }
  const t0Wire = Date.now();
  const wired = await deps.resolveConversationAdd(auth.serviceId);
  obsLogger.info("skill.handleExtract.resolve_wired", {
    req_id: requestId, dur_ms: Date.now() - t0Wire, service_id: auth.serviceId, hit: !!wired,
  });
  if (!wired) {
    obsLogger.warn("skill.handleExtract.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired_for_instance" });
    return errorEnvelope(50301, "skill extract not wired for this instance", requestId);
  }

  // direct-trigger always generates a one-time session id (prefix sx-) —— because it has no cross-turn buffer,
  // session_id only determines the COS archive path segment, and it is independent for each call; it is also accepted if the caller passes it.
  const sessionId = input.session_id ?? `sx-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

  // Compression + Fallback Strategy (Redesigned 2026-08-10):
  //   ① Total < chunkMax → Full archive, no compression, no truncation
  //   ② Total ≥ chunkMax → Compress tool messages (> threshold tool_call/tool_result head and tail)
  //   ③ Still ≥ chunkMax after compression → Oversize fallback truncation (keep head + tail, cut middle)
  // Get parameters from resolvedSkillConfig; DEFAULT_* only as fallback (standalone unconfigured scenario).
  const skillCfg = deps.getResolvedSkillConfig?.();
  const compressOpts = skillCfg
    ? {
        toolContentThresholdBytes: skillCfg.compress.toolContentThresholdBytes,
        headBytes: skillCfg.compress.headBytes,
        tailBytes: skillCfg.compress.tailBytes,
      }
    : DEFAULT_COMPRESS_OPTIONS;
  const oversizeOpts = skillCfg
    ? {
        chunkMaxBytes: skillCfg.extraction.chunkMaxBytes,
        headKeepBytes: skillCfg.extraction.headKeepBytes,
        tailKeepBytes: skillCfg.extraction.tailKeepBytes,
      }
    : DEFAULT_OVERSIZE_OPTIONS;
  const chunkMax = oversizeOpts.chunkMaxBytes ?? DEFAULT_OVERSIZE_OPTIONS.chunkMaxBytes;

  const t0Prep = Date.now();
  const incoming: CompressibleMessage[] = input.messages.map((m) => ({
    role: m.role,
    content: m.content,
    tool_name: m.tool_name,
    tool_call_id: m.tool_call_id,
  }));

  // First calculate the raw bytes, only compress + fallback when exceeding chunkMax
  const rawBytes = incoming.reduce(
    (sum, m) => sum + Buffer.byteLength(JSON.stringify(m), "utf8"), 0,
  );
  const needCompress = rawBytes >= chunkMax;

  const prepared = prepareArchivePayload(
    /* existing */ [],
    incoming,
    {
      compress: compressOpts,
      oversize: oversizeOpts,
      forceCompress: needCompress,
    },
  );
  obsLogger.info("skill.handleExtract.prepare_archive", {
    req_id: requestId, dur_ms: Date.now() - t0Prep,
    msg_in: input.messages.length, msg_out: prepared.messages.length,
    raw_bytes: rawBytes, need_compress: needCompress,
    used_compress: prepared.usedCompress, used_oversize: prepared.usedOversize,
  });

  // space_id prioritizes body (for backward compatibility with early callers), falling back to auth.serviceId by default ——
  // The two values should be equal by design (both are "the currently logged-in instance"). If they are not equal, record a warning to help detect it early
  // Bug when caller passes wrong instance; isolation/auth/route all rely on auth.serviceId, unrelated to body.
  const spaceId = input.space_id ?? auth.serviceId;
  if (input.space_id && input.space_id !== auth.serviceId) {
    deps.logger.warn(
      `${TAG} /v3/skill/extract space_id mismatch: body=${input.space_id} auth=${auth.serviceId}; using body`,
    );
  }

  try {
    const t0Archive = Date.now();
    const res = await wired.trigger.archive({
      session: {
        // 2026-07-30 instance_id inserted into tuple; worker pool routes based on this after coming out of the queue
        // Resources for the corresponding instance (CoS bucket / VDB collection / LLM key).
        instance_id: auth.serviceId,
        space_id: spaceId,
        user_id: input.user_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        session_id: sessionId,
      },
      bufferAtTrigger: { messages: prepared.messages as Array<Record<string, unknown>> },
      taskRefId: input.task_id,
      reason: input.reason,
      maxIterations: input.options?.max_iterations,
      // Pass requestId to the segmented obsLogger event inside trigger as anchor
      perfRequestId: requestId,
    });
    obsLogger.info("skill.handleExtract.trigger_archive", {
      req_id: requestId, dur_ms: Date.now() - t0Archive,
      task_id: res.taskId, archive_key: res.archiveKey,
    });

    try {
      metricProducer.send({ metric: "skill.extract.request", instanceId: input.team_id, value: 1 });
    } catch { /* noop */ }

    // trace.report backend span: aligned with create/update/patch/delete; task_id is the anchor,
    // in clickhouse / langfuse, worker-side skill.worker.task_done can be retrieved by task_id.
    try {
      trace.report("skill.extract", {
        task_id: res.taskId,
        task_ref_id: input.task_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        session_id: sessionId,
        msg_count: prepared.messages.length,
        success: true,
      });
    } catch { /* noop */ }

    obsLogger.info("skill.handleExtract.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, task_id: res.taskId, msg_count: prepared.messages.length, });
    return successEnvelope({
      ok: true,
      task_id: res.taskId,
      archived_at_ms: res.archivedAtMs,
      archive_key: res.archiveKey,
    }, requestId);
  } catch (e) {
    deps.logger.warn(`${TAG} /v3/skill/extract archive failed: ${(e as Error).message} req_id=${requestId}`);
    obsLogger.error("skill.handleExtract.done", { req_id: requestId, dur_ms: Date.now() - t0, reason: "archive_failed" }, e instanceof Error ? e : undefined);
    return errorEnvelope(50001, (e as Error).message ?? "internal error", requestId);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  /v3/skill/conversation/add  —  New pipeline: incremental entry per conversation round
// ═════════════════════════════════════════════════════════════════════

/**
 * `POST /v3/skill/conversation/add`
 *
 * Client (proxy) synchronously calls once after each round of conversation. Handler completes internally
 * Concatenate + threshold determination + archive segment (register first, then write to archive). Return { status, archived? }.
 *
 * Refer to `docs/design/2026-07-15-skill-trigger-in-core-design.md` §11.1.
 */
export async function handleConversationAdd(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: SkillRouterDeps,
): Promise<ApiResponseEnvelope> {
  // [obs] proxy is logged every round, and it is the most frequently used skill interface. Segment events:
  //   skill.handleConversationAdd.schema_parse / resolve_wired / handler_handle / done
  // handler.handle internally also divides into four stages: read_buffer / prepare_archive / trigger.archive /
  // write_back (handled internally by SkillConversationAddHandler via obsLogger, reusing the same req_id for trigger
  // to associate).
  const t0 = Date.now();

  if (!deps.resolveConversationAdd) {
    obsLogger.warn("skill.handleConversationAdd.done", { req_id: requestId, code: 404, dur_ms: Date.now() - t0, reason: "not_wired" });
    return errorEnvelope(404, "Skill conversation-add module not enabled", requestId);
  }
  const t0Parse = Date.now();
  const parsed = conversationAddRequestSchema.safeParse(body);
  obsLogger.info("skill.handleConversationAdd.schema_parse", {
    req_id: requestId, dur_ms: Date.now() - t0Parse, ok: parsed.success,
  });
  if (!parsed.success) {
    obsLogger.warn("skill.handleConversationAdd.done", { req_id: requestId, code: 40001, dur_ms: Date.now() - t0, reason: "schema" });
    return errorEnvelope(40001, formatZodErr(parsed.error), requestId);
  }
  const input = parsed.data;

  // In service mode, resolve tenant-level wired using auth.serviceId; standalone ignores serviceId
  // Returns singleton from wiring.
  const t0Wire = Date.now();
  const wired = await deps.resolveConversationAdd(auth.serviceId);
  obsLogger.info("skill.handleConversationAdd.resolve_wired", {
    req_id: requestId, dur_ms: Date.now() - t0Wire, service_id: auth.serviceId, hit: !!wired,
  });
  if (!wired) {
    obsLogger.warn("skill.handleConversationAdd.done", { req_id: requestId, code: 404, dur_ms: Date.now() - t0, reason: "not_wired_for_instance" });
    return errorEnvelope(404, "Skill conversation-add module not enabled for this instance", requestId);
  }

  // space_id prioritizes body, falling back to auth.serviceId (same processing as handleExtract).
  // The two values should be equal by design; alert if they are not.
  const spaceId = input.space_id ?? auth.serviceId;
  if (input.space_id && input.space_id !== auth.serviceId) {
    deps.logger.warn(
      `${TAG} /v3/skill/conversation/add space_id mismatch: body=${input.space_id} auth=${auth.serviceId}; using body`,
    );
  }

  try {
    const t0Handle = Date.now();
    const out = await wired.handler.handle({
      // 2026-07-30 instance_id inserted into tuple; worker pool routes after coming out of the queue.
      instance_id: auth.serviceId,
      session_id: input.session_id,
      space_id: spaceId,
      user_id: input.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      task_id: input.task_id,
      // schema ensures role is valid, tool_name/tool_call_id are validated within the handler
      messages: input.messages.map((m) => ({
        role: m.role,
        content: m.content,
        tool_name: m.tool_name,
        tool_call_id: m.tool_call_id,
        timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
      })),
      // Pass requestId through to the segment obsLogger inside the handler; trigger.archive will also pass it through one more layer
      perfRequestId: requestId,
    });
    obsLogger.info("skill.handleConversationAdd.handler_handle", {
      req_id: requestId, dur_ms: Date.now() - t0Handle,
      status: out.status, reason: out.archived?.reason,
    });

    try {
      trace.report("skill.conversation_add", {
        session_id: input.session_id,
        task_ref_id: input.task_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        status: out.status,
        archived_task_id: out.archived?.task_id,
        reason: out.archived?.reason,
        msg_count: input.messages.length,
        success: true,
      });
    } catch { /* noop */ }

    obsLogger.info("skill.handleConversationAdd.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, status: out.status,
      reason: out.archived?.reason,
      task_id: out.archived?.task_id,
      msg_count: input.messages.length, });
    return successEnvelope(out, requestId);
  } catch (err) {
    // HandlerValidationError → 400; others → 500
    const isValidation = err instanceof Error && err.name === "HandlerValidationError";
    if (isValidation) {
      obsLogger.error("skill.handleConversationAdd.done", { req_id: requestId, dur_ms: Date.now() - t0, field: (err as { field?: string }).field }, err instanceof Error ? err : undefined);
      return errorEnvelope(40001, err.message, requestId);
    }
    deps.logger.warn(`${TAG} /v3/skill/conversation/add failed: ${(err as Error).message}`);
    obsLogger.error("skill.handleConversationAdd.done", { req_id: requestId, dur_ms: Date.now() - t0 }, err instanceof Error ? err : undefined);
    return errorEnvelope(50001, (err as Error).message ?? "internal error", requestId);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  POST /v3/skill/conversation/force-archive
//   Manually force archive the current session buffer (third trigger condition: skip threshold)
// ═════════════════════════════════════════════════════════════════════

export async function handleForceArchive(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: SkillRouterDeps,
): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();

  if (!deps.resolveConversationAdd) {
    obsLogger.warn("skill.handleForceArchive.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired" });
    return errorEnvelope(50301, "skill force-archive not wired (resolveConversationAdd missing)", requestId);
  }

  const parsed = forceArchiveRequestSchema.safeParse(body);
  if (!parsed.success) {
    obsLogger.warn("skill.handleForceArchive.done", { req_id: requestId, code: 40001, dur_ms: Date.now() - t0, reason: "schema" });
    return errorEnvelope(40001, formatZodErr(parsed.error), requestId);
  }
  const input = parsed.data;

  const wired = await deps.resolveConversationAdd(auth.serviceId);
  if (!wired) {
    obsLogger.warn("skill.handleForceArchive.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired_for_instance" });
    return errorEnvelope(50301, "skill force-archive not wired for this instance", requestId);
  }

  const sess = {
    // 2026-08-04 Fix: Missing instance_id causes trigger.archive → serializeAgentTuple
    // to throw `instance_id must be a non-empty string`, the handler wraps it in an envelope
    // 50001 is returned to the proxy, causing the panel / mem:create-skill "Force Archive" to fail 100%.
    // Keep consistent with handleExtract / handleConversationAdd, fall back to auth.serviceId.
    instance_id: auth.serviceId,
    space_id: input.space_id,
    user_id: input.user_id,
    team_id: input.team_id,
    agent_id: input.agent_id,
    session_id: input.session_id,
  };

  try {
    // Read the current buffer
    const [current, meta] = await Promise.all([
      wired.buffer.readCurrent(sess),
      wired.buffer.readMeta(sess),
    ]);

    // Buffer is empty: no archiving needed
    if (!current.messages || current.messages.length === 0) {
      obsLogger.info("skill.handleForceArchive.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, status: "empty" });
      return successEnvelope({ status: "empty", message: "No messages in buffer to archive" }, requestId);
    }

    // unconditionally call trigger.archive (skip threshold check)
    const archiveRes = await wired.trigger.archive({
      session: sess,
      bufferAtTrigger: { messages: current.messages },
      taskRefId: input.task_id,
      reason: input.reason,
      perfRequestId: requestId,
    });

    // Clear buffer and reset meta after archiving (consistent with add-handler archiving behavior)
    const nowMs = Date.now();
    await Promise.all([
      wired.buffer.writeCurrent(sess, { messages: [] }),
      wired.buffer.writeMeta(sess, {
        session_id: sess.session_id,
        space_id: sess.space_id,
        user_id: sess.user_id,
        team_id: sess.team_id,
        agent_id: sess.agent_id,
        tool_call_count: 0,
        byte_count: 0,
        last_appended_at_ms: nowMs,
        last_archived_at_ms: archiveRes.archivedAtMs,
      }),
    ]);

    obsLogger.info("skill.handleForceArchive.done", {
      req_id: requestId, code: 0, dur_ms: Date.now() - t0,
      status: "archived", task_id: archiveRes.taskId,
    });
    return successEnvelope({
      status: "archived",
      task_id: archiveRes.taskId,
      archived_at_ms: archiveRes.archivedAtMs,
      archive_key: archiveRes.archiveKey,
    }, requestId);
  } catch (err) {
    deps.logger.warn(`${TAG} /v3/skill/conversation/force-archive failed: ${(err as Error).message} req_id=${requestId}`);
    obsLogger.error("skill.handleForceArchive.done", { req_id: requestId, dur_ms: Date.now() - t0 }, err instanceof Error ? err : undefined);
    return errorEnvelope(50001, (err as Error).message ?? "internal error", requestId);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  Route table
// ═════════════════════════════════════════════════════════════════════

export type SkillHandler = (
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: SkillRouterDeps,
) => Promise<ApiResponseEnvelope>;

export function makeSkillRouteTable(): Record<string, SkillHandler> {
  return {
    "/v3/skill/create": handleCreate,
    "/v3/skill/update": handleUpdate,
    "/v3/skill/patch": handlePatch,
    "/v3/skill/delete": handleDelete,
    "/v3/skill/get": handleGet,
    "/v3/skill/get-by-name": handleGetByName,
    "/v3/skill/list": handleList,
    "/v3/skill/search": handleSearch,
    "/v3/skill/versions": handleVersions,
    "/v3/skill/files/write": handleFilesWrite,
    "/v3/skill/files/remove": handleFilesRemove,
    "/v3/skill/files/read": handleFilesRead,
    "/v3/skill/export": handleExport,
    "/v3/skill/listing": handleListing,
    "/v3/skill/extract": handleExtract,
    "/v3/skill/conversation/add": handleConversationAdd,
    "/v3/skill/conversation/force-archive": handleForceArchive,
  };
}
