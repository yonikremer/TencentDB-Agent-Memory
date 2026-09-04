/**
 * `POST /v3/instance/proxy-destroy` — ops-facing: cleans the ProxyStorage data that
 * proxy caches for an instance (= spaceId), plus the STS backend in the kernel-sts pool.
 *
 * Contract field names align with core `/v3/instance/destroy`
 * (`tdai-memory-openclaw-plugin/src/gateway/server.ts:1202-1221`); the path uses
 * the `proxy-destroy` action to tell it apart from core `destroy`, distinguishable at a glance in packet captures / logs.
 *
 * Request:
 *   { "instance_id": "<spaceId>" }
 * Header optional: Authorization: Bearer <admin.apiKey>
 *
 * Response 200:
 *   {
 *     "code": 0, "message": "ok",
 *     "data": {
 *       "instance_id": "...",
 *       "cleaned": {
 *         "storage_backend": "cos" | "sqlite" | "fs" | "memory",
 *         "storage_ttl_deleted":   <number>,   // defaults to 0; on error storage_ttl_error is also present
 *         "storage_nottl_deleted": <number>,
 *         "cos_pool_evicted":      "evicted" | "not-cached" | "unsupported",
 *         "redis_skipped":         "per-session-ttl-only"
 *       }
 *     }
 *   }
 *
 * Failure:
 *   400 missing / invalid parameters (including containing `/` or `..`)
 *   401 auth enabled and Bearer missing/mismatched
 *   200 partial failure: cleaned contains a <step>_error field (aligning with core's policy of not blocking on partial success)
 *
 * Note: the Redis session store (`cg:sess:*`) is not cleaned. The router module's `sessionKey`
 * comes from `x-conversation-id` / `x-claude-code-session-id` (`profiles/*.ts`), which does
 * not include the spaceId, so it cannot SCAN precisely by space; the default TTL of 1800s naturally expires. In cleaned,
 * `redis_skipped: "per-session-ttl-only"` explicitly declares this.
 */

import type { Context } from "hono";
import { getProxyStorage, evictCosSpace } from "../storage/factory.js";
import { assertKeySegment } from "../storage/key-utils.js";
import { log } from "../report/log.js";
import type { ProxyConfig } from "../types.js";
import { adminAuthError, checkAdminAuth } from "./admin-auth.js";

/** Uniform response envelope for the ops-facing endpoint. */
interface EnvelopeOk<T> {
  code: 0;
  message: "ok";
  data: T;
}
interface EnvelopeErr {
  code: number;
  message: string;
}
interface DestroyResponseData {
  instance_id: string;
  cleaned: Record<string, unknown>;
}

/**
 * Builds the handler; `config` is only used to read `admin.apiKey`, and the storage
 * singleton is obtained via `getProxyStorage(config.storage)` (`initProxyStorage()`
 * has already been awaited in index.ts; this is an idempotent get).
 */
export function createInstanceDestroyHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    // ── 1. Auth ────────────────────────────────────────────────
    const authResult = checkAdminAuth(c, config.admin.apiKey);
    if (authResult !== "ok") {
      return adminAuthError(c, authResult);
    }

    // ── 2. Parameter parsing & validation ───────────────────────────────
    let body: { instance_id?: unknown } | null = null;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: 400, message: "invalid JSON body" } satisfies EnvelopeErr, 400);
    }
    const instanceId = typeof body?.instance_id === "string" ? body.instance_id : "";
    if (!instanceId) {
      return c.json(
        { code: 400, message: "Missing required field: instance_id" } satisfies EnvelopeErr,
        400,
      );
    }
    try {
      // Reuse sessionDirOf validation rules: non-empty + no `/` + no `..`
      assertKeySegment("instance_id", instanceId);
    } catch (err) {
      return c.json(
        {
          code: 400,
          message: `invalid instance_id: ${err instanceof Error ? err.message : String(err)}`,
        } satisfies EnvelopeErr,
        400,
      );
    }

    log.info("instance_destroy.start", { instance_id: instanceId });

    // ── 3. Cleanup actions ─────────────────────────────────────
    const cleaned: Record<string, unknown> = {};

    const storage = getProxyStorage(config.storage);
    cleaned.storage_backend = storage.type;

    // 3a. ttl/<spaceId>/ ——   hot caches such as session-init / hook pre-warm
    try {
      cleaned.storage_ttl_deleted = await storage.delPrefix(`ttl/${instanceId}/`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cleaned.storage_ttl_deleted = 0;
      cleaned.storage_ttl_error = msg;
      log.warn("instance_destroy.storage_ttl_error", { instance_id: instanceId, error: msg });
    }

    // 3b. nottl/<spaceId>/ —— business state such as binding / skill extraction / kv version pin
    try {
      cleaned.storage_nottl_deleted = await storage.delPrefix(`nottl/${instanceId}/`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cleaned.storage_nottl_deleted = 0;
      cleaned.storage_nottl_error = msg;
      log.warn("instance_destroy.storage_nottl_error", { instance_id: instanceId, error: msg });
    }

    // 3c. kernel-sts pool evict —— reclaim the STS backend of this space
    try {
      cleaned.cos_pool_evicted = await evictCosSpace(instanceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cleaned.cos_pool_evicted = "error";
      cleaned.cos_pool_error = msg;
      log.warn("instance_destroy.cos_pool_error", { instance_id: instanceId, error: msg });
    }

    // 3d. Redis not cleaned —— declarative, so callers know nothing was missed
    cleaned.redis_skipped = "per-session-ttl-only";

    log.info("instance_destroy.done", { instance_id: instanceId, cleaned });

    return c.json({
      code: 0,
      message: "ok",
      data: { instance_id: instanceId, cleaned },
    } satisfies EnvelopeOk<DestroyResponseData>);
  };
}
