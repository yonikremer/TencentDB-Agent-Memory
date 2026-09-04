/**
 * CosLikeBackend / KernelStsCosOptions main-repo-side type definitions — the **authoritative source**.
 *
 * The cost-guard side has a structurally equivalent, independent copy in
 * `packages/cost-guard/src/storage/cos-types.ts` (avoiding a reverse dependency on the main repo). Both are 5-method interfaces,
 * so they're naturally compatible under structural typing — the main repo gets the assemble function's return value via `await import("@context-proxy/cost-guard")`
 * (a cost-guard-side CosLikeBackend instance) and assigns it to the CosLikeBackend variable it expects;
 * TypeScript accepts that automatically.
 *
 * Make tsc compilation independent of whether the submodule exists — even if the
 * `packages/cost-guard/` directory is empty after an open-source user clones, the main repo's `tsc` still passes (CosLikeBackend
 * type is defined here, not imported from cost-guard).
 *
 * See docs/design/2026-07-11-cos-submodule-extraction-plan.md §4.2 Decision 1 + §4.4.
 */

/**
 * Minimal COS backend contract — CosStorage calls these 5 methods down to it.
 */
export interface CosLikeBackend {
  /**
   * PUT object.
   * @param headers Extra headers — pass `{ "If-None-Match": "*" }` in CAS scenarios;
   *                the backend should throw `{ statusCode: 412 }` on a 412
   */
  putObject(key: string, body: Buffer, headers?: Record<string, string>): Promise<void>;
  getObject(key: string): Promise<Buffer | null>;
  headObject(key: string): Promise<boolean>;
  deleteObject(key: string): Promise<void>;
  /** List all keys under prefix (may paginate internally). Return full key path. */
  listKeys(prefix: string): Promise<string[]>;
  /**
   * Optional: evict a spaceId's per-space backend + STS credential cache.
   *
   * Only the kernel-sts assembly (cost-guard `CosStorageBackendMultiSpace`) implements it;
   * single-space or pool-less implementations (e.g. a mock backend the main repo may mount later) should leave it
   * undefined. The `/v3/instance/proxy-destroy` handler detects it via an optional call.
   *
   * Returns `true` when it hits, `false` when it misses or is unsupported.
   */
  evictSpace?(spaceId: string): Promise<boolean>;
}

/**
 * Input parameters for `openKernelStsCosBackend` — mirror the `StorageConfig.cos` structure
 * (minus the fields irrelevant to kernel-sts).
 */
export interface KernelStsCosOptions {
  /** Business namespace prefix for COS keys, e.g. `"proxy_cache/"` (isolated from core's memory_v2/cos_data). */
  rootPrefix: string;
  /**
   * Optional: force VPC-intranet access / a custom domain (e.g. `"cos.example.com"`).
   * If empty, use the host from the CosUrl returned by Shark.
   */
  endpointDomain?: string;
  /**
   * Shark fetches temporary credentials — an independent STS per spaceId, with permissions strictly bound to the
   * two prefixes `proxy_cache/{ttl|nottl}/{spaceId}/*`.
   */
  shark: {
    baseUrl: string;
    timeoutMs?: number;
    retryCount?: number;
    refreshBufferMs?: number;
    maxSpaces?: number;
    graceCloseDelayMs?: number;
  };
}
