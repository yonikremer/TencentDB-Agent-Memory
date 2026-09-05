import type { InstanceEntry } from './config/instance-registry.js';
import type { PanelConfig } from './config/panel-config.js';
import { InstanceRegistry } from './config/instance-registry.js';
import { ConsoleLogger } from './infra/console-logger.js';
import { FetchKernelHttpAdapter } from './kernel/adapters/fetch-kernel-http-adapter.js';
import { FetchMetaKernelAdapter } from './kernel/adapters/fetch-meta-kernel-adapter.js';
import { FetchSkillKernelAdapter } from './kernel/adapters/fetch-skill-kernel-adapter.js';
import type { KernelHttpPort } from './kernel/ports/kernel-http-port.js';
import type { MetaKernelPort } from './kernel/ports/meta-kernel-port.js';
import type { SkillKernelPort } from './kernel/ports/skill-kernel-port.js';
import type { Logger } from './infra/logger.js';
import type { KnowledgeClientPort } from './kernel/ports/knowledge-client-port.js';
import { HttpKnowledgeClient } from './kernel/adapters/http-knowledge-client.js';
import { KnowledgeTaskRegistry } from './state/knowledge-task-registry.js';
import { IngestProgressStore } from './state/ingest-progress-store.js';

export interface PanelDeps {
  config: PanelConfig;
  logger: Logger;
  instanceRegistry: InstanceRegistry;
  kernelHttp: KernelHttpPort;
  metaKernel: MetaKernelPort;
  /** Construct KS client by request instanceId (x-tdai-service-id = instanceId). */
  knowledgeClientFactory: (instanceId: string) => KnowledgeClientPort;
  skillKernel: SkillKernelPort;
  /** Knowledge extraction task memory state: stash owner key on create, retrieve registered meta asset on callback ready. */
  knowledgeTaskRegistry: KnowledgeTaskRegistry;
  /** Wiki ingest fine-grained progress (written by KS ingest_progress callback; aggregated read by wiki/get). */
  ingestProgressStore: IngestProgressStore;
}

export function buildPanelDeps(config: PanelConfig): PanelDeps {
  const logger = new ConsoleLogger({
    level: config.log.level,
    format: config.log.format,
  });
  const instanceRegistry = InstanceRegistry.load(config.metadataInstancesConfig);
  const kernelHttp = new FetchKernelHttpAdapter(logger);
  const metaKernel = new FetchMetaKernelAdapter(kernelHttp, config.metadataRemoteTimeoutMs);
  const knowledgeClientFactory = (instanceId: string): KnowledgeClientPort =>
    new HttpKnowledgeClient({
      baseUrl: config.knowledge.baseUrl,
      authToken: config.knowledge.authToken,
      serviceId: instanceId,
      timeoutMs: config.knowledge.timeoutMs,
    });
  const skillKernel = new FetchSkillKernelAdapter(kernelHttp, config.metadataRemoteTimeoutMs);
  const knowledgeTaskRegistry = new KnowledgeTaskRegistry();
  const ingestProgressStore = new IngestProgressStore();
  return {
    config,
    logger,
    instanceRegistry,
    kernelHttp,
    metaKernel,
    knowledgeClientFactory,
    skillKernel,
    knowledgeTaskRegistry,
    ingestProgressStore,
  };
}

export type { InstanceEntry };
