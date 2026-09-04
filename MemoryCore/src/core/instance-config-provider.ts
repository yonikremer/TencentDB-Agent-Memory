/**
 * InstanceConfigProvider — Instance-level configuration management
 *
 * Design highlights:
 *   - VDB config: per-instance (independent VDB connection info per instanceId), with TTL cache
 *   - COS config: globally shared (all instances share the same bucket, isolated by pathPrefix)
 *   - Config source provided via dependency-injected IConfigSource:
 *     - standalone: LocalConfigSource (built-in this file, read from env vars)
 *     - service:    Remote config source injected by deployment environment
 *
 * Data model:
 *   Core process
 *     ├── COS: globally shared { cosUrl, tmpSecretId, tmpSecretKey, tmpToken, expirationTime, pathPrefix }
 *     └── VDB Pool (Map<instanceId, VdbConfig>):
 *         ├── inst-001 → { url: vdb-1, apiKey: xxx, database: db1 }
 *         ├── inst-002 → { url: vdb-2, apiKey: yyy, database: db2 }
 *         └── inst-003 → { url: vdb-1, apiKey: xxx, database: db3 }
 */

import type { IConfigSource } from "./abstractions/index.js";
import { readVdbEnvConfig, readCosEnvConfig } from "../utils/env-config.js";

// ════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════

export interface VdbConfig {
  url: string;
  user: string;
  apiKey: string;
  database: string;
}

export interface CosConfig {
  cosUrl: string;
  tmpSecretId: string;
  tmpSecretKey: string;
  tmpToken: string;
  /** ISO 8601 expiration time (only valid in temporary credential mode) */
  expirationTime: string;
  pathPrefix: string;
}

export interface InstanceConfig {
  instanceId: string;
  vdb: VdbConfig;
  cos: CosConfig | null;
}

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

// Re-export interface for backward compatibility (consumers may still
// import IConfigSource from this module — the canonical location is now
// src/core/abstractions/).
export type { IConfigSource };

// ════════════════════════════════════════════════════════
// LocalConfigSource — Default implementation (open-source / standalone)
// ════════════════════════════════════════════════════════
//
// Reads VDB + COS config from process env vars. Suitable for single-tenant self-deployed scenarios without control plane.
// Resides together with the interface, following existing project conventions (cf. MockCredentialProvider and
// ICredentialProvider both written in src/core/storage/credential-provider.ts).
//
// Environment variables:
//   VDB_ENDPOINT, VDB_USER, VDB_API_KEY, VDB_DATABASE
//   COS_SECRET_ID, COS_SECRET_KEY, COS_TOKEN, COS_URL, COS_PATH_PREFIX

export class LocalConfigSource implements IConfigSource {
  // Logger kept for future diagnostic logging; constructor signature mirrors
  // remote sources so callers can swap implementations interchangeably.
  constructor(private readonly _logger: Logger) {
    void this._logger;
  }

  async fetchVdb(_instanceId: string): Promise<VdbConfig> {
    return readVdbEnvConfig();
  }

  async fetchCos(): Promise<CosConfig | null> {
    const cfg = readCosEnvConfig();
    if (!cfg) return null;
    return {
      cosUrl: cfg.cosUrl,
      tmpSecretId: cfg.tmpSecretId,
      tmpSecretKey: cfg.tmpSecretKey,
      tmpToken: cfg.tmpToken,
      expirationTime: "",
      pathPrefix: cfg.pathPrefix,
    };
  }
}

// ════════════════════════════════════════════════════════
// VDB cache entry
// ════════════════════════════════════════════════════════

interface VdbCacheEntry {
  config: VdbConfig;
  expiresAt: number;
  lastAccessedAt: number;
}

// ════════════════════════════════════════════════════════
// InstanceConfigProvider
// ════════════════════════════════════════════════════════

export interface InstanceConfigProviderOptions {
  /**
   * Pre-constructed config source for the current deployment.
   */
  source: IConfigSource;
  /** VDB cache TTL (ms), default 5 minutes */
  vdbTtlMs?: number;
  /** COS credential early refresh time (ms), default 2 minutes */
  cosBufferMs?: number;
  /** Max cached instances, LRU eviction upon exceeding, default 1000 */
  maxInstances?: number;
  logger: Logger;
}

export class InstanceConfigProvider {
  private source: IConfigSource;
  private logger: Logger;

  // ── VDB: per-instance cache ──
  private vdbPool = new Map<string, VdbCacheEntry>();
  private vdbTtlMs: number;
  private maxInstances: number;
  /**
   * Per-instance in-flight fetch dedupe (H-2 fix):
   * When accessing the same instanceId concurrently for the first time, reuse the same fetch Promise,
   * to avoid triggering rate limits by sending N requests to source simultaneously.
   */
  private vdbFetchPromises = new Map<string, Promise<VdbConfig>>();

  // ── COS: global singleton cache (one credential, isolated by PathPrefix) ──
  private cosCache: CosConfig | null = null;
  private cosExpiresAt = 0;
  private cosBufferMs: number;
  private cosFetchPromise: Promise<CosConfig | null> | null = null;

  constructor(opts: InstanceConfigProviderOptions) {
    this.logger = opts.logger;
    this.vdbTtlMs = opts.vdbTtlMs ?? 5 * 60 * 1000;
    this.cosBufferMs = opts.cosBufferMs ?? 2 * 60 * 1000;
    this.maxInstances = opts.maxInstances ?? 1000;
    this.source = opts.source;
    this.logger.info(`[instance-config] InstanceConfigProvider initialized (source=${opts.source.constructor.name})`);
  }

  // ════════════════════════════════════════════════════════
  // Public API
  // ════════════════════════════════════════════════════════

  /**
   * Get full config for specified instance (VDB per-instance + COS global)
   */
  async resolve(instanceId: string): Promise<InstanceConfig> {
    const [vdb, cos] = await Promise.all([
      this.resolveVdb(instanceId),
      this.resolveCos(),
    ]);
    return { instanceId, vdb, cos };
  }
  /**
   * Get VDB config for specified instance (with cache)
   *
   * Strategy:
   * 1. Cache hit and not expired -> return directly (and refresh LRU position)
   * 2. Cache empty or expired -> fetch from source (in-flight deduplication for concurrent requests to same instanceId)
   * 3. Source returns empty/error -> error directly and log (do not cache empty values)
   */
  async resolveVdb(instanceId: string): Promise<VdbConfig> {
    const now = Date.now();
    const cached = this.vdbPool.get(instanceId);

    if (cached && now < cached.expiresAt) {
      cached.lastAccessedAt = now;
      // LRU Reorder (H-3): move entry to end of Map, so taking first element on evict is LRU.
      // delete+set is an O(1) operation for Map on V8.
      this.vdbPool.delete(instanceId);
      this.vdbPool.set(instanceId, cached);
      return cached.config;
    }

    // Cache miss or expired -> enter fetch path, deduplicate then request (H-2)
    const inflight = this.vdbFetchPromises.get(instanceId);
    if (inflight) {
      this.logger.debug?.(`[instance-config] VDB fetch in-flight for ${instanceId}, awaiting...`);
      return inflight;
    }

    this.logger.debug?.(`[instance-config] VDB cache ${cached ? "expired" : "miss"} for ${instanceId}, fetching...`);
    const fetchPromise = this.fetchAndStoreVdb(instanceId);
    this.vdbFetchPromises.set(instanceId, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      // Clean in-flight flag. Note to clean after await (even if fetch throws error), 
      // otherwise one failure will permanently stuck this instanceId.
      this.vdbFetchPromises.delete(instanceId);
    }
  }

  /**
   * Actual execution of source fetch + writing to vdbPool.
   * Only called internally by resolveVdb (concurrency deduplication ensures it runs only once).
   */
  private async fetchAndStoreVdb(instanceId: string): Promise<VdbConfig> {
    const config = await this.source.fetchVdb(instanceId);

    // source returns empty -> directly report error and log
    if (!config || !config.url) {
      const msg = `[instance-config] Config source returned empty VDB config for instanceId="${instanceId}" (url=${config?.url})`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    // LRU eviction
    if (this.vdbPool.size >= this.maxInstances && !this.vdbPool.has(instanceId)) {
      this.evictLru();
    }

    const now = Date.now();
    this.vdbPool.set(instanceId, {
      config,
      expiresAt: now + this.vdbTtlMs,
      lastAccessedAt: now,
    });

    return config;
  }

  /**
   * Get global COS config (with cache, automatically renews temp credentials)
   */
  async resolveCos(): Promise<CosConfig | null> {
    const now = Date.now();

    // Cache valid -> return directly
    if (this.cosCache && now < this.cosExpiresAt) {
      return this.cosCache;
    }

    // Prevent concurrent requests from refreshing at the same time
    if (this.cosFetchPromise) {
      return this.cosFetchPromise;
    }

    this.cosFetchPromise = this.refreshCos(now).finally(() => {
      this.cosFetchPromise = null;
    });

    return this.cosFetchPromise;
  }

  /**
   * Clear VDB cache for specified instance (called when instance goes offline)
   */
  evictVdb(instanceId: string): void {
    this.vdbPool.delete(instanceId);
    this.logger.debug?.(`[instance-config] Evicted VDB cache for ${instanceId}`);
  }

  /**
   * Force refresh COS credentials
   */
  async refreshCosNow(): Promise<CosConfig | null> {
    return this.refreshCos(Date.now());
  }

  /**
   * Clear all caches
   */
  clear(): void {
    this.vdbPool.clear();
    this.cosCache = null;
    this.cosExpiresAt = 0;
    this.logger.info(`[instance-config] All caches cleared`);
  }

  /**
   * Number of currently cached instances
   */
  get poolSize(): number {
    return this.vdbPool.size;
  }

  /**
   * Whether current COS credentials are valid
   */
  get isCosValid(): boolean {
    return this.cosCache !== null && Date.now() < this.cosExpiresAt;
  }

  // ════════════════════════════════════════════════════════
  // Internal
  // ════════════════════════════════════════════════════════

  private async refreshCos(now: number): Promise<CosConfig | null> {
    this.logger.debug?.(`[instance-config] Refreshing COS config...`);
    try {
      const cos = await this.source.fetchCos();
      this.cosCache = cos;
      this.cosExpiresAt = this.calcCosExpiry(cos, now);
      return cos;
    } catch (e) {
      this.logger.warn(`[instance-config] Failed to refresh COS config: ${e}`);
      // If old cache still exists, extend a short time and continue using (degrade)
      if (this.cosCache) {
        this.cosExpiresAt = now + 30_000; // retry after 30s
        this.logger.warn(`[instance-config] Using stale COS config for 30s`);
        return this.cosCache;
      }
      return null;
    }
  }

  /**
   * Calculate COS cache expiration time:
   *   - With expirationTime: min(server expiration time - buffer, vdbTtl)
   *   - No expirationTime: Use vdbTtl (local long-term credential scenario)
   */
  private calcCosExpiry(cos: CosConfig | null, now: number): number {
    if (!cos?.expirationTime) {
      return now + this.vdbTtlMs;
    }
    const serverExpiry = new Date(cos.expirationTime).getTime();
    if (isNaN(serverExpiry)) {
      return now + this.vdbTtlMs;
    }
    return Math.min(serverExpiry - this.cosBufferMs, now + this.vdbTtlMs);
  }

  /**
   * LRU Eviction: Delete the least recently accessed instance.
   *
   * Implementation note (H-3): Utilizing the trait that Map insertion order is access order —— resolveVdb during cache hit
   * already does delete+set moving hot key to the end of Map, so the first element of Map is LRU,
   * just take the first key, O(1).
   */
  private evictLru(): void {
    const firstKey = this.vdbPool.keys().next().value;
    if (firstKey !== undefined) {
      this.vdbPool.delete(firstKey);
      this.logger.debug?.(`[instance-config] LRU evicted VDB cache for ${firstKey}`);
    }
  }
}
