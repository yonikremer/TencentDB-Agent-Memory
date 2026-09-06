/**
 * v3 OpsClient — Knowledge Service ops plane over the shared V3HttpTransport.
 *
 * - `llmBindingSet / llmBindingStatus / llmBindingList` →
 *   POST /v3/internal/llm-binding/{set,status,list} (per-instance LLM routing;
 *   api_key is never echoed back; list needs no service-id).
 *   First set for an instance requires api_key server-side — omit it only
 *   when updating an already-bound instance (server keeps the stored key).
 * - `autoSyncStatus` → GET /v3/auto-sync/status (scheduler snapshot + config).
 * - `autoSyncTrigger` → POST /v3/auto-sync/trigger (fire-and-forget scan;
 *   `{triggered:false}` when disabled server-side).
 *
 * Auth: x-tdai-service-id always sent; Bearer only if apiKey given.
 */
import { ParamError } from "../errors.js";
import { V3HttpTransport } from "./http.js";
import type { Transport } from "../client.js";
import { stripUndefined } from "./request-helpers.js";
import type {
  AutoSyncStatusResult, AutoSyncTriggerResult, LlmBindingListResult,
  LlmBindingSetRequest, LlmBindingSetResult, LlmBindingStatus, OpsClientConfig,
} from "./ops-types.js";
const V3BIND = "/v3/internal/llm-binding";
const V3SYNC = "/v3/auto-sync";
function need(name: string, v: string | undefined): string {
  if (!v || !v.trim()) throw new ParamError("OpsClient requires non-empty " + name);
  return v;
}
function checkSet(p: LlmBindingSetRequest): void {
  if (p.mode !== "proxy" && p.mode !== "byo") throw new ParamError("llmBindingSet mode must be 'proxy' or 'byo'");
  if (p.mode === "proxy" && !p.proxy_base_url) throw new ParamError("llmBindingSet proxy mode requires proxy_base_url");
  if (p.mode === "byo" && !p.base_url) throw new ParamError("llmBindingSet byo mode requires base_url");
}
export class OpsClient {
  private readonly http: Transport;
  constructor(config: OpsClientConfig);
  constructor(transport: Transport);
  constructor(configOrTransport: OpsClientConfig | Transport) {
    if ("post" in configOrTransport) {
      this.http = configOrTransport;
      if (typeof this.http.get !== "function") {
        throw new ParamError("OpsClient transport requires get() (auto-sync/status is GET)");
      }
      return;
    }
    const cfg = configOrTransport;
    need("serviceId", cfg.serviceId);
    if (!cfg.endpoint || !cfg.endpoint.trim()) throw new ParamError("OpsClient requires non-empty endpoint");
    this.http = new V3HttpTransport({
      endpoint: cfg.endpoint, apiKey: cfg.apiKey, serviceId: cfg.serviceId,
      timeout: cfg.timeout, rejectUnauthorized: cfg.rejectUnauthorized,
    });
  }
  /** Upsert per-instance LLM routing. Idempotent — re-post overwrites. */
  llmBindingSet(p: LlmBindingSetRequest): Promise<LlmBindingSetResult> {
    checkSet(p);
    return this.http.post(V3BIND + "/set", stripUndefined({
      mode: p.mode, api_key: p.api_key, proxy_base_url: p.proxy_base_url, base_url: p.base_url, enabled: p.enabled,
    }));
  }
  /** Read binding status (never contains api_key). */
  llmBindingStatus(): Promise<LlmBindingStatus> {
    return this.http.post(V3BIND + "/status", {});
  }
  /** List all bindings (no service-id needed server-side). */
  llmBindingList(): Promise<LlmBindingListResult> {
    return this.http.post(V3BIND + "/list", {});
  }
  /** Scheduler snapshot + config. Only GET in the KS API. */
  autoSyncStatus(): Promise<AutoSyncStatusResult> {
    return this.http.get!(V3SYNC + "/status");
  }
  /** Fire-and-forget scan trigger. `{triggered:false}` when disabled. */
  autoSyncTrigger(): Promise<AutoSyncTriggerResult> {
    return this.http.post(V3SYNC + "/trigger", {});
  }
}
