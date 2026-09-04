/**
 * StorePool — Store instance pool per-instanceId
 *
 * Dual mode support:
 *   - standalone: Uses SQLite local storage (one SQLite file per instanceId)
 *   - service: Uses TCVDB vector database (one remote VDB connection per instanceId)
 *
 * Works with InstanceConfigProvider:
 *   1. When a request arrives, fetches the VDB config for the instanceId from InstanceConfigProvider
 *   2. Creates/reuses a Store instance using the VDB config
 *   3. Pooled management to avoid creating duplicate connections
 *
 * In standalone mode:
 *   - If VdbConfig is empty or from environment variables → creates SQLite Store
 *   - Fixes a "default" instanceId, behavior is consistent with the original createStoreBundle
 */

import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { MemoryTdaiConfig } from "../../config.js";
import type { IMemoryStore, StoreLogger } from "./types.js";
import type { EmbeddingService } from "./embedding.js";
import { createEmbeddingService, NoopEmbeddingService } from "./embedding.js";
import { VectorStore } from "./sqlite.js";
import { TcvdbMemoryStore } from "./tcvdb.js";
import { TcvdbSkillStore } from "./tcvdb-skill-store.js";
import { createBM25Encoder } from "./bm25-local.js";
import type { BM25LocalEncoder } from "./bm25-local.js";
import type { VdbConfig } from "../instance-config-provider.js";
import type { ISkillStore } from "../skill/skill-store.interface.js";
import { metricProducer } from "../report/kafka-metric-producer.js";

const TAG = "[store-pool]";

// ════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════

export interface PooledStore {
  store: IMemoryStore;
  embedding: EmbeddingService;
  bm25Encoder?: BM25LocalEncoder;
}

interface PoolEntry {
  pooledStore: PooledStore;
  /** VDB config fingerprint, used to detect config changes */
  configFingerprint: string;
  lastAccessedAt: number;
}

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export type StoreMode = "sqlite" | "tcvdb";

export interface KafkaMetricOptions {
  /** Kafka Broker list (comma separated or array) */
  brokers?: string[] | string;
  /** Topic name (default: "memory_monitor") */
  topic?: string;
  /** Whether enabled (default: automatically determined based on whether brokers is non-empty) */
  enabled?: boolean;
}

export interface StorePoolOptions {
  /** Storage mode: "sqlite" (standalone local) or "tcvdb" (service remote) */
  mode: StoreMode;
  /** Memory plugin config (used for BM25/embedding settings) */
  memoryCfg: MemoryTdaiConfig;
  /** Data directory (used in SQLite mode) */
  dataDir?: string;
  /** Max pooled instance count (Memory store), default 100 */
  maxStores?: number;
  /** Max Skill store cache count, default 100 */
  maxSkillStores?: number;
  /** Kafka metric reporting config (optional, will not report if not configured) */
  kafka?: KafkaMetricOptions;
  logger: Logger;
}

// ════════════════════════════════════════════════════════
// StorePool
// ════════════════════════════════════════════════════════

export class StorePool {
  private pool = new Map<string, PoolEntry>();
  private maxStores: number;
  readonly mode: StoreMode;
  private memoryCfg: MemoryTdaiConfig;
  private dataDir: string;
  private logger: Logger;
  /** Globally shared BM25 encoder (avoids OOM caused by reloading jieba dictionary) */
  private sharedBm25Encoder: BM25LocalEncoder | undefined;

  /** Skill store cache limit */
  private maxSkillStores: number;
  /** Skill store last access time (for LRU eviction) */
  private skillStoreAccessTimes = new Map<string, number>();



  /**
   * Grace-close tracking: entries removed from pool but whose underlying close is delayed.
   * CR-5 mitigation (2026-05-19): evict / config-change do not immediately close the underlying store,
   * but delay close by graceCloseDelayMs, allowing in-flight requests (sync paths recall/capture
   * <100ms; async worker paths L1/L2/L3 backed by maxRetries=3 + exponential backoff) time to complete.
   */
  private pendingCloses = new Set<Promise<void>>();
  /** Grace period default 30s, much larger than sync path wall clock (recall ~49ms / capture ~54ms),
   *  and even if worker paths hit it, they have reEnqueue retry mechanism (5s/15s/45s). */
  private graceCloseDelayMs = 30_000;

  constructor(opts: StorePoolOptions) {
    this.maxStores = opts.maxStores ?? 100;
    this.maxSkillStores = opts.maxSkillStores ?? 100;
    this.mode = opts.mode;
    this.memoryCfg = opts.memoryCfg;
    this.dataDir = opts.dataDir ?? ".";
    this.logger = opts.logger;

    // Create BM25 encoder once upon initialization, shared across all Stores
    this.sharedBm25Encoder = createBM25Encoder(this.memoryCfg.bm25, this.logger as StoreLogger);

    // Initialize Kafka Metric Producer (async, does not block construction)
    this.initKafkaMetricProducer(opts.kafka);

    this.logger.info(`${TAG} Initialized: mode=${this.mode}, maxStores=${this.maxStores}, maxSkillStores=${this.maxSkillStores}, bm25=${this.sharedBm25Encoder ? "shared" : "disabled"}`);
  }

  /**
   * Initializes Kafka Metric Producer.
   * Executes asynchronously, does not block StorePool construction. Initialization failures are silently ignored.
   * Config priority: StorePoolOptions.kafka > environment variables (fallback)
   */
  private initKafkaMetricProducer(kafka?: KafkaMetricOptions): void {
    // Config takes priority, environment variables are only for fallback
    const rawBrokers = kafka?.brokers ?? "";
    const brokers = Array.isArray(rawBrokers)
      ? rawBrokers
      : rawBrokers.split(",").map(s => s.trim()).filter(Boolean);

    const enabled = kafka?.enabled ?? brokers.length > 0;
    if (!enabled || brokers.length === 0) {
      this.logger.info(`${TAG} Kafka metric producer disabled (no brokers configured)`);
      return;
    }

    // Async initialization, does not block business logic
    metricProducer.initialize({
      brokers,
      topic: kafka?.topic ?? "memory_monitor",
      enabled: true,
    }).catch((err) => {
      // Initialization failures are silently handled, does not affect business logic
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${TAG} Kafka metric producer init failed: ${msg}. Metrics disabled.`);
    });
  }

  /**
   * Get the Store instance corresponding to the specified instanceId
   *
   * - standalone (sqlite): vdbConfig can be null, creates SQLite Store
   * - service (tcvdb): creates TCVDB Store based on vdbConfig
   */
  async getStore(instanceId: string, vdbConfig: VdbConfig | null): Promise<PooledStore> {
    const now = Date.now();
    const fingerprint = this.mode === "tcvdb" && vdbConfig
      ? this.computeFingerprint(vdbConfig)
      : `sqlite:${instanceId}`;
    const cached = this.pool.get(instanceId);

    // Cache hit and config unchanged
    if (cached && cached.configFingerprint === fingerprint) {
      cached.lastAccessedAt = now;
      return cached.pooledStore;
    }

    // Config changed → close the old one
    if (cached) {
      this.logger.info(`${TAG} Config changed for ${instanceId}, recreating store`);
      await this.closeEntry(instanceId, cached);
    }

    // LRU eviction
    if (this.pool.size >= this.maxStores) {
      await this.evictLru();
    }

    // Create new Store
    const pooledStore = this.mode === "tcvdb" && vdbConfig
      ? this.createTcvdbStore(vdbConfig)
      : this.createSqliteStore(instanceId);

    this.pool.set(instanceId, {
      pooledStore,
      configFingerprint: fingerprint,
      lastAccessedAt: now,
    });

    const storeDesc = this.mode === "tcvdb" && vdbConfig
      ? `${vdbConfig.url} / ${vdbConfig.database}`
      : `sqlite @ ${this.getSqlitePath(instanceId)}`;
    this.logger.info(
      `${TAG} Created ${this.mode} store for ${instanceId}: ${storeDesc} (pool size: ${this.pool.size})`,
    );

    // Initialize Store (create tables/check connection)
    try {
      await pooledStore.store.init();
    } catch (e) {
      this.logger.warn(`${TAG} Store init failed for ${instanceId}: ${e}`);
    }

    return pooledStore;
  }

  /**
   * Remove the Store for the specified instance (called when instance goes offline)
   */
  async evict(instanceId: string): Promise<void> {
    const entry = this.pool.get(instanceId);
    if (entry) {
      await this.closeEntry(instanceId, entry);
    }
  }

  /**
   * Close all Stores
   *
   * CR-5: The original closeAll directly and synchronously closed all stores in the pool, which would crash in-flight requests.
   * Now it is split into two steps:
   *   1. Trigger closeEntry for all entries (delayed close, added to pendingCloses)
   *   2. Wait for all pendingCloses to complete (including new additions this time + remnants from previous evicts)
   * During process shutdown, callers can choose to shorten the grace period to avoid blocking: setGraceCloseDelay(0)
   */
  async closeAll(): Promise<void> {
    // Close Memory store pool
    const entries = [...this.pool.entries()];
    this.pool.clear();
    // Trigger delayed close (these promises will be automatically added to pendingCloses)
    for (const [id, entry] of entries) {
      await this.closeEntry(id, entry);  // closeEntry returns immediately without blocking internally
    }

    // Close Skill store cache
    for (const [key, store] of this.skillStoreCache) {
      try {
        store.close();
        this.logger.debug?.(`${TAG} Closed skill store: ${key}`);
      } catch (e) {
        this.logger.warn(`${TAG} Error closing skill store ${key}: ${e}`);
      }
    }
    this.skillStoreCache.clear();
    this.skillStoreAccessTimes.clear();

    // Wait for all pending closes to complete (including this time + remnants from previous evicts)
    await Promise.allSettled([...this.pendingCloses]);
    this.logger.info(`${TAG} All stores closed (${entries.length} memory + skill caches cleared)`);
  }

  /**
   * Remove the Skill store for the specified instance (called when instance is destroyed).
   * Calls store.close() setting degraded=true, then removes it from cache.
   */
  evictSkillStore(instanceId: string): void {
    const key = `skill:${instanceId}`;
    const store = this.skillStoreCache.get(key);
    if (store) {
      try {
        store.close();
      } catch (e) {
        this.logger.warn(`${TAG} Error closing skill store ${key}: ${e}`);
      }
      this.skillStoreCache.delete(key);
      this.skillStoreAccessTimes.delete(key);
      this.logger.info(`${TAG} Evicted skill store for ${instanceId} (cached: ${this.skillStoreCache.size})`);
    }
  }

  /**
   * Set grace-close delay (in milliseconds). When set to 0, closes immediately, losing in-flight protection.
   * Mainly used for testing or emergency process exit scenarios.
   */
  setGraceCloseDelay(ms: number): void {
    this.graceCloseDelayMs = Math.max(0, ms);
  }

  get size(): number { return this.pool.size; }
  has(instanceId: string): boolean { return this.pool.has(instanceId); }

  /**
   * Get the Skill Store (TCVDB) for the specified instanceId.
   *
   * Uses the same VDB instance as getStore(), just a different Collection ({db}_skills).
   * Skill store has an independent cache (skillStoreCache), unaffected by Memory store pooled management.
   */
  async getSkillStore(instanceId: string, vdbConfig: VdbConfig): Promise<ISkillStore> {
    const key = `skill:${instanceId}`;
    const cached = this.skillStoreCache.get(key);
    if (cached) {
      this.skillStoreAccessTimes.set(key, Date.now());
      return cached;
    }

    // LRU eviction
    if (this.skillStoreCache.size >= this.maxSkillStores) {
      this.evictSkillStoreLru();
    }

    const store = new TcvdbSkillStore({
      url: vdbConfig.url,
      username: vdbConfig.user,
      apiKey: vdbConfig.apiKey,
      database: vdbConfig.database,
      embeddingModel: this.memoryCfg.tcvdb?.embeddingModel ?? "bge-large-zh",
      timeout: this.memoryCfg.tcvdb?.timeout ?? 10000,
      logger: this.logger as StoreLogger,
      bm25Encoder: this.sharedBm25Encoder,
    });
    store.init();
    this.skillStoreCache.set(key, store);
    this.skillStoreAccessTimes.set(key, Date.now());
    this.logger.info(`${TAG} Created skill store for ${instanceId}: ${vdbConfig.url}/${vdbConfig.database} (cached: ${this.skillStoreCache.size})`);
    return store;
  }

  private skillStoreCache = new Map<string, ISkillStore>();

  // ════════════════════════════════════════════════════════
  // Internal — TCVDB Store
  // ════════════════════════════════════════════════════════

  private createTcvdbStore(vdbConfig: VdbConfig): PooledStore {
    // [DEBUG] For local debugging: CA certificate is required when connecting to VDB via public HTTPS.
    // Intranet deployments via HTTP port 80 do not need this logic.
    // Specify the PEM file path via the VDB_CA_PEM_PATH environment variable.
    const caPemPath = vdbConfig.url.startsWith("https://")
      ? (process.env.VDB_CA_PEM_PATH || undefined)
      : undefined;

    const store = new TcvdbMemoryStore({
      url: vdbConfig.url,
      username: vdbConfig.user,
      apiKey: vdbConfig.apiKey,
      database: vdbConfig.database,
      embeddingEnabled: this.memoryCfg.tcvdb?.embeddingEnabled,
      embeddingModel: this.memoryCfg.tcvdb?.embeddingModel ?? "bge-large-zh",
      timeout: this.memoryCfg.tcvdb?.timeout ?? 10000,
      caPemPath,
      logger: this.logger as StoreLogger,
      bm25Encoder: this.sharedBm25Encoder ?? undefined,
    });

    return {
      store,
      embedding: new NoopEmbeddingService() as unknown as EmbeddingService,
      bm25Encoder: this.sharedBm25Encoder,
    };
  }

  // ════════════════════════════════════════════════════════
  // Internal — SQLite Store
  // ════════════════════════════════════════════════════════

  private createSqliteStore(instanceId: string): PooledStore {
    // Embedding service (Remote API, e.g. OpenAI text-embedding)
    let embeddingService: EmbeddingService | undefined;
    const embCfg = this.memoryCfg.embedding;
    if (embCfg.enabled && embCfg.provider !== "local" && embCfg.provider !== "none" && embCfg.apiKey) {
      embeddingService = createEmbeddingService({
        provider: embCfg.provider,
        baseUrl: embCfg.baseUrl,
        apiKey: embCfg.apiKey,
        model: embCfg.model,
        dimensions: embCfg.dimensions,
        maxInputChars: embCfg.maxInputChars,
      }, this.logger as StoreLogger);
    }

    const dims = embCfg.dimensions ?? 0;
    const dbPath = this.getSqlitePath(instanceId);
    // Ensure database directory exists (for non-default instances)
    const dbDir = path.dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    const store = new VectorStore(dbPath, dims, this.logger as StoreLogger);

    return {
      store,
      embedding: (embeddingService ?? new NoopEmbeddingService()) as unknown as EmbeddingService,
      bm25Encoder: this.sharedBm25Encoder,
    };
  }

  /**
   * SQLite file path:
   *   - "default" → dataDir/vectors.db (compatible with original logic)
   *   - Other instanceId → dataDir/instances/{instanceId}/vectors.db
   */
  private getSqlitePath(instanceId: string): string {
    if (instanceId === "default") {
      return path.join(this.dataDir, "vectors.db");
    }
    return path.join(this.dataDir, "instances", instanceId, "vectors.db");
  }

  // ════════════════════════════════════════════════════════
  // Internal — Common
  // ════════════════════════════════════════════════════════

  private computeFingerprint(cfg: VdbConfig): string {
    return `tcvdb:${cfg.url}|${cfg.database}|${cfg.apiKey}`;
  }

  private async closeEntry(instanceId: string, entry: PoolEntry): Promise<void> {
    // CR-5 mitigation: Immediately remove from pool (new requests won't get this entry, will create a new store),
    // but delay underlying store.close() by graceCloseDelayMs, allowing any in-flight requests holding a reference
    // to this entry time to complete. No reference counting added to avoid modifying all callers;
    // worker paths have maxRetries=3 backoff, sync path wall clock is much smaller than grace period, double insurance.
    this.pool.delete(instanceId);

    const closePromise = (async () => {
      // Wait for grace period
      if (this.graceCloseDelayMs > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.graceCloseDelayMs);
          // unref avoids blocking process exit (closeAll will actively await these promises)
          if (typeof (t as { unref?: () => void }).unref === "function") {
            (t as { unref: () => void }).unref();
          }
        });
      }
      try {
        await entry.pooledStore.store.close();
        this.logger.debug?.(`${TAG} Closed store for ${instanceId} (after ${this.graceCloseDelayMs}ms grace)`);
      } catch (e) {
        this.logger.warn(`${TAG} Error closing store for ${instanceId}: ${e}`);
      }
    })();

    this.pendingCloses.add(closePromise);
    closePromise.finally(() => this.pendingCloses.delete(closePromise));
    // Do not await — caller returns immediately, actual close happens in the background
  }

  private async evictLru(): Promise<void> {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.pool) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.pool.get(oldestKey)!;
      await this.closeEntry(oldestKey, entry);
      this.logger.debug?.(`${TAG} LRU evicted store for ${oldestKey}`);
    }
  }

  /** Skill store LRU eviction: kicks out the least recently accessed entry. */
  private evictSkillStoreLru(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, time] of this.skillStoreAccessTimes) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const store = this.skillStoreCache.get(oldestKey);
      if (store) {
        try {
          store.close();
        } catch (e) {
          this.logger.warn(`${TAG} Error closing skill store ${oldestKey} during LRU evict: ${e}`);
        }
      }
      this.skillStoreCache.delete(oldestKey);
      this.skillStoreAccessTimes.delete(oldestKey);
      this.logger.debug?.(`${TAG} LRU evicted skill store: ${oldestKey}`);
    }
  }
}
