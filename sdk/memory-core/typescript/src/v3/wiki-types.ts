/**
 * v3 WikiClient types — Knowledge Service data-plane (MemoryKnowledge / Hub).
 *
 * Covers POST /v3/wiki/* (15 endpoints): asset layer
 * create / get / list / delete / update-meta / ingest, file layer
 * raw/{ls,read,write,rm} + page/{ls,read,write,rm}, derived graph / search.
 *
 * Addressing (mirrors server + Panel KnowledgeClientPort):
 * - create / list / raw-write / raw-rm / page-write / page-rm carry
 *   team_id (+ optional user_id) in body, service-id via header.
 * - get / ingest / delete / raw-ls / raw-read / page-ls / page-read /
 *   graph / search address by wiki_id only (ownership resolved server-side).
 */
export interface WikiClientConfig {
  /** KS base URL WITHOUT /v3 suffix, e.g. http://127.0.0.1:8421 */
  endpoint: string;
  /** Knowledge instance id (x-tdai-service-id header). Required. */
  serviceId: string;
  /** Optional Bearer token (KS default needs none; hub/proxied may). */
  apiKey?: string;
  /** Optional user key passthrough (x-tdai-user-key). */
  userKey?: string;
  /** Request timeout in ms (default 30 000; ingest poll may want more). */
  timeout?: number;
  /** Whether to reject invalid TLS certificates. Default: true. */
  rejectUnauthorized?: boolean;
}
export type WikiStatus = "draft" | "pending" | "processing" | "ready" | "failed";
export interface WikiDetail {
  wiki_id: string; team_id: string; name: string;
  service_url: string | null; summary: string | null; status: WikiStatus;
  sync_error: string | null; version: string; owner_user_id: string | null;
  page_count: number | null; last_sync_at: string | null;
  created_at: string; updated_at: string;
}
export interface WikiListResult { items: WikiDetail[]; total: number }
export interface WikiIngestResult { wiki_id: string; status: string }
export interface WikiRawFile { filename: string; content: string }
export interface RawFileEntry { filename: string; size: number; uploaded_at: string }
export interface WikiRawWriteItem { filename: string; size: number }
export interface WikiRawReadItem { filename: string; content?: string; not_found?: boolean }
export interface WikiRawRmResult { deleted_files: string[]; deleted_pages: string[]; rewritten_pages: number }
export interface PageEntry { id: string; title: string; type: string; path: string; locked?: boolean }
export interface WikiPageItem { ref: string; content: string }
export interface WikiPageReadItem { ref: string; content?: string; not_found?: boolean }
export interface WikiPageWriteResultItem { ref: string; locked_injected?: boolean }
export interface WikiPageRmResult { deleted_pages: string[]; rewritten_files: number }
export interface WikiGraphData { nodes: unknown[]; edges: unknown[]; communities?: unknown[] }
export interface WikiSearchHit { path: string; title: string; snippet: string; score: number; type: string }
export interface WikiSearchResult { results: WikiSearchHit[]; count: number; links?: unknown[] }
export interface WikiBatchDeleteResult { deleted_ids: string[]; failed: Array<{ id: string; reason: string }> }
