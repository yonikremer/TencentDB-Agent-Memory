import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { buildPanelDeps } from '../src/panel/panel-deps.js';
import { testConfig } from './helpers/mock-deps.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('buildPanelDeps', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pd-'));
    writeFileSync(join(dir, 'instances.json'), JSON.stringify({
      instances: [{ id: 'i1', name: 'One', gateway_endpoint: 'https://a.example.com', api_key: 'k' }],
    }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('builds full deps with real adapters', () => {
    const config = testConfig({ metadataInstancesConfig: join(dir, 'instances.json') });
    const deps = buildPanelDeps(config);
    expect(deps.logger).toBeTruthy();
    expect(deps.instanceRegistry.resolve('i1').name).toBe('One');
    expect(deps.kernelHttp).toBeTruthy();
    expect(deps.metaKernel).toBeTruthy();
    expect(deps.skillKernel).toBeTruthy();
    const kc = deps.knowledgeClientFactory('i1');
    expect(kc).toBeTruthy();
    expect(deps.knowledgeTaskRegistry.size()).toBe(0);
    expect(deps.ingestProgressStore).toBeTruthy();
  });
});