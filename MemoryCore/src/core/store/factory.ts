/**
 * Store Factory — creates the storage backend and embedding service
 * based on plugin configuration.
 *
 * Supports:
 * - "sqlite" (only): local SQLite + sqlite-vec + FTS5
 *
 * TCVDB support was removed (feat/remove-tcvdb). Any legacy
 * storeBackend="tcvdb" value degrades to sqlite with a warn.
 */

import path from "node:path";
import type { MemoryTdaiConfig } from "../../config.js";
import type { IMemoryStore, IEmbeddingService, StoreLogger } from "./types.js";
import { VectorStore } from "./sqlite.js";
import { createEmbeddingService, NoopEmbeddingService } from "./embedding.js";
import type { EmbeddingService } from "./embedding.js";
import { createBM25Encoder } from "./bm25-local.js";
import type { BM25LocalEncoder } from "./bm25-local.js";

// Re-export for convenience
export type { IMemoryStore, IEmbeddingService, StoreLogger, BM25LocalEncoder };

const TAG = "[memory-tdai][factory]";

export interface StoreBundle {
  store: IMemoryStore;
  embedding: IEmbeddingService;
  bm25Encoder?: BM25LocalEncoder;
  /** Snapshot of current store config for manifest writing. */
  storeSnapshot: import("../../utils/manifest.js").StoreConfigSnapshot;
}

/**
 * Create the storage backend, embedding service, and optional BM25 encoder
 * based on plugin configuration.
 *
 * @param config       Fully resolved plugin config.
 * @param options.dataDir    Plugin data directory.
 * @param options.logger     Logger instance.
 */
export function createStoreBundle(
  config: MemoryTdaiConfig,
  options: { dataDir: string; logger?: StoreLogger },
): StoreBundle {
  const { logger } = options;

  // --- BM25 local encoder ---
  const bm25Encoder = createBM25Encoder(config.bm25, logger);

  if ((config.storeBackend as string) !== "sqlite") {
    logger?.warn?.(
      `${TAG} unsupported storeBackend="${config.storeBackend}" — tcvdb removed, degrading to sqlite`,
    );
  }

  // --- Embedding service (only when enabled) ---
  let embeddingService: EmbeddingService | undefined;
  if (
    config.embedding.enabled &&
    config.embedding.provider !== "local" &&
    config.embedding.apiKey
  ) {
    embeddingService = createEmbeddingService(
      {
        provider: config.embedding.provider,
        baseUrl: config.embedding.baseUrl,
        apiKey: config.embedding.apiKey,
        model: config.embedding.model,
        dimensions: config.embedding.dimensions,
        sendDimensions: config.embedding.sendDimensions,
        maxInputChars: config.embedding.maxInputChars,
      },
      logger,
    );
  }

  // dimensions from config (0 when provider="none" → vec0 deferred)
  const dims = config.embedding.dimensions;
  const dbPath = path.join(options.dataDir, "vectors.db");
  const store = new VectorStore(dbPath, dims, logger);

  logger?.debug?.(
    `${TAG} Store created: backend=sqlite, dbPath=${dbPath}, dimensions=${dims}, ` +
      `embedding=${embeddingService ? "enabled" : "disabled"}, ` +
      `bm25=${bm25Encoder ? "enabled" : "disabled"}`,
  );

  return {
    store,
    // SAFETY: undefined means embedding disabled; downstream treats missing service as disabled (prior behavior).
    embedding: embeddingService as unknown as IEmbeddingService,
    bm25Encoder,
    storeSnapshot: {
      type: "sqlite",
      sqlitePath: path.relative(options.dataDir, dbPath),
    },
  };
}
