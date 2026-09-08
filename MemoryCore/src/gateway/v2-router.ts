/**
 * TDAI Memory Gateway — v3 REST Router (strict isolation).
 *
 * Implements POST routes defined in `01-api-spec.yaml`:
 *
 *   L0 Conversation: add / query / search / delete
 *   L1 Atomic:       update / query / search / delete
 *   L2 Scenario:     ls / read / write / rm
 *   L3 Core:         read / write
 *
 * All routes are prefixed with `/v3/`.
 * Authentication: Authorization Bearer + x-tdai-service-id.
 * Request validation: Zod v4 safeParse → 400 on failure.
 * Response envelope: { code, message, request_id, data }.
 */

import { createHash, randomUUID } from "node:crypto";
import type http from "node:http";
import { classifyError } from "./error-handler.js";
import type {
  IMemoryStore,
  L0Record,
  ProfileSyncRecord,
} from "../core/store/types.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import {
  createScopedStorageAdapter,
  type StorageAdapter,
} from "../core/storage/adapter.js";
import { StoragePaths } from "../core/storage/types.js";
import type { Logger } from "../core/types.js";
import type { IStateBackend } from "../core/state/types.js";
import type { PipelineWorker } from "../services/pipeline-worker.js";
import { executeMemorySearch } from "../core/tools/memory-search.js";
import { executeConversationSearch } from "../core/tools/conversation-search.js";
import type { MemoryRecord } from "../core/record/l1-writer.js";
import { reportRecallMetrics } from "../core/report/metric-tracking-recall.js";

// ── Zod schemas (validated types + defaults) ──
import {
  conversationAddRequestSchema,
  conversationQueryRequestSchema,
  conversationSearchRequestSchema,
  conversationDeleteRequestSchema,
  conversationCountRequestSchema,
  atomicUpdateRequestSchema,
  atomicQueryRequestSchema,
  atomicSearchRequestSchema,
  atomicDeleteRequestSchema,
  atomicCountRequestSchema,
  scenarioListRequestSchema,
  scenarioReadRequestSchema,
  scenarioWriteRequestSchema,
  scenarioRmRequestSchema,
  scenarioCountRequestSchema,
  coreWriteRequestSchema,
  coreCountRequestSchema,
  formatZodError,
  resolveIsolation,
  type ApiResponseEnvelope,
  type V2AuthContext,
  type ConversationItem,
  type ConversationSearchHit,
  type ConversationAddData,
  type ConversationQueryData,
  type ConversationSearchData,
  type ConversationDeleteData,
  type CountData,
  type AtomicDetail,
  type AtomicUpdateData,
  type AtomicQueryData,
  type AtomicSearchData,
  type AtomicSearchHit,
  type AtomicDeleteData,
  type ScenarioEntry,
  type ScenarioFile,
  type ScenarioWriteData,
  type CoreFile,
  type CoreWriteData,
} from "./v2-schemas.js";
import { stripSceneNavigation } from "../core/scene/scene-navigation.js";
import {
  buildProfileIsolationScope,
  buildProfileStableId,
  DEFAULT_PROFILE_SCOPE,
} from "../core/profile/profile-sync.js";

const TAG = "[tdai-gateway][v3]";

/**
 * /v3 is the "strict isolation version" of L0-L3 data plane interfaces:
 *
 *   - Required team_id + agent_id + user_id (missing one yields 422)
 *   - session_id optional: if passed, converges by session; if not, aggregates by (team, agent, user) dimension
 *     —— Satisfies "agent cross-session aggregate view" (like L0/L1 totals in governance panel) and
 *     "L2/L3 team-level aggregation" (profile scope formula ignores session) scenarios
 *   - Does not accept legacy_compat_mode fallback
 *   - Shares handler implementation with /v2, only swaps isolation validation at dispatch layer
 *
 * Same-name /v2 paths retain existing behavior (team_id optional, user_id fallback, allows legacyCompatMode),
 * so callers can choose v2/v3 on demand without interference.
 *
 * L0-L3 data plane endpoints (including count) mount v3; management plane interfaces like team/user/agent/task/pipeline retain v2 sole entry.
 */
const V3_PREFIX = "/v3";

/**
 * /v3 strict isolation required fields. Can be obtained from either request body or x-tdai-* headers.
 *
 * v3 all L0-L3 interfaces only enforce team + agent + user triad.
 * session_id is always optional:
 *   - L0 conversation/* and L1 atomic/*: passing session converges within session; not passing aggregates
 *     across sessions by (team, agent, user) (facilitates "agent-dimension full view", like
 *     layer-counts totals on team-memory-control governance plane)
 *   - L2 scenario/* and L3 core/*: inherently team+agent level profile aggregation, session ignored
 *
 * Returns missing field list (empty array means fully complete).
 */
function collectV3Missing(
  _subpath: string,
  body: Record<string, unknown> | undefined,
  headers: Record<string, string | string[] | undefined>,
): string[] {
  const headerStr = (k: string): string | undefined => {
    const raw = headers[k] ?? headers[k.toLowerCase()];
    if (Array.isArray(raw)) return raw[0];
    return typeof raw === "string" ? raw : undefined;
  };
  const get = (bodyKey: string, headerKey: string): string => {
    const v =
      (body?.[bodyKey] as string | undefined) ?? headerStr(headerKey) ?? "";
    return typeof v === "string" ? v.trim() : "";
  };
  const missing: string[] = [];
  if (!get("team_id", "x-tdai-team-id")) missing.push("team_id");
  if (!get("agent_id", "x-tdai-agent-id")) missing.push("agent_id");
  if (!get("user_id", "x-tdai-user-id")) missing.push("user_id");
  // session_id no longer required: underlying handler queries aggregated by (team,agent,user) when session missing.
  return missing;
}

/** L0-L3 subpaths covered by /v3 strong isolation (path after removing prefix). */
const V3_ALLOWED_SUBPATHS = new Set<string>([
  "/conversation/add",
  "/conversation/query",
  "/conversation/search",
  "/conversation/delete",
  "/conversation/count",
  "/atomic/update",
  "/atomic/query",
  "/atomic/search",
  "/atomic/delete",
  "/atomic/count",
  "/scenario/ls",
  "/scenario/read",
  "/scenario/write",
  "/scenario/rm",
  "/scenario/count",
  "/core/read",
  "/core/write",
  "/core/count",
  "/pipeline/status",
]);

/**
 * Write an audit event to store.appendAudit. Failure does not block main request (tolerates audit loss).
 *
 * Calling convention (per user decision):
 *   - Original L0/L1/L2/L3 tables completely untouched, this function only appends events
 *   - team/agent/user/task comes from external request IdFields (ctx after resolveIsolation)
 *   - L0 does not participate (immutable stream)
 *   - The 5 mutation handlers call this once each:
 *     atomic/update + atomic/delete + scenario/write + scenario/rm + core/write
 */
async function recordAudit(
  store: IMemoryStore | undefined,
  args: {
    record_id: string;
    layer: "L1" | "L2" | "L3";
    action: "update" | "delete";
    iso?: {
      teamId?: string;
      userId?: string;
      agentId?: string;
      sessionId?: string;
      taskId?: string;
    };
    version: number;
    requestId: string;
    logger?: { warn?: (msg: string) => void };
  },
): Promise<void> {
  if (!store?.appendAudit) return; // store does not support audit → skip
  try {
    await store.appendAudit({
      audit_id: `audit-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      record_id: args.record_id,
      layer: args.layer,
      action: args.action,
      team_id: args.iso?.teamId,
      agent_id: args.iso?.agentId,
      user_id: args.iso?.userId,
      task_id: args.iso?.taskId,
      version: args.version,
      updated_at_ms: Date.now(),
      request_id: args.requestId,
    });
  } catch (err) {
    args.logger?.warn?.(
      `${TAG} audit append failed (${args.layer}/${args.action} record=${args.record_id}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ============================
// Dependencies injected at mount time
// ============================

export interface V2RouterDeps {
  /** Get the default IMemoryStore (standalone fallback). */
  getStore: () => IMemoryStore | undefined;
  /** Get the default EmbeddingService (standalone fallback). */
  getEmbedding: () => EmbeddingService | undefined;
  /** Get the default StorageAdapter (standalone fallback). */
  getStorage: () => StorageAdapter | undefined;
  logger: Logger;

  /**
   * Deploy mode of the gateway. Controls behaviors that diverge between
   * single-node open-source ("standalone") and cloud multi-tenant ("service"):
   *   - standalone: mirror v2 conversation/add L0 to <dataDir>/conversations/<date>.jsonl
   *                 (parity with v1 capture path; useful for human inspection / seed verify)
   *   - service:    skip the JSONL mirror — service stores authoritative L0 in TCVDB +
   *                 COS via its own pathway; mirroring to local FS would write to
   *                 ephemeral pod disk and is operationally meaningless.
   */
  deployMode: "standalone" | "service";

  // ── Service-mode per-instance resolvers (optional) ──
  // When provided, v2 handlers resolve store/storage per-request using
  // auth.serviceId as the instanceId key, falling back to the static getters above.

  /** Resolve IMemoryStore + EmbeddingService for a given instanceId (service mode). */
  resolveStore?: (
    instanceId: string,
  ) => Promise<{
    store: IMemoryStore;
    embedding: EmbeddingService | undefined;
  }>;
  /** Resolve per-instance StorageAdapter for a given instanceId (service mode). */
  resolveStorage?: (instanceId: string) => Promise<StorageAdapter | undefined>;

  /**
   * Notify pipeline that new L0 messages were added for a session.
   * Triggers async L1 extraction via state-backend Buffer → Scanner → Worker.
   *
   * Wired in both modes:
   *   - service mode: remote state backend
   *   - standalone: LocalStateBackend (single-process, default)
   * When absent (misconfiguration), v2 add writes L0 only — pipeline is not triggered.
   */
  notifyPipeline?: (
    instanceId: string,
    sessionId: string,
    messageCount: number,
    teamId?: string,
    agentId?: string,
  ) => Promise<void>;

  /** Quota manager for memory/credit limit checks and usage reporting (service mode). */
  quotaManager?: import("../core/quota/quota-manager.js").QuotaManager;

  /**
   * Get (per instance) MetadataService. Used only when /v3/conversation/add first
   * writes to a (team, agent) to automatically register chat_memory asset and bind to agent.
   * When not injected, this feature degrades gracefully: conversation still writes normally, just assets will not be automatically
   * created —— fully compatible with old deployments.
   */
  getMetadataService?: (
    instanceId: string,
  ) => Promise<
    import("../metadata/service/metadata-service.js").MetadataService
  >;

  /**
   * State backend handle, used by /v3/pipeline/status to call listQueuedTasks().
   * Wired in standalone and service modes, but the status endpoint itself is
   * standalone-only. The handler returns 404 in service mode before touching
   * this field, so remote backends do not need to implement listQueuedTasks().
   */
  stateBackend?: IStateBackend;

  /**
   * Pipeline worker handle, used by /v3/pipeline/status to call getRunningTasks()
   * for per-L-type in-flight stats. Service mode never invokes this getter
   * (status endpoint returns 404 in service mode).
   */
  pipelineWorker?: PipelineWorker;

  // ── Tenancy isolation (three-dim) ──
  //
  // `isolationConfig` is set once at gateway start.  `requestIsolation` and
  // `requestIsolationMissing` are filled per-request by dispatchV2Request so
  // each handler can persist (user_id, agent_id, session_id) on writes
  // without changing handler signatures.

  /** Static config for isolation enforcement (set at gateway start). */
  isolationConfig?: {
    enforce: boolean;
    legacyCompatMode: boolean;
    legacyPlaceholder: string;
  };
  /**
   * Whether `/v3` L0–L3 enforces the team+agent+user triple.
   * Undefined defaults to strict to preserve direct router unit-test semantics;
   * server.ts injects the env-backed value, whose runtime default is OFF.
   * `/v3/skill/*` is always exempt.
   */
  v3StrictIsolation?: boolean;
  /** Resolved isolation context for the current request (set by dispatch). */
  requestIsolation?: {
    teamId?: string;
    userId: string;
    agentId: string;
    sessionId: string;
    taskId?: string;
  };
  /** When isolation could not be resolved AND legacy_compat_mode is off, the missing fields. */
  requestIsolationMissing?: string[];
}

// ============================
// Envelope helpers
// ============================

export function makeRequestId(): string {
  return `req-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Prioritize upstream x-request-id / x-qcloud-transaction-id, otherwise generate locally. */
export function resolveRequestId(
  headers: Record<string, string | string[] | undefined>,
): string {
  const raw = headers["x-qcloud-transaction-id"] ?? headers["x-request-id"];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id === "string" && id.trim()) return id.trim();
  return makeRequestId();
}

export function successEnvelope<T>(
  data: T,
  requestId: string,
): ApiResponseEnvelope<T> {
  return { code: 0, message: "ok", request_id: requestId, data };
}

export function errorEnvelope(
  code: number,
  message: string,
  requestId: string,
  extra?: Record<string, unknown>,
): ApiResponseEnvelope {
  return {
    code,
    message,
    request_id: requestId,
    ...(extra ? { data: extra } : {}),
  };
}

// ============================
// Auth middleware
// ============================

export function parseV2Auth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestId: string,
  sendJsonFn: (res: http.ServerResponse, status: number, body: unknown) => void,
): V2AuthContext | null {
  const authHeader = req.headers["authorization"] ?? "";
  const serviceId = (req.headers["x-tdai-service-id"] as string) ?? "";

  if (!authHeader.startsWith("Bearer ") || !authHeader.slice(7).trim()) {
    sendJsonFn(
      res,
      401,
      errorEnvelope(
        401,
        "Missing or invalid Authorization header. Expected: Bearer {api_key}",
        requestId,
      ),
    );
    return null;
  }
  if (!serviceId.trim()) {
    sendJsonFn(
      res,
      401,
      errorEnvelope(401, "Missing x-tdai-service-id header", requestId),
    );
    return null;
  }

  return Object.fromEntries([
    ["apiKey", authHeader.slice(7).trim()],
    ["serviceId", serviceId.trim()],
  ]) as V2AuthContext;
}

// ============================
// Per-request resolution helpers
// ============================

/** Resolve store + embedding for a v2 request. Service mode → per-instance; standalone → core singleton. */
async function resolveStoreForRequest(
  auth: V2AuthContext,
  deps: V2RouterDeps,
): Promise<{
  store: IMemoryStore | undefined;
  embedding: EmbeddingService | undefined;
}> {
  if (deps.resolveStore) {
    // Service mode: per-instance VDB store is mandatory. Do NOT fallback to local SQLite.
    return await deps.resolveStore(auth.serviceId);
  }
  // Standalone mode: use core singleton store
  return { store: deps.getStore(), embedding: deps.getEmbedding() };
}

/** Resolve storage adapter for a v2 request. Service mode → per-instance COS; standalone → core local. */
async function resolveStorageForRequest(
  auth: V2AuthContext,
  deps: V2RouterDeps,
): Promise<StorageAdapter | undefined> {
  if (deps.resolveStorage) {
    // Service mode: per-instance COS storage is mandatory. Do NOT fallback to local filesystem.
    return await deps.resolveStorage(auth.serviceId);
  }
  // Standalone mode: use core local storage
  return deps.getStorage();
}

// ============================
// Route table
// ============================

type RouteHandler = (
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
) => Promise<ApiResponseEnvelope>;

/**
 * L0-L3 data plane handler mapping (subpath → handler). L0-L3 data plane serves /v3/* only (legacy /v2/* mounts removed);
 * count interface mounted only on /v3/* according to sdk-v3.yaml. /v3 uses strict isolation validation; /v2 uses existing enforce/legacyCompat config.
 */
const DATAPLANE_HANDLERS: Record<string, RouteHandler> = {
  "/conversation/add": handleConversationAdd,
  "/conversation/query": handleConversationQuery,
  "/conversation/search": handleConversationSearch,
  "/conversation/delete": handleConversationDelete,
  "/conversation/count": handleConversationCount,
  "/atomic/update": handleAtomicUpdate,
  "/atomic/query": handleAtomicQuery,
  "/atomic/search": handleAtomicSearch,
  "/atomic/delete": handleAtomicDelete,
  "/atomic/count": handleAtomicCount,
  "/scenario/ls": handleScenarioLs,
  "/scenario/read": handleScenarioRead,
  "/scenario/write": handleScenarioWrite,
  "/scenario/rm": handleScenarioRm,
  "/scenario/count": handleScenarioCount,
  "/core/read": handleCoreRead,
  "/core/write": handleCoreWrite,
  "/core/count": handleCoreCount,
};

const routeTable: Record<string, RouteHandler> = {
  // L0-L3 data plane: v3 only (strict isolation). Legacy /v2 dual entries removed.
  ...Object.fromEntries(
    Object.entries(DATAPLANE_HANDLERS).map(
      ([sub, h]) => [`${V3_PREFIX}${sub}`, h] as const,
    ),
  ),
  [`${V3_PREFIX}/pipeline/status`]: handlePipelineStatus,
};

export async function handleV2Route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: http.IncomingMessage) => Promise<T>,
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void,
  deps: V2RouterDeps,
  /**
   * Optional: extra routes contributed by other modules (e.g.
   * /v3/skill/* from `makeSkillRouteTable()`). Looked up only when the
   * built-in `routeTable` doesn't contain the pathname, so module-level
   * routes always win on collision. Supports `/v3/*` (L0–L3
   * data-plane + extraRouteTable for /v3/skill/*, /v3/knowledge/* and
   * /v3/chat-memory/*).
   *
   * The handler's `deps` parameter is intentionally typed `unknown` here:
   * extra modules (skill/*, future namespaces) declare their own deps
   * shape (e.g. `SkillRouterDeps`). The caller is responsible for passing
   * a `deps` object that satisfies the union of every handler set's
   * requirements; v2-router just forwards it verbatim.
   */
  extraRouteTable?: Record<
    string,
    (
      body: unknown,
      auth: V2AuthContext,
      requestId: string,
      deps: unknown,
    ) => Promise<ApiResponseEnvelope>
  >,
): Promise<boolean> {
  const isPromptRead =
    method === "GET" &&
    (pathname === "/v3/memory-prompt/get" ||
      pathname === "/v3/memory-prompt/setting/list" ||
      pathname === "/v3/memory-prompt/log" ||
      pathname === "/v3/memory-generation-log/list" ||
      pathname === "/v3/memory-generation-log/get");
  if (method !== "POST" && !isPromptRead) return false;
  const isV3 = pathname.startsWith(`${V3_PREFIX}/`);
  // Management-plane modules are provided by extraRouteTable, not by the
  // built-in V3 data-plane list. They bypass strict L0-L3 isolation because
  // each module validates its own target semantics.
  const isV3Extra =
    !!extraRouteTable &&
    (pathname.startsWith("/v3/skill/") ||
      pathname.startsWith("/v3/knowledge/") ||
      pathname.startsWith("/v3/chat-memory/") ||
      pathname.startsWith("/v3/memory-prompt/") ||
      pathname.startsWith("/v3/memory-generation-log/"));
  if (!isV3) return false;

  // /v3 exposes L0-L3 data plane 14 routes (V3_ALLOWED_SUBPATHS) + /v3/skill/* + /v3/knowledge/* (extraRouteTable);
  // Other /v3 subpaths route directly to 404
  if (isV3 && !isV3Extra) {
    const sub = pathname.slice(V3_PREFIX.length);
    if (!V3_ALLOWED_SUBPATHS.has(sub)) return false;
  }

  const handler = routeTable[pathname];
  const extra = extraRouteTable?.[pathname];
  if (!handler && !extra) return false;

  const requestId = makeRequestId();
  // [skill-perf 2026-07-21] Only record segment latency for /v3/skill/, avoiding pollution of other link logs.
  // T0 taken from server.ts socket-level instrumentation; fallback to dispatch entry time if missing.
  const isSkillPerf = pathname.startsWith("/v3/skill/");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const perfT0 = isSkillPerf
    ? (((req as any).__skillPerfT0 as number | undefined) ?? Date.now())
    : 0;
  // Attach request_id to res, so server.ts res.on(finish) can include it
  if (isSkillPerf) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).__skillReqId = requestId;
    deps.logger.info(
      `[skill-perf] dispatch.enter req_id=${requestId} path=${pathname} t=${Date.now()} t0_offset=${Date.now() - perfT0}ms`,
    );
  }
  const perfMark = (phase: string, extraFields?: string) => {
    if (!isSkillPerf) return;
    const now = Date.now();
    deps.logger.info(
      `[skill-perf] phase=${phase} req_id=${requestId} elapsed=${now - perfT0}ms${extraFields ? " " + extraFields : ""}`,
    );
  };

  const authStart = Date.now();
  const auth = parseV2Auth(req, res, requestId, sendJson);
  if (isSkillPerf) {
    perfMark(
      "parseAuth",
      `dur=${Date.now() - authStart}ms ok=${auth ? "true" : "false"}`,
    );
  }
  if (!auth) return true;

  try {
    // Pre-resolve per-request store/storage (service mode → per-instance, standalone → core singleton)
    const resolveStart = Date.now();
    const resolved = await resolveStoreForRequest(auth, deps);
    const resolvedStorage = await resolveStorageForRequest(auth, deps);
    perfMark(
      "resolveStoreAndStorage",
      `dur=${Date.now() - resolveStart}ms serviceId=${auth.serviceId}`,
    );

    // Wrap deps so handlers use the resolved per-instance resources
    const resolvedDeps: V2RouterDeps = {
      ...deps,
      getStore: () => resolved.store,
      getEmbedding: () => resolved.embedding,
      getStorage: () => resolvedStorage,
    };

    const bodyStart = Date.now();
    const body =
      method === "GET"
        ? Object.fromEntries(
            new URL(
              req.url ?? pathname,
              "http://localhost",
            ).searchParams.entries(),
          )
        : await parseJsonBody(req);
    perfMark(
      "parseJsonBody",
      `dur=${Date.now() - bodyStart}ms len=${req.headers["content-length"] ?? "?"}`,
    );

    // Tenancy isolation — pulled from body (preferred) or x-tdai-* headers
    // and attached to the per-request deps so handlers can persist
    // (user_id, agent_id, session_id) on every L0/L1 write without
    // changing every handler signature.
    //
    // We only attempt resolution; whether missing fields are fatal is up
    // to each handler (some endpoints don't need isolation at all, e.g.
    // /v3/pipeline/status). See resolveIsolation() in v2-schemas.
    //
    // /v3 strictly validates: must simultaneously provide team_id + agent_id + user_id + session_id,
    // Missing any directly returns 422, and no fallback to legacyCompatMode.
    const headers = (req.headers ?? {}) as Record<
      string,
      string | string[] | undefined
    >;
    const isoLegacyCompat = false;
    const isoResolved = resolveIsolation(
      body as Record<string, unknown> | undefined,
      headers,
      {
        legacyCompatMode: isoLegacyCompat,
        legacyPlaceholder: deps.isolationConfig?.legacyPlaceholder,
      },
    );

    // /v3 strict isolation is for L0–L3 memory data-plane only.
    // Skill and knowledge endpoints are team-scoped management-plane
    // and must not be blocked by per-agent memory isolation.
    // Runtime default comes from server.ts/env and is OFF;
    // undefined keeps strict in direct router tests for backward compatibility.
    const v3StrictEnabled = deps.v3StrictIsolation ?? true;
    // /pipeline/status is instance-level introspection without isolation semantics — exempt from the triad check.
    const v3IsolationExempt =
      pathname.slice(V3_PREFIX.length) === "/pipeline/status";
    if (isV3 && !isV3Extra && v3StrictEnabled && !v3IsolationExempt) {
      const v3Subpath = pathname.slice(V3_PREFIX.length);
      const v3Missing = collectV3Missing(
        v3Subpath,
        body as Record<string, unknown> | undefined,
        headers,
      );
      if (v3Missing.length > 0) {
        sendJson(
          res,
          422,
          errorEnvelope(
            422,
            `/v3 requires strict isolation: missing ${v3Missing.join(", ")}. ` +
              `Provide via request body or x-tdai-{team-id,agent-id,user-id,session-id} headers.`,
            requestId,
          ),
        );
        return true;
      }
    }

    const depsWithIsolation: V2RouterDeps = {
      ...resolvedDeps,
      // /v3 path forcibly overrides isolationConfig.enforce, ensuring handlers internally consistently hit strict branch
      isolationConfig: {
        enforce: true,
        legacyCompatMode: false,
        legacyPlaceholder:
          resolvedDeps.isolationConfig?.legacyPlaceholder ?? "",
      },
      requestIsolation: isoResolved.ctx,
      // resolveIsolation always returns { ok: true } — missing fields are filled with defaults.
      // requestIsolationMissing is only set when the caller explicitly needs to reject incomplete
      // isolation (e.g. /v3 strict mode), which is handled separately above via collectV3Missing.
      requestIsolationMissing: undefined,
    };

    const handlerStart = Date.now();
    const envelope = handler
      ? await handler(body, auth, requestId, depsWithIsolation)
      : await extra!(body, auth, requestId, depsWithIsolation as unknown);
    perfMark(
      "handler",
      `dur=${Date.now() - handlerStart}ms envelope_code=${envelope.code}`,
    );
    const httpStatus =
      envelope.code === 0
        ? 200
        : envelope.code >= 400 && envelope.code < 600
          ? envelope.code
          : 200;
    const sendStart = Date.now();
    sendJson(res, httpStatus, envelope);
    perfMark(
      "sendJson",
      `dur=${Date.now() - sendStart}ms status=${httpStatus}`,
    );
  } catch (err) {
    // H-13: use classifyError so 5xx leaves no err.message leak; PayloadTooLargeError
    // and RecallFailure already carry safe messages but go through the same path for uniformity.
    const classified = classifyError(err);
    if (classified.status >= 500) {
      deps.logger.error(`${TAG} [${pathname}] ${classified.logLine}`);
    } else {
      deps.logger.warn(`${TAG} [${pathname}] ${classified.logLine}`);
    }
    sendJson(res, classified.status, {
      ...errorEnvelope(
        classified.client.code,
        classified.client.message,
        requestId,
      ),
      trace_id: classified.client.trace_id,
      retryable: classified.client.retryable,
    });
  }

  return true;
}

// ============================
// L0 Conversation Handlers
// ============================

async function handleConversationAdd(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = conversationAddRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { session_id, messages } = parsed.data;

  // Enforce three-dim isolation. user_id / agent_id come from request body
  // or x-tdai-* headers (resolved in dispatchV2Request).  When the gateway's
  // isolationConfig.enforce is on AND legacy_compat_mode is off, missing
  // fields are a 422.
  if (
    deps.isolationConfig?.enforce &&
    deps.requestIsolationMissing &&
    deps.requestIsolationMissing.length > 0
  ) {
    return errorEnvelope(
      422,
      `Tenancy isolation required: missing ${deps.requestIsolationMissing.join(", ")}. ` +
        `Provide via request body or x-tdai-{user-id,agent-id,session-id} headers.`,
      requestId,
    );
  }
  const iso = deps.requestIsolation;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // Quota check: memory limit
  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(
      auth.serviceId,
      messages.length,
    );
    if (!check.allowed) {
      return errorEnvelope(
        4291,
        `Memory limit exceeded (current=${check.current}, limit=${check.limit})`,
        requestId,
      );
    }
  }

  // Automatically register chat_memory asset (team+agent level) and bind to agent. First trigger
  // creates asset + appends binding; subsequent same (team, agent) hits in-process LRU short-circuit.
  // Failure degradation: log warn only, do not block conversation write —— memory data availability takes precedence
  // over asset registration consistency (asset registration failure will auto-retry on next call).
  if (deps.getMetadataService && iso?.teamId && iso?.agentId) {
    try {
      const metaSvc = await deps.getMetadataService(auth.serviceId);
      await metaSvc.ensureChatMemoryAsset({
        team_id: iso.teamId,
        agent_id: iso.agentId,
      });
    } catch (err) {
      deps.logger.warn(
        `${TAG} ensureChatMemoryAsset failed (team=${iso.teamId} agent=${iso.agentId}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const embedding = deps.getEmbedding();
  const acceptedIds: string[] = [];
  const acceptedRecords: L0Record[] = [];
  const ingestBaseMs = Date.now();

  for (const [index, msg] of messages.entries()) {
    const id = `msg-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const ingestRecordedAtMs = ingestBaseMs + index;
    const recordedAtMs = msg.recorded_at
      ? new Date(msg.recorded_at).getTime()
      : ingestRecordedAtMs;
    const record: L0Record = {
      id,
      sessionKey: session_id,
      sessionId: session_id,
      taskId: iso?.taskId,
      // Tenancy isolation: resolveIsolation() defaults missing fields to the default bucket.
      teamId: iso?.teamId,
      userId: iso?.userId,
      agentId: iso?.agentId,
      role: msg.role,
      messageText: msg.content,
      recordedAt: new Date(recordedAtMs).toISOString(),
      timestamp: msg.timestamp
        ? new Date(msg.timestamp).getTime()
        : recordedAtMs,
    };

    let emb: Float32Array | undefined;
    if (embedding) {
      try {
        emb = await embedding.embed(msg.content);
      } catch (e) {
        console.warn(`[v2-router] L0 embedding failed:`, e);
      }
    }

    await store.upsertL0(record, emb);
    acceptedIds.push(id);
    acceptedRecords.push(record);
  }

  // Notify pipeline: trigger async L1 extraction (service mode).
  // Each role=user message counts as one conversation round for threshold/timer logic.
  // teamId/agentId passed to captureAtomic deciding hash slot and lock granularity.
  if (deps.notifyPipeline) {
    const rounds = messages.filter((m) => m.role === "user").length;
    if (rounds > 0) {
      try {
        await deps.notifyPipeline(
          auth.serviceId,
          session_id,
          rounds,
          iso?.teamId,
          iso?.agentId,
        );
      } catch (err) {
        // Non-fatal: L0 is already persisted, pipeline will catch up later
        deps.logger.warn(
          `${TAG} Pipeline notify failed for ${session_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Standalone-only: mirror L0 to <dataDir>/conversations/<date>.jsonl.
  // Parity with v1 /capture (l0-recorder) path — gives humans a grep-able audit
  // log alongside SQLite. Service mode skips: COS is the authoritative store,
  // and writing to local FS in a multi-replica pod would be ephemeral + useless.
  // Failure is non-fatal: SQLite is the source of truth.
  if (deps.deployMode === "standalone") {
    const storage = deps.getStorage();
    if (storage) {
      try {
        const linesByRecordKey = new Map<string, string[]>();
        for (const record of acceptedRecords) {
          const recordKey = StoragePaths.conversation(
            formatLocalDateForJsonl(new Date(record.recordedAt)),
          );
          const lines = linesByRecordKey.get(recordKey) ?? [];
          lines.push(
            JSON.stringify({
              id: record.id,
              sessionKey: record.sessionKey,
              sessionId: record.sessionId,
              taskId: record.taskId,
              teamId: record.teamId,
              userId: record.userId,
              agentId: record.agentId,
              role: record.role,
              content: record.messageText,
              recordedAt: record.recordedAt,
              timestamp: record.timestamp,
            }),
          );
          linesByRecordKey.set(recordKey, lines);
        }
        for (const [recordKey, lines] of linesByRecordKey) {
          await storage.appendFile(recordKey, `${lines.join("\n")}\n`);
        }
      } catch (err) {
        deps.logger.warn(
          `${TAG} JSONL mirror failed for ${session_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Report memory usage (non-fatal)
  if (deps.quotaManager && acceptedIds.length > 0) {
    deps.quotaManager
      .reportMemoryAdded(auth.serviceId, acceptedIds.length)
      .catch(() => {});
  }

  return successEnvelope<ConversationAddData>(
    {
      accepted_ids: acceptedIds,
      accepted_versions: acceptedIds.map(() => "v1"),
      total_count: acceptedIds.length,
    },
    requestId,
  );
}

async function handleConversationQuery(
  body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = conversationQueryRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { session_id, time_start, time_end } = parsed.data;
  const limit = parsed.data.limit ?? 20;
  const offset = parsed.data.offset ?? 0;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // Tenancy isolation — narrow the query when caller supplied user_id /
  // agent_id (via body or headers). session_id, if present, comes from the
  // request body and is already in `session_id`.
  const iso = deps.requestIsolation;

  // Use paginated query if available (AR-3), else fallback
  if (store.queryL0Paginated) {
    const result = await store.queryL0Paginated({
      sessionId: session_id,
      teamId: iso?.teamId,
      userId: iso?.userId,
      agentId: iso?.agentId,
      taskId: iso?.taskId,
      timeStartMs: time_start ? new Date(time_start).getTime() : undefined,
      timeEndMs: time_end ? new Date(time_end).getTime() : undefined,
      limit,
      offset,
    });

    const messages: ConversationItem[] = result.rows.map((r) => ({
      id: r.record_id,
      session_id: r.session_id,
      team_id: r.team_id,
      user_id: r.user_id,
      agent_id: r.agent_id,
      task_id: r.task_id,
      role: r.role as ConversationItem["role"],
      content: r.message_text,
      timestamp: r.recorded_at,
    }));

    return successEnvelope<ConversationQueryData>(
      { messages, total: result.total },
      requestId,
    );
  }

  // Fallback: legacy path (capped at 1000 for safety)
  const allRows = await store.queryL0ForL1(session_id ?? "", undefined, 1000);
  let filtered = session_id
    ? allRows.filter(
        (r) => r.session_key === session_id || r.session_id === session_id,
      )
    : allRows;
  // Tenancy isolation post-filter for the legacy path.
  if (iso?.teamId) filtered = filtered.filter((r) => r.team_id === iso.teamId);
  if (iso?.userId) filtered = filtered.filter((r) => r.user_id === iso.userId);
  if (iso?.agentId)
    filtered = filtered.filter((r) => r.agent_id === iso.agentId);
  if (iso?.taskId) filtered = filtered.filter((r) => r.task_id === iso.taskId);
  if (time_start) {
    const ms = new Date(time_start).getTime();
    filtered = filtered.filter((r) => r.timestamp >= ms);
  }
  if (time_end) {
    const ms = new Date(time_end).getTime();
    filtered = filtered.filter((r) => r.timestamp <= ms);
  }
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  const messages: ConversationItem[] = page.map((r) => ({
    id: r.record_id,
    session_id: r.session_id,
    team_id: r.team_id,
    user_id: r.user_id,
    agent_id: r.agent_id,
    task_id: r.task_id,
    role: r.role as ConversationItem["role"],
    content: r.message_text,
    timestamp: r.recorded_at,
  }));

  return successEnvelope<ConversationQueryData>({ messages, total }, requestId);
}

async function handleConversationCount(
  body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = conversationCountRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { session_id, time_start, time_end } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  const iso = deps.requestIsolation;

  const countFilter = {
    sessionId: session_id,
    teamId: iso?.teamId,
    userId: iso?.userId,
    agentId: iso?.agentId,
    taskId: iso?.taskId,
    timeStartMs: time_start ? new Date(time_start).getTime() : undefined,
    timeEndMs: time_end ? new Date(time_end).getTime() : undefined,
  };
  const total = await store.countL0(countFilter);
  return successEnvelope<CountData>({ total }, requestId);

  const allRows = await store.queryL0ForL1(session_id ?? "", undefined, 10000);
  let filtered = session_id
    ? allRows.filter(
        (r) => r.session_key === session_id || r.session_id === session_id,
      )
    : allRows;
  if (iso?.teamId) filtered = filtered.filter((r) => r.team_id === iso.teamId);
  if (iso?.userId) filtered = filtered.filter((r) => r.user_id === iso.userId);
  if (iso?.agentId)
    filtered = filtered.filter((r) => r.agent_id === iso.agentId);
  if (iso?.taskId) filtered = filtered.filter((r) => r.task_id === iso.taskId);
  if (time_start) {
    const ms = new Date(time_start).getTime();
    filtered = filtered.filter((r) => r.timestamp >= ms);
  }
  if (time_end) {
    const ms = new Date(time_end).getTime();
    filtered = filtered.filter((r) => r.timestamp <= ms);
  }
  return successEnvelope<CountData>({ total: filtered.length }, requestId);
}

async function handleConversationSearch(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = conversationSearchRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { query, session_id } = parsed.data;
  const limit = parsed.data.limit ?? 5;

  const tStart = performance.now();
  // Search scenario: Only use explicitly passed isolation dimensions as filter, to avoid default sessionId="default" erroneously filtering real session data.
  // When request misses session_id, search should span sessions; when session_id is passed, filter by sessionKey parameter alone.
  const iso = deps.requestIsolation;
  const searchFilter = iso
    ? {
        ...(iso.teamId ? { teamId: iso.teamId } : {}),
        ...(iso.userId ? { userId: iso.userId } : {}),
        ...(iso.agentId ? { agentId: iso.agentId } : {}),
        ...(iso.taskId ? { taskId: iso.taskId } : {}),
        // Missed sessionId: global search should not be restricted by default sessionId
      }
    : undefined;
  const result = await executeConversationSearch({
    query,
    limit,
    sessionKey: session_id,
    filter: searchFilter,
    vectorStore: deps.getStore(),
    embeddingService: deps.getEmbedding(),
    logger: deps.logger,
  });
  const recallLatencyMs = performance.now() - tStart;

  // Non-invasive recall metric reporting (service mode, silent failure, never affect business return)
  // L0 conversation search also belongs to "recall" action, strategy mapping logic identical to L1
  try {
    reportRecallMetrics({
      instanceId: auth.serviceId,
      recalledL1Memories: result.results.map((r) => ({
        content: r.content,
        score: r.score,
        type: "conversation",
      })),
      recallStrategy:
        result.strategy === "fts"
          ? "keyword"
          : result.strategy === "none"
            ? "skipped"
            : result.strategy,
      recallLatencyMs,
      hasError: false,
    });
  } catch {
    // Silent failure
  }

  // Non-invasive record of recall query and results on current Span
  try {
    const otelApi = await import("@opentelemetry/api");
    const activeSpan = otelApi.trace.getSpan(otelApi.context.active());
    if (activeSpan) {
      activeSpan.setAttribute("tdai.recall.query", query);
      activeSpan.setAttribute("tdai.recall.hitCount", result.results.length);
      activeSpan.setAttribute(
        "tdai.recall.strategy",
        result.strategy || "unknown",
      );
      activeSpan.setAttribute("tdai.recall.level", "l0");
      if (result.results.length > 0) {
        activeSpan.setAttribute(
          "tdai.recall.topScore",
          Math.max(...result.results.map((r) => r.score)),
        );
        const truncatedResults = result.results.slice(0, 5).map((r) => ({
          content: r.content.substring(0, 200),
          score: r.score,
        }));
        activeSpan.setAttribute(
          "tdai.recall.results",
          JSON.stringify(truncatedResults),
        );
      } else {
        activeSpan.setAttribute("tdai.recall.results", "[]");
      }
    }
  } catch {
    // Silent failure
  }

  const messages: ConversationSearchHit[] = result.results.map((r) => ({
    id: r.id,
    role: r.role as ConversationSearchHit["role"],
    content: r.content,
    timestamp: r.recorded_at,
    score: r.score,
  }));

  return successEnvelope<ConversationSearchData>({ messages }, requestId);
}

async function handleConversationDelete(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = conversationDeleteRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  // schema is normalized: message_ids / session_ids are both deduplicated arrays (singular session_id merged in).
  const { message_ids, session_ids } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // Deletion scope is (team, user, agent), **excluding session**.
  // /v3 strict isolation requires request header with session_id, but deletion semantics is "delete specific
  // message / session", if requestIsolation.sessionId is also stuffed into filter,
  // it can only delete current session —— batch deleting multiple sessions silently filtered to 0 entries.
  const iso = deps.requestIsolation;
  const scope = iso
    ? {
        teamId: iso.teamId,
        userId: iso.userId,
        agentId: iso.agentId,
        taskId: iso.taskId,
      }
    : undefined;

  // message_ids and session_ids can both be provided; both paths run, use id set deduplication to avoid
  // same message being repeatedly counted by session path.
  const deletedRecordIds = new Set<string>();

  for (const id of message_ids) {
    const ok = await store.deleteL0(id, scope);
    if (ok) deletedRecordIds.add(id);
  }

  let sessionDeletedCount = 0;
  for (const sessionId of session_ids) {
    if (store.deleteL0BySession) {
      sessionDeletedCount += await store.deleteL0BySession(sessionId, scope);
      continue;
    }
    // Fallback: if store has not implemented delete by session, delete one by one.
    const rows = await store.queryL0ForL1(sessionId, undefined, 10000);
    const sessionRows = rows.filter(
      (r) => r.session_key === sessionId || r.session_id === sessionId,
    );
    for (const row of sessionRows) {
      if (deletedRecordIds.has(row.record_id)) continue;
      const ok = await store.deleteL0(row.record_id, scope);
      if (ok) deletedRecordIds.add(row.record_id);
    }
  }

  // deleteL0BySession only returns row count (no ids), so counts of both paths are added.
  // In the same request batch, overlap between message_ids and session_ids might lightly repeat count,
  // this is an existing limitation of store interface, not affecting actual deletion correctness.
  const deletedCount = deletedRecordIds.size + sessionDeletedCount;

  // Report memory deletion (non-fatal)
  if (deps.quotaManager && deletedCount > 0) {
    deps.quotaManager
      .reportMemoryDeleted(auth.serviceId, deletedCount)
      .catch(() => {});
  }

  return successEnvelope<ConversationDeleteData>(
    { deleted_count: deletedCount },
    requestId,
  );
}

async function handleAtomicUpdate(
  body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = atomicUpdateRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { id, content, background } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // Read existing record by primary key
  const existing = await store.queryL1Records({ recordIds: [id] });
  if (!existing || existing.length === 0) {
    return errorEnvelope(404, `Atomic note not found: ${id}`, requestId);
  }

  const now = new Date().toISOString();
  const record = existing[0];

  // Build update: content is always overwritten; background (scene_name) only if provided.
  // user_id / agent_id are preserved from the existing row — updates don't
  // re-derive them. If the caller supplied an isolation triple that does NOT
  // match the existing row, we treat it as a permission denial.
  const iso = deps.requestIsolation;
  if (iso?.userId && record.user_id && record.user_id !== iso.userId) {
    return errorEnvelope(
      403,
      `Atomic note ${id} belongs to a different user`,
      requestId,
    );
  }
  if (iso?.agentId && record.agent_id && record.agent_id !== iso.agentId) {
    return errorEnvelope(
      403,
      `Atomic note ${id} belongs to a different agent`,
      requestId,
    );
  }
  const updatedVersion = (record.version ?? 0) + 1;
  const updated: MemoryRecord = {
    id,
    content,
    type: record.type as any,
    priority: record.priority ?? 50,
    scene_name:
      background === undefined ? (record.scene_name ?? "") : background,
    source_message_ids: [],
    metadata: parseMetadataJson(record.metadata_json),
    timestamps: record.timestamp_str ? [record.timestamp_str] : [],
    createdAt: record.created_time,
    updatedAt: now,
    version: updatedVersion,
    sessionKey: record.session_key ?? "",
    sessionId: record.session_id ?? iso?.sessionId ?? "",
    taskId: record.task_id ?? iso?.taskId,
    teamId: record.team_id ?? iso?.teamId,
    userId: record.user_id ?? iso?.userId,
    agentId: record.agent_id ?? iso?.agentId,
  };

  const embedding = deps.getEmbedding();
  let emb: Float32Array | undefined;
  if (embedding) {
    try {
      emb = await embedding.embed(content);
    } catch (e) {
      console.warn(`[v2-router] L1 embedding failed:`, e);
    }
  }

  await store.upsertL1(updated, emb);

  // Audit: L1 update — use external request IdFields instead of record original value (per user decision)
  await recordAudit(store, {
    record_id: id,
    layer: "L1",
    action: "update",
    iso,
    version: updatedVersion,
    requestId,
    logger: deps.logger,
  });

  return successEnvelope<AtomicUpdateData>(
    { id, version: `v${updatedVersion}`, updated_at: now },
    requestId,
  );
}

async function handleAtomicQuery(
  body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = atomicQueryRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { type, time_start, time_end } = parsed.data;
  const limit = parsed.data.limit ?? 20;
  const offset = parsed.data.offset ?? 0;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // Tenancy isolation — narrow the query by user_id / agent_id when supplied.
  const iso = deps.requestIsolation;

  // Use paginated query if available
  if (store.queryL1Paginated) {
    const result = await store.queryL1Paginated({
      type,
      timeStart: time_start,
      timeEnd: time_end,
      limit,
      offset,
      teamId: iso?.teamId,
      userId: iso?.userId,
      agentId: iso?.agentId,
      taskId: iso?.taskId,
    });
    const items: AtomicDetail[] = result.rows.map((r) => ({
      id: r.record_id,
      type: r.type,
      content: r.content,
      background: r.scene_name || undefined,
      version: r.version ?? 0,
      team_id: r.team_id,
      user_id: r.user_id,
      agent_id: r.agent_id,
      task_id: r.task_id,
      created_at: r.created_time,
      updated_at: r.updated_time,
    }));
    return successEnvelope<AtomicQueryData>(
      { items, total: result.total },
      requestId,
    );
  }

  // Fallback: legacy
  const allRecords = await store.queryL1Records();
  let filtered = allRecords;
  if (type) filtered = filtered.filter((r) => r.type === type);
  if (iso?.teamId) filtered = filtered.filter((r) => r.team_id === iso.teamId);
  if (iso?.userId) filtered = filtered.filter((r) => r.user_id === iso.userId);
  if (iso?.agentId)
    filtered = filtered.filter((r) => r.agent_id === iso.agentId);
  if (iso?.taskId) filtered = filtered.filter((r) => r.task_id === iso.taskId);
  if (time_start)
    filtered = filtered.filter((r) => r.updated_time >= time_start);
  if (time_end) filtered = filtered.filter((r) => r.updated_time <= time_end);
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  const items: AtomicDetail[] = page.map((r) => ({
    id: r.record_id,
    type: r.type,
    content: r.content,
    background: r.scene_name || undefined,
    version: r.version ?? 0,
    team_id: r.team_id,
    user_id: r.user_id,
    agent_id: r.agent_id,
    task_id: r.task_id,
    created_at: r.created_time,
    updated_at: r.updated_time,
  }));

  return successEnvelope<AtomicQueryData>({ items, total }, requestId);
}

async function handleAtomicCount(
  body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = atomicCountRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { type, time_start, time_end } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  const iso = deps.requestIsolation;

  const total = await store.countL1({
    type,
    timeStart: time_start,
    timeEnd: time_end,
    teamId: iso?.teamId,
    userId: iso?.userId,
    agentId: iso?.agentId,
    taskId: iso?.taskId,
  });
  return successEnvelope<CountData>({ total }, requestId);
}

async function handleAtomicSearch(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = atomicSearchRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { query, type } = parsed.data;
  const limit = parsed.data.limit ?? 5;

  const tStart = performance.now();
  // L1 recall is agent dimension (cross-session): filter only takes team/user/agent/task,
  // **without sessionId**, otherwise it will filter out L1 memories written by other sessions, causing
  // new session unable to recall history memories (consistent with conversation/search handling).
  const iso = deps.requestIsolation;
  const searchFilter = iso
    ? {
        ...(iso.teamId ? { teamId: iso.teamId } : {}),
        ...(iso.userId ? { userId: iso.userId } : {}),
        ...(iso.agentId ? { agentId: iso.agentId } : {}),
        ...(iso.taskId ? { taskId: iso.taskId } : {}),
        // Missed sessionId: L1 recall should span session (agent dimension)
      }
    : undefined;
  const result = await executeMemorySearch({
    query,
    limit,
    type,
    filter: searchFilter,
    vectorStore: deps.getStore(),
    embeddingService: deps.getEmbedding(),
    logger: deps.logger,
  });
  const recallLatencyMs = performance.now() - tStart;

  // Non-invasive recall metric reporting (service mode, silent failure, never affect business return)
  try {
    reportRecallMetrics({
      instanceId: auth.serviceId,
      recalledL1Memories: result.results.map((r) => ({
        content: r.content,
        score: r.score,
        type: r.type,
      })),
      recallStrategy:
        result.strategy === "fts"
          ? "keyword"
          : result.strategy === "none"
            ? "skipped"
            : result.strategy,
      recallLatencyMs,
      hasError: false,
    });
  } catch {
    // Silent failure
  }

  // Non-invasive record of recall query and results on current Span, for online evaluation system consumption
  try {
    const { getObservabilityBackend } = await import(
      "../core/report/factory.js"
    );
    const ctx =
      getObservabilityBackend().tracePropagation.serializeTraceContext();
    if (ctx && (ctx as any)._traceId) {
      // Add attributes to current span via OTel API
      try {
        const otelApi = await import("@opentelemetry/api");
        const activeSpan = otelApi.trace.getSpan(otelApi.context.active());
        if (activeSpan) {
          activeSpan.setAttribute("tdai.recall.query", query);
          activeSpan.setAttribute(
            "tdai.recall.hitCount",
            result.results.length,
          );
          activeSpan.setAttribute(
            "tdai.recall.strategy",
            result.strategy || "unknown",
          );
          if (result.results.length > 0) {
            activeSpan.setAttribute(
              "tdai.recall.topScore",
              Math.max(...result.results.map((r) => r.score)),
            );
            // Limit results attribute length (OTel attributes shouldn	 be too long), at most first 5 entries
            const truncatedResults = result.results.slice(0, 5).map((r) => ({
              content: r.content.substring(0, 200),
              score: r.score,
              type: r.type,
            }));
            activeSpan.setAttribute(
              "tdai.recall.results",
              JSON.stringify(truncatedResults),
            );
          } else {
            activeSpan.setAttribute("tdai.recall.results", "[]");
          }
          activeSpan.setAttribute(
            "tdai.recall.level",
            type === "l0" ? "l0" : "l1",
          );
        }
      } catch {
        // Silent degradation when OTel API unavailable
      }
    }
  } catch {
    // Silent failure
  }

  const items: AtomicSearchHit[] = result.results.map((r) => ({
    id: r.id,
    type: r.type,
    content: r.content,
    background: r.scene_name || undefined,
    version: r.version ?? 0,
    team_id: r.team_id,
    user_id: r.user_id,
    agent_id: r.agent_id,
    task_id: r.task_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    score: r.score,
  }));

  return successEnvelope<AtomicSearchData>({ items }, requestId);
}

async function handleAtomicDelete(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = atomicDeleteRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { ids } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // deleteL1Batch returns bool, but we need actual count
  // Fall back to per-id deletion for accurate counting
  // When deleting by id, only use explicitly passed isolation dimension as filter.
  // Avoid default sessionId="default" causing real sessions L1 records unable to delete.
  const iso = deps.requestIsolation;
  const deleteFilter = iso
    ? {
        ...(iso.teamId ? { teamId: iso.teamId } : {}),
        ...(iso.userId ? { userId: iso.userId } : {}),
        ...(iso.agentId ? { agentId: iso.agentId } : {}),
        ...(iso.taskId ? { taskId: iso.taskId } : {}),
        // Missed sessionId: deletion by id should not be restricted by default sessionId
      }
    : undefined;
  let deletedCount = 0;
  const deletedIds: string[] = [];
  for (const id of ids) {
    const ok = await store.deleteL1(id, deleteFilter);
    if (ok) {
      deletedCount++;
      deletedIds.push(id);
    }
  }

  // Audit: L1 delete — one row of audit per deleted entry
  for (const id of deletedIds) {
    await recordAudit(store, {
      record_id: id,
      layer: "L1",
      action: "delete",
      iso: deps.requestIsolation,
      version: 0, // deleted, no new version
      requestId,
      logger: deps.logger,
    });
  }

  // Report memory deletion (non-fatal)
  if (deps.quotaManager && deletedCount > 0) {
    deps.quotaManager
      .reportMemoryDeleted(auth.serviceId, deletedCount)
      .catch(() => {});
  }

  return successEnvelope<AtomicDeleteData>(
    { deleted_count: deletedCount },
    requestId,
  );
}

// ============================
// Entity Metadata Handlers (Team / User / Agent / Task)
// ============================

// ============================
// L2/L3 Profile Sync Helpers (write-through to VDB)
// ============================

type RequestIsolation = {
  teamId?: string;
  userId: string;
  agentId: string;
  sessionId: string;
  taskId?: string;
};

function buildIsolationScope(isolation?: RequestIsolation): string {
  return isolation
    ? buildProfileIsolationScope(isolation)
    : DEFAULT_PROFILE_SCOPE;
}

function buildIsolationStoragePrefix(isolation: RequestIsolation): string {
  return `profiles/${encodeURIComponent(buildIsolationScope(isolation))}/`;
}

function scopedProfileStorage(
  storage: StorageAdapter,
  isolation?: RequestIsolation,
): StorageAdapter {
  // Direct unit callers may not go through handleV2Route and therefore do not
  // have requestIsolation attached. Keep that legacy path at root; real HTTP
  // requests always resolve to either explicit ids or the `default` bucket.
  if (!isolation) return storage;
  return createScopedStorageAdapter(
    storage,
    buildIsolationStoragePrefix(isolation),
  );
}

function md5Hex(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

function parseMetadataJson(raw: string | undefined): MemoryRecord["metadata"] {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as MemoryRecord["metadata"])
      : {};
  } catch {
    return {};
  }
}

async function getProfileVersion(
  store: IMemoryStore | undefined,
  type: "l2" | "l3",
  filename: string,
  isolation?: RequestIsolation,
): Promise<number> {
  if (!store) return 0;
  const scope = buildIsolationScope(isolation);
  const id = buildProfileStableId(scope, type, filename);
  try {
    // Prioritize lightweight by-id query, avoid full pullProfiles()
    if (typeof store.queryProfilesByIds === "function") {
      const results = await store.queryProfilesByIds([id]);
      return results[0]?.version ?? 0;
    }
    if (typeof store.pullProfiles === "function") {
      const existing = (await store.pullProfiles()).find((r) => r.id === id);
      return existing?.version ?? 0;
    }
  } catch {
    // fall through
  }
  return 0;
}

/**
 * Batch obtain multiple profile versions, one query.
 * Prioritize queryProfilesByIds (lightweight), fallback to pullProfiles (full).
 */
async function getProfileVersionBatch(
  store: IMemoryStore | undefined,
  type: "l2" | "l3",
  filenames: string[],
  isolation?: RequestIsolation,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!store || filenames.length === 0) return result;
  const scope = buildIsolationScope(isolation);
  const ids = filenames.map((fn) => buildProfileStableId(scope, type, fn));
  try {
    if (typeof store.queryProfilesByIds === "function") {
      const records = await store.queryProfilesByIds(ids);
      const versionMap = new Map(records.map((r) => [r.id, r.version]));
      for (let i = 0; i < filenames.length; i++) {
        result.set(filenames[i], versionMap.get(ids[i]) ?? 0);
      }
      return result;
    }
    if (typeof store.pullProfiles === "function") {
      const all = await store.pullProfiles();
      const versionMap = new Map(all.map((r) => [r.id, r.version]));
      for (let i = 0; i < filenames.length; i++) {
        result.set(filenames[i], versionMap.get(ids[i]) ?? 0);
      }
      return result;
    }
  } catch {
    // fall through
  }
  return result;
}

/** Best-effort write-through L2/L3 profile to VDB. Failure is logged but does not break the API. */
async function syncProfileToVdb(
  store: IMemoryStore | undefined,
  type: "l2" | "l3",
  filename: string,
  content: string,
  logger: Logger,
  createdAtOverride?: number,
  isolation?: RequestIsolation,
): Promise<number> {
  if (!store || typeof store.syncProfiles !== "function") return 0;
  try {
    const now = Date.now();

    // Try to extract created time from META in content
    let createdAtMs = createdAtOverride ?? 0;
    if (!createdAtMs) {
      const metaMatch = content.match(
        /^-----META-START-----\n([\s\S]*?)\n-----META-END-----/,
      );
      if (metaMatch) {
        for (const line of metaMatch[1].split("\n")) {
          if (line.startsWith("created: ")) {
            const ts = Date.parse(line.slice(9));
            if (!isNaN(ts)) createdAtMs = ts;
            break;
          }
        }
      }
    }
    if (!createdAtMs) createdAtMs = now;

    const scope = buildIsolationScope(isolation);
    const id = buildProfileStableId(scope, type, filename);

    // Probe current VDB version to satisfy the optimistic-lock check in
    // TcvdbMemoryStore.syncProfiles (which compares baselineVersion against
    // the remote version). Without this, the second and subsequent writes
    // to the same profile would be silently skipped as a version conflict.
    // Best-effort: if queryProfilesByIds/pullProfiles is unavailable or fails,
    // fall back to undefined and let syncProfiles decide (insert if remote missing,
    // otherwise log + skip — which preserves the previous behaviour).
    let baselineVersion: number | undefined;
    let currentMd5: string | undefined;
    try {
      if (typeof store.queryProfilesByIds === "function") {
        const results = await store.queryProfilesByIds([id]);
        const existing = results[0];
        if (existing) {
          baselineVersion = existing.version;
          currentMd5 = existing.contentMd5;
        }
      } else if (typeof store.pullProfiles === "function") {
        const remote = await store.pullProfiles();
        const existing = remote.find((r) => r.id === id);
        if (existing) {
          baselineVersion = existing.version;
          currentMd5 = existing.contentMd5;
        }
      }
    } catch (err) {
      logger.warn(
        `${TAG} [profile-sync] probe failed for ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const contentMd5 = md5Hex(content);
    const nextVersion =
      currentMd5 === contentMd5
        ? (baselineVersion ?? 0)
        : baselineVersion === undefined
          ? 0
          : baselineVersion + 1;

    const record: ProfileSyncRecord = {
      id,
      type,
      filename,
      content,
      contentMd5,
      version: nextVersion,
      createdAtMs,
      updatedAtMs: now,
      baselineVersion,
      teamId: isolation?.teamId,
      userId: isolation?.userId,
      agentId: isolation?.agentId,
      // L2/L3 profiles are team+agent scoped; session_id/task_id are intentionally not written.
      sessionId: undefined,
    };
    await store.syncProfiles([record]);
    logger.debug?.(
      `${TAG} [profile-sync] ${type} upserted to VDB: ${filename} (baselineVersion=${baselineVersion ?? "new"}, version=${nextVersion})`,
    );
    return nextVersion;
  } catch (err) {
    logger.warn(
      `${TAG} [profile-sync] FAILED to sync ${type} profile ${filename} to VDB: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

/** Best-effort delete L2 profiles from VDB. */
async function deleteProfilesFromVdb(
  store: IMemoryStore | undefined,
  type: "l2" | "l3",
  filenames: string[],
  logger: Logger,
  isolation?: RequestIsolation,
): Promise<void> {
  if (
    !store ||
    typeof store.deleteProfiles !== "function" ||
    filenames.length === 0
  )
    return;
  try {
    const scope = buildIsolationScope(isolation);
    const ids = filenames.map((fn) => buildProfileStableId(scope, type, fn));
    await store.deleteProfiles(ids);
    logger.debug?.(
      `${TAG} [profile-sync] ${type} deleted from VDB: ${filenames.length} files`,
    );
  } catch (err) {
    logger.warn(
      `${TAG} [profile-sync] FAILED to delete ${type} profiles from VDB: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Best-effort refresh scene_index.json so pipeline sees the user-written L2 files. */
async function refreshSceneIndex(
  storage: StorageAdapter,
  logger: Logger,
): Promise<void> {
  try {
    const { syncSceneIndex } = await import("../core/scene/scene-index.js");
    // Pass empty dataDir; we only use storage in service mode.
    await syncSceneIndex("", storage);
  } catch (err) {
    logger.warn(
      `${TAG} [scene-index] FAILED to refresh scene index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ============================
// L2 Scenario Handlers
// ============================

async function handleScenarioLs(
  body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = scenarioListRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { path_prefix } = parsed.data;

  const baseStorage = deps.getStorage();
  if (!baseStorage)
    return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);

  const prefix = path_prefix
    ? `${StoragePaths.sceneBlocksDir}${path_prefix}`
    : StoragePaths.sceneBlocksDir;

  deps.logger.debug?.(
    `${TAG} [scenario/ls] storage.type=${storage.type}, prefix="${prefix}"`,
  );

  // One-shot full listing (no pagination; marker-based pagination planned for phase 2)
  const backend = storage.getBackend();
  const result = await backend.listObjects(prefix, { recursive: true });
  deps.logger.debug?.(
    `${TAG} [scenario/ls] listObjects returned ${result.entries.length} entries`,
  );
  const allEntries = result.entries;

  // Read scene_index.json for summary + created/updated lookup
  const { readSceneIndex } = await import("../core/scene/scene-index.js");
  const sceneIndex = await readSceneIndex("", storage);
  const indexMap = new Map(sceneIndex.map((e) => [e.filename, e]));

  // Batch get all L2 file profile versions (one query, avoid N+1)
  const l2Filenames = allEntries
    .filter((e) => !e.isDirectory)
    .map((e) => {
      return e.key.startsWith(StoragePaths.sceneBlocksDir)
        ? e.key.slice(StoragePaths.sceneBlocksDir.length)
        : e.key;
    });
  const versionMap = await getProfileVersionBatch(
    deps.getStore(),
    "l2",
    l2Filenames,
    deps.requestIsolation,
  );

  const entries: ScenarioEntry[] = allEntries.map((e) => {
    const externalPath = e.key.startsWith(StoragePaths.sceneBlocksDir)
      ? e.key.slice(StoragePaths.sceneBlocksDir.length)
      : e.key;
    const displayPath =
      e.isDirectory && !externalPath.endsWith("/")
        ? `${externalPath}/`
        : externalPath;
    const indexEntry = indexMap.get(externalPath);
    const fallbackTime = e.lastModified.toISOString();
    return {
      path: displayPath,
      summary: indexEntry?.summary || undefined,
      version: e.isDirectory ? 0 : (versionMap.get(externalPath) ?? 0),
      team_id: deps.requestIsolation?.teamId,
      agent_id: deps.requestIsolation?.agentId,
      created_at: indexEntry?.created || fallbackTime,
      updated_at: indexEntry?.updated || fallbackTime,
    };
  });

  return successEnvelope({ entries, total: entries.length }, requestId);
}

async function handleScenarioCount(
  body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = scenarioCountRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { path_prefix } = parsed.data;

  const store = deps.getStore();
  if (typeof store?.countProfiles === "function") {
    const total = await store.countProfiles({
      type: "l2",
      pathPrefix: path_prefix,
      teamId: deps.requestIsolation?.teamId,
      userId: deps.requestIsolation?.teamId
        ? undefined
        : deps.requestIsolation?.userId,
      agentId: deps.requestIsolation?.agentId,
    });
    return successEnvelope<CountData>({ total }, requestId);
  }

  const baseStorage = deps.getStorage();
  if (!baseStorage)
    return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);
  const prefix = path_prefix
    ? `${StoragePaths.sceneBlocksDir}${path_prefix}`
    : StoragePaths.sceneBlocksDir;
  const result = await storage
    .getBackend()
    .listObjects(prefix, { recursive: true });
  const total = result.entries.filter((e) => !e.isDirectory).length;
  return successEnvelope<CountData>({ total }, requestId);
}

async function handleScenarioRead(
  body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = scenarioReadRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { path } = parsed.data;

  const baseStorage = deps.getStorage();
  if (!baseStorage)
    return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);

  const key = `${StoragePaths.sceneBlocksDir}${path}`;
  const content = await storage.readFile(key);

  // File not found → return 200 with null content (not 404)
  if (content === null) {
    return successEnvelope<ScenarioFile>(
      {
        path,
        // SAFETY: string-typed fields intentionally null here to signal "not found" over HTTP 200; callers check content === null before use.
        content: null as unknown as string,
        created_at: null as unknown as string,
        updated_at: null as unknown as string,
      },
      requestId,
    );
  }

  // Parse META for created/updated
  const now = new Date().toISOString();
  let createdAt = now;
  let updatedAt = now;

  const metaMatch = content.match(
    /^-----META-START-----\n([\s\S]*?)\n-----META-END-----/,
  );
  if (metaMatch) {
    for (const line of metaMatch[1].split("\n")) {
      const idx = line.indexOf(": ");
      if (idx > 0) {
        const k = line.slice(0, idx);
        const v = line.slice(idx + 2);
        if (k === "created") createdAt = v;
        if (k === "updated") updatedAt = v;
      }
    }
  } else {
    // Fallback: try scene_index
    const { readSceneIndex } = await import("../core/scene/scene-index.js");
    const sceneIndex = await readSceneIndex("", storage);
    const entry = sceneIndex.find((e) => e.filename === path);
    if (entry) {
      createdAt = entry.created || now;
      updatedAt = entry.updated || now;
    } else {
      const stat = await storage.stat(key);
      if (stat) {
        createdAt = new Date(stat.lastModified).toISOString();
        updatedAt = createdAt;
      }
    }
  }

  return successEnvelope<ScenarioFile>(
    {
      path,
      content,
      version: await getProfileVersion(
        deps.getStore(),
        "l2",
        path,
        deps.requestIsolation,
      ),
      team_id: deps.requestIsolation?.teamId,
      agent_id: deps.requestIsolation?.agentId,
      created_at: createdAt,
      updated_at: updatedAt,
    },
    requestId,
  );
}

async function handleScenarioWrite(
  body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = scenarioWriteRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { path, content, summary } = parsed.data;

  const baseStorage = deps.getStorage();
  if (!baseStorage)
    return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);

  const key = `${StoragePaths.sceneBlocksDir}${path}`;

  // Existence check: path must already exist (no upsert/create)
  const existing = await storage.readFile(key);
  if (existing === null)
    return errorEnvelope(404, `Scenario file not found: ${path}`, requestId);

  // Parse existing META to preserve created + update updated/summary
  const now = new Date().toISOString();
  let finalContent: string;

  const metaMatch = existing.match(
    /^-----META-START-----\n([\s\S]*?)\n-----META-END-----\n?/,
  );
  if (metaMatch) {
    // Parse existing META fields
    const metaBlock = metaMatch[1];
    const metaFields: Record<string, string> = {};
    for (const line of metaBlock.split("\n")) {
      const idx = line.indexOf(": ");
      if (idx > 0) metaFields[line.slice(0, idx)] = line.slice(idx + 2);
    }

    // Update fields
    metaFields["updated"] = now;
    if (summary !== undefined) metaFields["summary"] = summary;

    const newMeta = Object.entries(metaFields)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    finalContent = `-----META-START-----\n${newMeta}\n-----META-END-----\n\n${content}`;
  } else {
    // META missing or corrupted — rebuild
    const metaLines = [`created: ${now}`, `updated: ${now}`];
    if (summary !== undefined) metaLines.push(`summary: ${summary}`);
    finalContent = `-----META-START-----\n${metaLines.join("\n")}\n-----META-END-----\n\n${content}`;
  }

  await storage.writeFile(key, finalContent);

  // Sync L2 to VDB profiles + refresh scene index (best-effort)
  const store = deps.getStore();
  const version = await syncProfileToVdb(
    store,
    "l2",
    path,
    finalContent,
    deps.logger,
    undefined,
    deps.requestIsolation,
  );
  await refreshSceneIndex(storage, deps.logger);

  // Audit: L2 update — record_id uses path (L2 primary key = file path)
  await recordAudit(store, {
    record_id: path,
    layer: "L2",
    action: "update",
    iso: deps.requestIsolation,
    version,
    requestId,
    logger: deps.logger,
  });

  return successEnvelope<ScenarioWriteData>(
    {
      path,
      updated_at: now,
      version,
      team_id: deps.requestIsolation?.teamId,
      agent_id: deps.requestIsolation?.agentId,
    },
    requestId,
  );
}

async function handleScenarioRm(
  body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = scenarioRmRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { path } = parsed.data;

  const baseStorage = deps.getStorage();
  if (!baseStorage)
    return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);

  const key = `${StoragePaths.sceneBlocksDir}${path}`;
  // Collect filenames to delete from VDB (single file or all files under a directory)
  let removedFilenames: string[] = [];
  if (path.endsWith("/")) {
    try {
      const names = await storage.readdirNames(key, ".md");
      removedFilenames = names.map((name) => `${path}${name}`);
    } catch {
      /* ignore */
    }
    await storage.rmdir(key);
  } else {
    removedFilenames = [path];
    await storage.unlink(key);
  }

  // Delete L2 profiles from VDB (best-effort)
  const store = deps.getStore();
  await deleteProfilesFromVdb(
    store,
    "l2",
    removedFilenames,
    deps.logger,
    deps.requestIsolation,
  );
  await refreshSceneIndex(storage, deps.logger);

  // Audit: L2 delete — one row per deleted path
  for (const fname of removedFilenames) {
    await recordAudit(store, {
      record_id: fname,
      layer: "L2",
      action: "delete",
      iso: deps.requestIsolation,
      version: 0,
      requestId,
      logger: deps.logger,
    });
  }

  return successEnvelope(undefined, requestId);
}

// ============================
// L3 Core Handlers
// ============================

async function handleCoreRead(
  _body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const baseStorage = deps.getStorage();
  if (!baseStorage)
    return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);

  deps.logger.debug?.(
    `${TAG} [core/read] storage.type=${storage.type}, key="${StoragePaths.persona}"`,
  );
  const content = await storage.readFile(StoragePaths.persona);
  deps.logger.debug?.(
    `${TAG} [core/read] readFile result: ${content === null ? "null (not found)" : `${content.length} chars`}`,
  );

  // File not found → return 200 with null content (not 404)
  if (content === null) {
    return successEnvelope<CoreFile>(
      {
        // SAFETY: string-typed fields intentionally null here to signal "not found" over HTTP 200; callers check content === null before use.
        content: null as unknown as string,
        created_at: null as unknown as string,
        updated_at: null as unknown as string,
      },
      requestId,
    );
  }

  const stat = await storage.stat(StoragePaths.persona);
  const now = new Date().toISOString();

  return successEnvelope<CoreFile>(
    {
      content,
      version: await getProfileVersion(
        deps.getStore(),
        "l3",
        StoragePaths.persona,
        deps.requestIsolation,
      ),
      team_id: deps.requestIsolation?.teamId,
      agent_id: deps.requestIsolation?.agentId,
      created_at: stat ? new Date(stat.createdAt).toISOString() : now,
      updated_at: stat ? new Date(stat.lastModified).toISOString() : now,
    },
    requestId,
  );
}

async function handleCoreCount(
  body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = coreCountRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const store = deps.getStore();
  if (typeof store?.countProfiles === "function") {
    const total = await store.countProfiles({
      type: "l3",
      teamId: deps.requestIsolation?.teamId,
      userId: deps.requestIsolation?.teamId
        ? undefined
        : deps.requestIsolation?.userId,
      agentId: deps.requestIsolation?.agentId,
    });
    return successEnvelope<CountData>({ total }, requestId);
  }

  const baseStorage = deps.getStorage();
  if (!baseStorage)
    return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);
  const content = await storage.readFile(StoragePaths.persona);
  return successEnvelope<CountData>({ total: content ? 1 : 0 }, requestId);
}

async function handleCoreWrite(
  body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  const parsed = coreWriteRequestSchema.safeParse(body);
  if (!parsed.success)
    return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { content } = parsed.data;

  const baseStorage = deps.getStorage();
  if (!baseStorage)
    return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);

  // Normalize before persistence: persona body must NOT contain Scene Navigation
  // (a derived section rebuilt from scene_index.json) or stray surrounding
  // whitespace. Both COS and VDB get the *exact* same bytes so md5(content) is
  // a stable identity across stores. Without this, /v3/core/write callers that
  // post the raw round-tripped body (which includes the navigation footer and
  // a trailing newline appended by refreshPersonaNavigation) would write a
  // mismatched copy to each store, and pullProfilesToLocal would later treat
  // the persona as corrupted and delete the COS copy.
  const personaBody = stripSceneNavigation(content).trim();

  await storage.writeFile(StoragePaths.persona, personaBody);

  // Sync L3 persona to VDB profiles (best-effort)
  const store = deps.getStore();
  const version = await syncProfileToVdb(
    store,
    "l3",
    StoragePaths.persona,
    personaBody,
    deps.logger,
    undefined,
    deps.requestIsolation,
  );

  // Audit: L3 update — record_id uses personas storage path
  await recordAudit(store, {
    record_id: StoragePaths.persona,
    layer: "L3",
    action: "update",
    iso: deps.requestIsolation,
    version,
    requestId,
    logger: deps.logger,
  });

  return successEnvelope<CoreWriteData>(
    {
      updated_at: new Date().toISOString(),
      version,
      team_id: deps.requestIsolation?.teamId,
      agent_id: deps.requestIsolation?.agentId,
    },
    requestId,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// /v3/pipeline/status — standalone-only introspection.
// Returns per-L-type queue/in-flight stats by reading the in-memory task
// queue (LocalStateBackend.listQueuedTasks) and worker's running set
// (PipelineWorker.getRunningTasks). idle = queued===0 && running===0.
// Mirrors the old MemoryPipelineManager.getQueueSizes() {l1Idle,l2Idle,l3Idle}
// semantics so seed clients can wait specifically for L1 to drain (without
// being blocked by slow L2/L3 cascades).
// Service mode returns 404 (route not exposed).
// ─────────────────────────────────────────────────────────────────────────

interface LayerStatus {
  /** Tasks waiting to be consumed (in queue). */
  queued: number;
  /** Tasks consumed by worker but not yet completed/failed. */
  running: number;
  /** Distinct sessionIds of queued tasks (for diagnostics). */
  queued_sessions: string[];
  /** Distinct sessionIds of running tasks (for diagnostics). */
  running_sessions: string[];
  /** True iff queued===0 && running===0. */
  idle: boolean;
}

interface PipelineStatusData {
  l1: LayerStatus;
  l2: LayerStatus;
  l3: LayerStatus;
}

function emptyLayer(): LayerStatus {
  return {
    queued: 0,
    running: 0,
    queued_sessions: [],
    running_sessions: [],
    idle: true,
  };
}

async function handlePipelineStatus(
  _body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  // Service mode does not expose this endpoint — pretend it's not routed.
  if (deps.deployMode !== "standalone") {
    return errorEnvelope(404, "Not found", requestId);
  }

  // Legacy standalone (no stateBackend / no worker) — pipeline isn't running.
  if (!deps.stateBackend || !deps.pipelineWorker) {
    return errorEnvelope(
      503,
      "Pipeline not running (legacy standalone mode)",
      requestId,
    );
  }

  // listQueuedTasks is optional on IStateBackend; LocalStateBackend implements
  // it, remote backends may not. Service mode never reaches here anyway.
  if (!deps.stateBackend.listQueuedTasks) {
    return errorEnvelope(
      503,
      "stateBackend does not support listQueuedTasks (status endpoint requires LocalStateBackend)",
      requestId,
    );
  }

  const queued = await deps.stateBackend.listQueuedTasks();
  const running = deps.pipelineWorker.getRunningTasks();

  const layers: Record<"L1" | "L2" | "L3", LayerStatus> = {
    L1: emptyLayer(),
    L2: emptyLayer(),
    L3: emptyLayer(),
  };
  // Track sessionIds in a Set per layer/category for de-dup, then materialize.
  const queuedSessionSets: Record<"L1" | "L2" | "L3", Set<string>> = {
    L1: new Set(),
    L2: new Set(),
    L3: new Set(),
  };
  const runningSessionSets: Record<"L1" | "L2" | "L3", Set<string>> = {
    L1: new Set(),
    L2: new Set(),
    L3: new Set(),
  };

  for (const t of queued) {
    if (t.type === "L1" || t.type === "L2" || t.type === "L3") {
      layers[t.type].queued++;
      queuedSessionSets[t.type].add(t.sessionId);
    }
    // "flush" tasks behave like L1 work (see executor.executeFlush fallback);
    // tally them under L1 so the seed-v2 idle wait doesn't miss them.
    if (t.type === "flush") {
      layers.L1.queued++;
      queuedSessionSets.L1.add(t.sessionId);
    }
  }
  for (const t of running) {
    if (t.type === "L1" || t.type === "L2" || t.type === "L3") {
      layers[t.type].running++;
      runningSessionSets[t.type].add(t.sessionId);
    }
    if (t.type === "flush") {
      layers.L1.running++;
      runningSessionSets.L1.add(t.sessionId);
    }
  }
  for (const k of ["L1", "L2", "L3"] as const) {
    layers[k].queued_sessions = Array.from(queuedSessionSets[k]).sort();
    layers[k].running_sessions = Array.from(runningSessionSets[k]).sort();
    layers[k].idle = layers[k].queued === 0 && layers[k].running === 0;
  }

  const data: PipelineStatusData = {
    l1: layers.L1,
    l2: layers.L2,
    l3: layers.L3,
  };

  return successEnvelope<PipelineStatusData>(data, requestId);
}

// ============================
// Helpers
// ============================

/**
 * Format a Date as YYYY-MM-DD in local timezone, matching the convention used by
 * v1 l0-recorder and l1-writer for daily JSONL shard names. Local copy to keep
 * v2-router self-contained (avoids exporting a util just for one call site).
 */
function formatLocalDateForJsonl(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ============================
// Exported for testing
// ============================

export {
  handleConversationAdd,
  handleConversationQuery,
  handleConversationSearch,
  handleConversationDelete,
  handleConversationCount,
  handleAtomicUpdate,
  handleAtomicQuery,
  handleAtomicSearch,
  handleAtomicDelete,
  handleAtomicCount,
  handleScenarioLs,
  handleScenarioRead,
  handleScenarioWrite,
  handleScenarioRm,
  handleScenarioCount,
  handleCoreRead,
  handleCoreWrite,
  handleCoreCount,
  handlePipelineStatus,
};
