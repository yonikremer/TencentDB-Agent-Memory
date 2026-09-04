/**
 * LLM Binding Routes — internal, per-instance LLM routing config.
 *
 * Mounted under /v3/internal/llm-binding (prefix applied at server.ts).
 * service_id is REQUIRED via the `x-tdai-service-id` header (unified KS convention),
 * never in the body.
 *
 *   POST /set     upsert binding (proxy|byo). Idempotent — re-posting overwrites,
 *                 which is how a lost binding is re-bound (TMC startup / manual curl).
 *                 `api_key` optional: if omitted, retains previous value (applies only to existing records); required on initial creation.
 *   POST /status  read-side binding status (never returns api_key).
 *   POST /list    Lists all bindings (does not require x-tdai-service-id header). Returns has_api_key flag,
 *                 does not return plaintext api_key. Used by Panel to cache status on startup.
 *
 * These endpoints are internal (TMC control plane / operator curl). KS trusts the
 * internal network like its other routes; no extra auth layer is added here.
 */

import { Hono } from "hono";

import type { ILlmBindingStore, LlmBindingMode } from "../store/index.js";
import { isValidIdSegment, wrapOk, wrapError } from "../api-helpers.js";

export interface LlmBindingRouteDeps {
  llmBindingStore: ILlmBindingStore;
}

function isMode(v: unknown): v is LlmBindingMode {
  return v === "proxy" || v === "byo";
}

function asOptString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function createLlmBindingRoutes(deps: LlmBindingRouteDeps): Hono {
  const app = new Hono();
  const { llmBindingStore } = deps;

  app.post("/set", async (c) => {
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>);

    const mode = body.mode;
    if (!isMode(mode)) {
      return c.json(wrapError(400, "mode must be 'proxy' or 'byo'"), 400);
    }

    const apiKey = asOptString(body.api_key);
    const proxyBaseUrl = asOptString(body.proxy_base_url);
    const baseUrl = asOptString(body.base_url);
    const enabled = body.enabled === undefined ? undefined : body.enabled !== false;

    // proxy_base_url / base_url always required (KS needs address when calling LLM)
    if (mode === "proxy" && !proxyBaseUrl) {
      return c.json(wrapError(400, "proxy mode requires proxy_base_url"), 400);
    }
    if (mode === "byo" && !baseUrl) {
      return c.json(wrapError(400, "byo mode requires base_url"), 400);
    }

    // api_key validation: required on first creation (when KS has no record for this service_id); if record exists, omitting it retains previous value.
    const existing = llmBindingStore.get(serviceId);
    if (!existing) {
      if (!apiKey) {
        return c.json(wrapError(400, `${mode} mode requires api_key on first set`), 400);
      }
    }

    const row = llmBindingStore.upsert(serviceId, {
      mode,
      proxy_base_url: proxyBaseUrl ?? null,
      // asOptString returns string | undefined; upsert layer interprets undefined as "retain previous value"
      api_key: apiKey,
      base_url: baseUrl ?? null,
      enabled,
    });

    // Never echo api_key back.
    return c.json(
      wrapOk({
        service_id: row.service_id,
        mode: row.mode,
        enabled: row.enabled,
        updated_at: row.updated_at,
      }),
    );
  });

  app.post("/status", async (c) => {
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    return c.json(wrapOk(llmBindingStore.status(serviceId)));
  });

  app.post("/list", async (c) => {
    // x-tdai-service-id header not required: returns all bindings for Panel to cache global state on startup.
    const items = llmBindingStore.listAll().map((r) => ({
      service_id: r.service_id,
      mode: r.mode,
      proxy_base_url: r.proxy_base_url,
      base_url: r.base_url,
      has_api_key: !!r.api_key && r.api_key.length > 0,
      enabled: r.enabled,
    }));
    return c.json(wrapOk({ items }));
  });

  return app;
}
