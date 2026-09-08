/**
 * Offload V3 Router — route registration and dispatch.
 */
import type http from "node:http";
import type { StorageAdapter } from "../core/storage/adapter.js";
import type { IStateBackend } from "../core/state/types.js";
import type { OffloadExecutorConfig } from "./types.js";
import { defaultOffloadConfig } from "./types.js";
import {
  parseV3Auth,
  verifyDataPlaneUser,
  successEnvelope,
  errorEnvelope,
  makeRequestId,
} from "../gateway/v3-router.js";
import { handleIngest } from "./ingest-handler.js";
import { handleMmdQuery } from "./mmd-handler.js";
import { handleCompaction } from "./compact/compaction-handler.js";
import { MmdQuerySchema } from "./schemas.js";

export interface OffloadV3Deps {
  resolveStorage?: (instanceId: string) => Promise<StorageAdapter | undefined>;
  getStorage: () => StorageAdapter | undefined;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  stateBackend?: IStateBackend;
  config?: OffloadExecutorConfig;
  /** Single identity plane: verifies x-tdai-user-key against the user table. */
  getMetadataService?: (instanceId: string) => Promise<import("../metadata/service/metadata-service.js").MetadataService>;
}

/**
 * Handle offload V3 routes. Returns true if the request was handled.
 */
export async function handleOffloadV3Route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: http.IncomingMessage) => Promise<T>,
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void,
  deps: OffloadV3Deps,
): Promise<boolean> {
  if (!pathname.startsWith("/v3/offload/")) return false;

  const requestId = makeRequestId();

  // Auth
  const auth = parseV3Auth(req, res, requestId, sendJson);
  if (!auth) return true; // 401 already sent

  // Single identity plane: offload storage is tenant-scoped, so every caller
  // authenticates as a user. (Identity is not yet threaded into offload payloads.)
  const verified = await verifyDataPlaneUser(req, res, auth.serviceId, deps, requestId, sendJson);
  if (!verified) return true; // 401/503 already sent

  // Resolve storage
  const storage =
    (await deps.resolveStorage?.(auth.serviceId)) ?? deps.getStorage();
  if (!storage) {
    sendJson(res, 503, errorEnvelope(503, "Storage unavailable", requestId));
    return true;
  }

  const config = deps.config ?? defaultOffloadConfig();
  // Normalize trailing slash for consistent route matching
  const normalizedPath =
    pathname.endsWith("/") && pathname.length > 1
      ? pathname.slice(0, -1)
      : pathname;
  const route = `${method} ${normalizedPath}`;

  switch (route) {
    case "POST /v3/offload/ingest":
      await handleIngest(
        req,
        res,
        auth,
        {
          storage,
          stateBackend: deps.stateBackend,
          config,
          logger: deps.logger,
        },
        requestId,
        parseJsonBody,
        sendJson,
        successEnvelope,
        errorEnvelope,
      );
      return true;

    case "POST /v3/offload/query-mmd": {
      const body = await parseJsonBody<{ session_id?: string; limit?: number }>(
        req,
      );
      const parsed = MmdQuerySchema.safeParse(body);
      if (!parsed.success) {
        sendJson(
          res,
          400,
          errorEnvelope(
            400,
            "missing or invalid session_id in body",
            requestId,
          ),
        );
        return true;
      }
      await handleMmdQuery(
        req,
        res,
        auth,
        storage,
        requestId,
        sendJson,
        successEnvelope,
        errorEnvelope,
        parsed.data.session_id,
        parsed.data.limit,
      );
      return true;
    }

    case "POST /v3/offload/compact":
      await handleCompaction(
        req,
        res,
        auth,
        {
          storage,
          config,
          logger: deps.logger,
        },
        requestId,
        parseJsonBody,
        sendJson,
        successEnvelope,
        errorEnvelope,
      );
      return true;

    default:
      return false;
  }
}
