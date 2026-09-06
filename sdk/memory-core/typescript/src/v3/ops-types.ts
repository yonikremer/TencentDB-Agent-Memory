/**
 * v3 OpsClient types — Knowledge Service ops plane.
 *
 * - LLM binding (POST /v3/internal/llm-binding/*): per-instance LLM routing.
 *   set/status require x-tdai-service-id; list needs none.
 * - Auto-sync (GET|POST /v3/auto-sync/*): scheduler status + manual trigger.
 */
export interface OpsClientConfig {
  /** KS base URL WITHOUT /v3 suffix, e.g. http://127.0.0.1:8421 */
  endpoint: string;
  /** Knowledge instance id (x-tdai-service-id header). Required for set/status. */
  serviceId: string;
  /** Optional Bearer token (KS default needs none). */
  apiKey?: string;
  /** Request timeout in ms (default 30 000). */
  timeout?: number;
  /** Whether to reject invalid TLS certificates. Default: true. */
  rejectUnauthorized?: boolean;
}
export type LlmBindingMode = "proxy" | "byo";
export interface LlmBindingSetRequest {
  mode: LlmBindingMode;
  /** First set requires api_key; omit later to keep existing value. */
  api_key?: string;
  /** Required when mode=proxy. */
  proxy_base_url?: string;
  /** Required when mode=byo. */
  base_url?: string;
  /** Default true. */
  enabled?: boolean;
}
export interface LlmBindingSetResult {
  service_id: string; mode: LlmBindingMode; enabled: boolean; updated_at: string;
}
export interface LlmBindingStatus {
  bound: boolean; mode: LlmBindingMode | null; enabled: boolean;
}
export interface LlmBindingListItem {
  service_id: string; mode: LlmBindingMode;
  proxy_base_url: string | null; base_url: string | null;
  has_api_key: boolean; enabled: boolean;
}
export interface LlmBindingListResult { items: LlmBindingListItem[] }
export interface AutoSyncStatusResult {
  running: boolean; activeSyncs: number; queueLength: number; scanning: boolean;
  config: { enabled: boolean; scanIntervalMs: number; maxConcurrentSyncs: number };
}
export interface AutoSyncTriggerResult { triggered: boolean; reason?: string }
