/**
 * /v3/chat-memory/* HTTP handlers — Chat Memory content clear.
 *
 * Design highlights:
 *   - `clear` only deletes **content**, not the asset. asset_id, Team/Agent ownership, Agent binding,
 *     ACL, Owner, name, and visibility are all preserved. After clearing, the Agent continues to write using the original memory_id.
 *   - Any memory_id not existing / not chat_memory / unable to locate agent will reject the entire batch
 *     (starts deleting only after front-end parsing all passes).
 *   - Idempotent: calling again on an already cleared memory_id still returns success, count is 0.
 *   - Audit: each memory_id records one delete event per L1/L2/L3, only recording
 *     memory_id + time + result, **retaining zero original content**.
 *
 * Authentication model (consistent with L0–L3 data plane):
 *   The core treats Bearer + x-tdai-service-id as trusted admin-level credentials, **performing no user-level
 *   auth**, not parsing x-tdai-user-key — consistent with similar delete interfaces like conversation/delete, atomic/delete.
 *   "Only asset Owner can operate" is completed by the **panel backend** before forwarding
 *   (see NOT_ASSET_OWNER validation in MemoryPanel routes/chat-memory.ts).
 *
 * Registration method identical to /v3/skill/*, /v3/knowledge/* (extraRouteTable),
 * thus bypassing L0–L3 strict-isolation triplet validation — this interface's scope is determined by
 * memory_ids itself, not relying on agent/session in request headers.
 */

import { randomUUID } from "node:crypto";

import { ZodError, z } from "zod";

import { errorEnvelope, successEnvelope } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import type { IMemoryStore, MemoryContentClearResult } from "../core/store/types.js";
import type { StorageAdapter } from "../core/storage/types.js";
import { createScopedStorageAdapter } from "../core/storage/adapter.js";
import { buildProfileIsolationScope } from "../core/profile/profile-sync.js";
import { MetadataError, type MetadataService } from "../metadata/service/metadata-service.js";
import type { Logger } from "../core/types.js";

const TAG = "[chat-memory-handlers]";

/** Maximum memory_ids per clear. */
export const CHAT_MEMORY_CLEAR_MAX = 100;

// ═════════════════════════════════════════════════════════════
//  Schema
// ═════════════════════════════════════════════════════════════

export const chatMemoryClearRequestSchema = z.object({
  memory_ids: z.array(z.string()).min(1).max(CHAT_MEMORY_CLEAR_MAX),
}).transform((data) => {
  const seen = new Set<string>();
  const memoryIds: string[] = [];
  for (const raw of data.memory_ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    memoryIds.push(id);
  }
  return { memory_ids: memoryIds };
}).refine(
  (data) => data.memory_ids.length > 0,
  { message: "memory_ids must contain at least one non-empty id" },
);

/** Single memory clear result. */
export interface ChatMemoryClearItem {
  memory_id: string;
  /** Whether clearing succeeded. If failed, memory_id content might remain, caller can retry (idempotent). */
  cleared: boolean;
  l0_deleted: number;
  l1_deleted: number;
  /** L2/L3 profile record count (VDB rows + storage files). */
  profile_deleted: number;
  /** Reason for failure; omitted if successful. */
  reason?: string;
  /**
   * Whether the failure is worth retrying.
   *
   * Clearing is idempotent, so internal retries have already occurred; true here means retries still failed
   * (usually persistent VDB/COS unavailability), caller can try again later to fill in remaining content.
   * Parameter errors and other non-retryable failures are false.
   */
  retryable?: boolean;
  /** Internal actual attempt count, for troubleshooting. */
  attempts?: number;
}

export interface ChatMemoryClearData {
  items: ChatMemoryClearItem[];
  /** true when all are successful. */
  all_cleared: boolean;
}

// ═════════════════════════════════════════════════════════════
//  Deps
// ═════════════════════════════════════════════════════════════

export interface ChatMemoryRouterDeps {
  getStore: () => IMemoryStore | undefined;
  getStorage: () => StorageAdapter | undefined;
  getMetadataService?: (instanceId: string) => Promise<MetadataService>;
  logger: Logger;
}

function formatZodErr(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** MetadataError.code → envelope code. Semantics consistent with v3-meta-router mapping. */
function metadataErrorCode(code: string): number {
  if (code === "permission_denied") return 403;
  if (code.endsWith("_not_found")) return 404;
  return 400;
}

// ═════════════════════════════════════════════════════════════
//  Clear
// ═════════════════════════════════════════════════════════════

/**
 * Delete all L2/L3 storage objects under this (team, agent) scope.
 *
 * Storage is isolated by profile scope prefix (`profiles/<scope>/`), so directly delete by prefix entirely,
 * covering persona.md, scene_blocks/, .metadata/scene_index.json and any
 * derived files; will not exceed this (team, agent) scope.
 *
 * Returns deleted object count (for audit counting). Failure is thrown up, caller marks this memory failed.
 */
async function clearProfileStorage(
  baseStorage: StorageAdapter,
  teamId: string,
  agentId: string,
): Promise<number> {
  // ⚠️ Must self-validate, cannot rely on caller.
  // buildProfileIsolationScope silently fallbacks empty values to "default", spelling out
  // `team:default|agent:default` this **seemingly valid** scope — once
  // teamId/agentId is empty, it deletes shared default scope data instead of erroring.
  const team = (teamId ?? "").trim();
  const agent = (agentId ?? "").trim();
  if (!team || !agent) {
    throw new Error(
      "clearProfileStorage requires non-empty teamId and agentId " +
      "(empty values would silently target the shared \"default\" profile scope)",
    );
  }

  const scope = buildProfileIsolationScope({ teamId: team, agentId: agent });
  // Scope prefix completely consistent with v2-router scopedProfileStorage,
  // otherwise it clears the wrong directory (or none).
  const scopePrefix = `profiles/${encodeURIComponent(scope)}/`;
  const storage = createScopedStorageAdapter(baseStorage, scopePrefix);

  // Count then delete: deleteByPrefix return value semantics aren't uniform across backends,
  // use list result as authoritative source for audit counting here.
  let removed = 0;
  try {
    const entries = await storage.readdir("");
    removed = entries.filter((e) => !e.isDirectory).length;
  } catch { /* Scope doesn't exist yet → treat as cleared */ }

  // Empty string prefix after scoped adapter key() concatenation is `profiles/<scope>/`,
  // always non-empty, won't step out of bounds to other agents, nor hit backend empty key protection.
  await storage.rmdir("");

  return removed;
}

/**
 * Clear chat_memory **content** for a (team, agent): L0/L1/L2/L3 + vectors + files.
 * Deletes content only, **doesn't touch any asset records** (asset / bindings / ACL decided by callers respectively).
 *
 * Two callers share this implementation to avoid two distinct clean logics diverging:
 *   - `/v3/chat-memory/clear` —— retains asset after clear, Agent continues using original memory_id
 *   - `MetadataService.archiveAgent` —— deletes asset after clear (Agent deletion scenario)
 *
 * Failure is thrown up, caller decides to mark single failure or abort entire process.
 */
export async function clearChatMemoryContent(args: {
  store: IMemoryStore;
  storage: StorageAdapter;
  teamId: string;
  agentId: string;
}): Promise<{ l0Deleted: number; l1Deleted: number; profileDeleted: number }> {
  // Self-validation at entry: this is a destructive operation with two callers, cannot rely on upstream having validated.
  const teamId = (args.teamId ?? "").trim();
  const agentId = (args.agentId ?? "").trim();
  if (!teamId || !agentId) {
    throw new Error("clearChatMemoryContent requires non-empty teamId and agentId");
  }

  if (typeof args.store.clearMemoryContent !== "function") {
    throw new Error("store does not support clearMemoryContent");
  }
  const result: MemoryContentClearResult = await args.store.clearMemoryContent({
    teamId,
    agentId,
  });
  const filesRemoved = await clearProfileStorage(args.storage, teamId, agentId);
  return {
    l0Deleted: result.l0Deleted,
    l1Deleted: result.l1Deleted,
    profileDeleted: result.profilesDeleted + filesRemoved,
  };
}

/** Total retry attempt limit for content clear (including first try). */
export const CLEAR_MAX_ATTEMPTS = 3;
/** Retry backoff base (ms), actual wait is BASE * 2^(n-1). */
const CLEAR_RETRY_BASE_DELAY_MS = 300;

/**
 * Check if error is worth retrying.
 *
 * Non-retryable are **input/contract class errors** — retrying 10000 times gives same result, only prolonging request.
 * Others (VDB timeouts, COS 5xx, connection resets, etc) treated as transient failures to retry.
 */
function isNonRetryableClearError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    // Empty inputs — caller bug, retry is meaningless
    msg.includes("requires non-empty teamId and agentId")
    || msg.includes("requires a non-empty sessionId")
    // store capability missing — config issue
    || msg.includes("does not support clearMemoryContent")
    // Dangerous filter blocked by guardrails — code defect, must expose instead of covering by retrying
    || msg.includes("refusing clearMemoryContent")
    || msg.includes("would wipe the whole collection")
    || msg.includes("missing required scope field")
  );
}

/**
 * Content clear with overall retry.
 *
 * Why retry at **this layer**, instead of relying only on TcvdbClient's single request retry:
 * Single request retry only covers "one HTTP call jitter", but clear has L0→L1→profiles→storage
 * four steps, any step failing completely leaves a "half-cleared" state. Clear is inherently idempotent (deleting by filter,
 * deleting again returns 0), so overall re-run is safe and resolves half-cleared to fully cleared.
 *
 * On failure, throws the last error, and prefixes message with attempt count for troubleshooting.
 */
async function clearChatMemoryContentWithRetry(args: {
  store: IMemoryStore;
  storage: StorageAdapter;
  teamId: string;
  agentId: string;
  logger: Logger;
  memoryId: string;
}): Promise<{
  result: { l0Deleted: number; l1Deleted: number; profileDeleted: number };
  attempts: number;
}> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= CLEAR_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await clearChatMemoryContent({
        store: args.store,
        storage: args.storage,
        teamId: args.teamId,
        agentId: args.agentId,
      });
      if (attempt > 1) {
        args.logger.info(
          `${TAG} clear succeeded on attempt ${attempt}/${CLEAR_MAX_ATTEMPTS} memory=${args.memoryId}`,
        );
      }
      return { result, attempts: attempt };
    } catch (err) {
      lastErr = err;

      if (isNonRetryableClearError(err)) {
        args.logger.error(
          `${TAG} clear failed with non-retryable error memory=${args.memoryId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }

      if (attempt < CLEAR_MAX_ATTEMPTS) {
        const delay = CLEAR_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        args.logger.warn(
          `${TAG} clear attempt ${attempt}/${CLEAR_MAX_ATTEMPTS} failed memory=${args.memoryId}, ` +
          `retrying in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastErr;
}

/**
 * Clear with overall retry, for `archiveAgent` (clearing content when deleting Agent) to reuse.
 *
 * Shares same retry strategy with clear interface, ensuring two paths have identical behavior: both can self-heal transient
 * VDB/COS failures, and neither will cover up parameter errors with retries.
 */
export async function clearChatMemoryContentResilient(args: {
  store: IMemoryStore;
  storage: StorageAdapter;
  teamId: string;
  agentId: string;
  logger: Logger;
}): Promise<{ l0Deleted: number; l1Deleted: number; profileDeleted: number }> {
  const { result } = await clearChatMemoryContentWithRetry({
    ...args,
    memoryId: `${args.teamId}/${args.agentId}`,
  });
  return result;
}

/**
 * Write clear audit. One delete event each for L1/L2/L3, record_id uses memory_id (asset_id),
 * no original content written. Audit failure won't block main flow (semantics consistent with v2-router recordAudit).
 */
export async function recordClearAudit(
  store: IMemoryStore,
  args: {
    memoryId: string;
    teamId: string;
    agentId: string;
    requestId: string;
    logger: Logger;
  },
): Promise<void> {
  if (!store.appendAudit) return;
  const now = Date.now();
  for (const layer of ["L1", "L2", "L3"] as const) {
    try {
      await store.appendAudit({
        audit_id: `audit-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        record_id: args.memoryId,
        layer,
        action: "delete",
        team_id: args.teamId,
        agent_id: args.agentId,
        version: 0,
        updated_at_ms: now,
        request_id: args.requestId,
      });
    } catch (err) {
      args.logger.warn(
        `${TAG} audit append failed (clear/${layer} memory=${args.memoryId}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function handleChatMemoryClear(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  depsRaw: unknown,
): Promise<ApiResponseEnvelope> {
  const deps = depsRaw as ChatMemoryRouterDeps;
  const parsed = chatMemoryClearRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const { memory_ids } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  if (typeof store.clearMemoryContent !== "function") {
    return errorEnvelope(503, "Store does not support chat memory clear", requestId);
  }
  const storage = deps.getStorage();
  if (!storage) return errorEnvelope(503, "Storage not available", requestId);
  if (!deps.getMetadataService) {
    return errorEnvelope(503, "Metadata service not available", requestId);
  }

  let metaSvc: MetadataService;
  try {
    metaSvc = await deps.getMetadataService(auth.serviceId);
  } catch (err) {
    deps.logger.warn(`${TAG} metadata service unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return errorEnvelope(503, "Metadata service not available", requestId);
  }

  // ── Batch front-end parsing: asset exists + asset_type=chat_memory + agent locatable.
  //    Any failure rejects whole batch, zero items cleared.
  //
  //    No user-level Owner validation here —— trust model is consistent with L0-L3 data plane:
  //    The core data plane treats Bearer + x-tdai-service-id as trusted (admin-level) credentials,
  //    and doesn't parse x-tdai-user-key. "Only asset Owner can operate" is done by the **panel backend**
  //    before forwarding (see MemoryPanel routes/chat-memory.ts NOT_ASSET_OWNER validation).
  //    Doing it again in core would cause: ① inconsistent behavior with similar delete interfaces (conversation/atomic delete);
  //    ② server-side callers (without user context) couldn't use this interface.
  let targets: Array<{ asset_id: string; team_id: string; agent_id: string }>;
  try {
    targets = await metaSvc.resolveChatMemoryTargets(memory_ids);
  } catch (err) {
    if (err instanceof MetadataError) {
      return errorEnvelope(metadataErrorCode(err.code), err.message, requestId);
    }
    throw err;
  }

  // ── Clear content sequentially. Validation passed, failures here can only be storage/VDB faults,
  //    so comes with overall retry (clearing is idempotent, rerun is safe). ──
  const items: ChatMemoryClearItem[] = [];
  for (const target of targets) {
    try {
      const { result, attempts } = await clearChatMemoryContentWithRetry({
        store,
        storage,
        teamId: target.team_id,
        agentId: target.agent_id,
        logger: deps.logger,
        memoryId: target.asset_id,
      });

      await recordClearAudit(store, {
        memoryId: target.asset_id,
        teamId: target.team_id,
        agentId: target.agent_id,
        requestId,
        logger: deps.logger,
      });

      items.push({
        memory_id: target.asset_id,
        cleared: true,
        l0_deleted: result.l0Deleted,
        l1_deleted: result.l1Deleted,
        profile_deleted: result.profileDeleted,
        ...(attempts > 1 ? { attempts } : {}),
      });
    } catch (err) {
      // Don't rollback: clear itself is idempotent, caller retrying can fill the rest.
      // Log only safe information, don't pass raw underlying error to caller.
      const retryable = !isNonRetryableClearError(err);
      deps.logger.error(
        `${TAG} clear failed memory=${target.asset_id} team=${target.team_id} ` +
        `agent=${target.agent_id} retryable=${retryable}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      items.push({
        memory_id: target.asset_id,
        cleared: false,
        l0_deleted: 0,
        l1_deleted: 0,
        profile_deleted: 0,
        reason: retryable
          ? `clear failed after ${CLEAR_MAX_ATTEMPTS} attempts, please retry later`
          : "clear rejected due to invalid request or server configuration",
        retryable,
        attempts: retryable ? CLEAR_MAX_ATTEMPTS : 1,
      });
    }
  }

  return successEnvelope<ChatMemoryClearData>({
    items,
    all_cleared: items.every((i) => i.cleared),
  }, requestId);
}

// ═════════════════════════════════════════════════════════════
//  Route table
// ═════════════════════════════════════════════════════════════

type RouteHandler = (
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: unknown,
) => Promise<ApiResponseEnvelope>;

export function makeChatMemoryRouteTable(): Record<string, RouteHandler> {
  return {
    "/v3/chat-memory/clear": handleChatMemoryClear,
  };
}

export { handleChatMemoryClear };
