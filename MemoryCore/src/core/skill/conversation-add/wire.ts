/**
 * wire.ts — handler wiring entry point for skill conversation-add.
 *
 * After the 2026-07-30 pooling refactoring:
 *   - The old wireConversationAdd (per-instance handler + per-instance worker) has been removed.
 *   - The gateway calls wireConversationAddHandler per instance to only create the handler/trigger/sink/buffer;
 *     the worker is managed by the single process-wide SkillWorkerPool.
 */

import type { StorageAdapter } from "../../storage/adapter.js";
import type { ISkillExtractor, ExtractorLogger } from "../queue/types.js";

import { SkillBufferStorage } from "./buffer-storage.js";
import {
  LocalSkillAgentTaskQueue,
  RedisSkillAgentTaskQueue,
  type ISkillAgentTaskQueue,
  type RedisLike as AgentQueueRedisLike,
} from "./agent-task-queue.js";
import { SkillTriggerService } from "./trigger-service.js";
import { SkillConversationAddHandler, type HandlerThresholds } from "./add-handler.js";
import type { CompressOptions } from "./message-compressor.js";
import type { OversizeOptions } from "./oversize-strategy.js";
import type { SkillCandidatesSink } from "./extract-worker.js";
import { SkillCoreSink, type MetadataServiceLike } from "./skill-core-sink.js";

export interface WireConversationAddDeps {
  storage: StorageAdapter;
  /** Production: ioredis client; Test: LocalSkillAgentTaskQueue injected directly into `queue` to override */
  redis?: AgentQueueRedisLike;
  /** Test injected queue; if omitted, constructs a RedisSkillAgentTaskQueue based on redis */
  queue?: ISkillAgentTaskQueue;
  /** Redis key prefix, defaults to "skill" — aligns with design doc §5 */
  redisKeyPrefix?: string;

  /**
   * The metadata service needed by the sink for fallback skill asset registration (idempotent).
   * When omitted, the sink is a no-op — the skill is already persisted by the extractor's tool-call,
   * it just might not be visible on the frontend management page (no onSkillCreated hook in standalone mode).
   */
  metadataService?: MetadataServiceLike;

  /**
   * Reserved field used for compatibility with the old signature (wireConversationAddHandler internally
   * does not use the extractor; the actual extraction is resolved dynamically by SkillWorkerPool's resolveExtractor).
   * The gateway side currently passes a noop placeholder.
   */
  extractor: ISkillExtractor;

  logger: ExtractorLogger;

  /** Handler threshold overrides */
  thresholds?: Partial<HandlerThresholds>;

  /** Single tool message head/tail compression rules override (corresponds to SkillConfig.compress). */
  compressOptions?: Partial<CompressOptions>;

  /** Fallback chunking parameters override (corresponds to chunkMaxBytes / headKeepBytes / tailKeepBytes derived from SkillConfig.extraction). */
  oversizeOptions?: Partial<OversizeOptions>;

  /** COS sub-path (defaults to "skill_buffer") */
  bufferSubPath?: string;
}

/**
 * Only creates the 4 components needed by the handler (handler / trigger / sink / buffer) +
 * queue (dispatched based on redis/memory if not injected). **Does not start the worker**.
 *
 * Process-wide workers are managed uniformly by SkillWorkerPool; the gateway calls this function
 * on the first access per instance to get the handler bundle, inserts it into the in-flight cache,
 * and reuses it subsequently.
 */
export interface WiredConversationAddHandler {
  handler: SkillConversationAddHandler;
  trigger: SkillTriggerService;
  sink: SkillCandidatesSink;
  queue: ISkillAgentTaskQueue;
  buffer: SkillBufferStorage;
}

export function wireConversationAddHandler(
  deps: WireConversationAddDeps,
): WiredConversationAddHandler {
  const buffer = new SkillBufferStorage({
    storage: deps.storage,
    subPath: deps.bufferSubPath,
  });

  let queue: ISkillAgentTaskQueue;
  if (deps.queue) {
    queue = deps.queue;
  } else if (deps.redis) {
    queue = new RedisSkillAgentTaskQueue({
      client: deps.redis,
      keyPrefix: deps.redisKeyPrefix ?? "skill",
    });
  } else {
    // Fallback without Redis: only available in standalone single-node scenarios
    queue = new LocalSkillAgentTaskQueue();
    deps.logger.warn(
      "[skill-conversation-add] no redis nor queue injected — falling back to in-memory queue (single-node only)",
    );
  }

  const trigger = new SkillTriggerService({ buffer, queue });
  const handler = new SkillConversationAddHandler({
    buffer,
    trigger,
    thresholds: deps.thresholds,
    compressOptions: deps.compressOptions,
    oversizeOptions: deps.oversizeOptions,
  });

  const sink = new SkillCoreSink({
    metadata: deps.metadataService,
    logger: deps.logger,
  });

  return { handler, trigger, sink, queue, buffer };
}
