import { vi } from 'vitest';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import type { PanelConfig } from '../../src/panel/config/panel-config.js';
import { InstanceRegistry, type InstanceEntry } from '../../src/panel/config/instance-registry.js';
import type { Logger } from '../../src/panel/infra/logger.js';
import type { KnowledgeClientPort } from '../../src/panel/kernel/ports/knowledge-client-port.js';
import { KnowledgeTaskRegistry } from '../../src/panel/state/knowledge-task-registry.js';
import { IngestProgressStore } from '../../src/panel/state/ingest-progress-store.js';

export const TEST_INSTANCE_ID = 'inst-1';

export function testConfig(overrides?: Partial<PanelConfig>): PanelConfig {
  const base: PanelConfig = {
    server: { host: '0.0.0.0', port: 8123 },
    metadataInstancesConfig: './config/metadata-instances.json',
    metadataRemoteTimeoutMs: 15000,
    ui: { distDir: '/nonexistent/dist' },
    log: { level: 'info', format: 'json' },
    knowledge: { baseUrl: 'http://127.0.0.1:8421', authToken: 'tok', timeoutMs: 15000 },
    knowledgeLlmBinding: { sync: false, proxyBaseUrl: 'http://127.0.0.1:8096' },
    agentTemplateDir: './data/agent-templates',
  };
  return { ...base, ...overrides };
}

export function testInstanceRegistry(): InstanceRegistry {
  const entries: InstanceEntry[] = [
    {
      instance_id: TEST_INSTANCE_ID,
      name: 'Test Instance',
      gateway_endpoint: 'https://kernel.example.com',
      proxy_endpoint: 'https://proxy.example.com',
      api_key: 'secret-key',
    },
  ];
  return new InstanceRegistry(entries);
}

/** Fake logger that records calls and returns itself from child(). */
export function makeLogger(): Logger & { calls: Array<[string, string, unknown]> } {
  const calls: Array<[string, string, unknown]> = [];
  const rec = (level: string) => (msg: string, fields?: unknown) => {
    calls.push([level, msg, fields]);
  };
  const logger: any = {
    calls,
    debug: rec('debug'),
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    child: vi.fn(() => logger),
  };
  return logger;
}

export interface MockDeps extends PanelDeps {
  metaKernel: { invoke: ReturnType<typeof vi.fn> };
  kernelHttp: { postEnvelope: ReturnType<typeof vi.fn> };
  skillKernel: { invoke: ReturnType<typeof vi.fn> };
  knowledgeClientFactory: ReturnType<typeof vi.fn>;
  _knowledgeClients: Map<string, KnowledgeClientPort>;
}

export function makeDeps(overrides?: Partial<PanelDeps>): MockDeps {
  const metaKernel = { invoke: vi.fn() };
  const kernelHttp = { postEnvelope: vi.fn() };
  const skillKernel = { invoke: vi.fn() };
  const _knowledgeClients = new Map<string, KnowledgeClientPort>();
  const knowledgeClientFactory = vi.fn((instanceId: string) => {
    let c = _knowledgeClients.get(instanceId);
    if (!c) {
      c = makeKnowledgeClientMock();
      _knowledgeClients.set(instanceId, c);
    }
    return c;
  });

  const deps: MockDeps = {
    config: testConfig(),
    logger: makeLogger(),
    instanceRegistry: testInstanceRegistry(),
    kernelHttp: kernelHttp as any,
    metaKernel: metaKernel as any,
    skillKernel: skillKernel as any,
    knowledgeClientFactory: knowledgeClientFactory as any,
    knowledgeTaskRegistry: new KnowledgeTaskRegistry(),
    ingestProgressStore: new IngestProgressStore(),
    _knowledgeClients,
    ...overrides,
  } as MockDeps;
  deps.metaKernel = metaKernel;
  deps.kernelHttp = kernelHttp;
  deps.skillKernel = skillKernel;
  return deps;
}

export interface KnowledgeMock extends KnowledgeClientPort {
  __mock: Record<string, ReturnType<typeof vi.fn>>;
}

/** KnowledgeClientPort where every method is a vi.fn resolving to null by default. */
export function makeKnowledgeClientMock(): KnowledgeMock {
  const methods = [
    'wikiCreate', 'wikiGet', 'wikiIngest', 'wikiDelete', 'wikiList', 'wikiUpdateMeta',
    'wikiRawLs', 'wikiRawRead', 'wikiRawWrite', 'wikiRawRm',
    'wikiPageLs', 'wikiPageRead', 'wikiPageWrite', 'wikiPageRm',
    'wikiGraph', 'wikiSearch',
    'codeGraphCreate', 'codeGraphList', 'codeGraphGet', 'codeGraphSync',
    'codeGraphDelete', 'codeGraphUpdateMeta', 'codeGraphQuery',
  ];
  const __mock: Record<string, ReturnType<typeof vi.fn>> = {};
  const client: any = {};
  for (const m of methods) {
    __mock[m] = vi.fn().mockResolvedValue(null);
    client[m] = __mock[m];
  }
  client.__mock = __mock;
  return client;
}

/** Standard ok envelope data for a list action. */
export function listEnvelope(items: unknown[], total?: number) {
  return { code: 0, message: 'ok', request_id: 'rid', data: { items, total: total ?? items.length } };
}

export function okEnv(data: unknown) {
  return { code: 0, message: 'ok', request_id: 'rid', data };
}