import { describe, it, expect, afterEach } from 'vitest';
import { InstanceRegistry, InstanceRegistryError } from '../../src/panel/config/instance-registry.js';
import { loadPanelConfig } from '../../src/panel/config/panel-config.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('InstanceRegistry', () => {
  const entries = [
    { instance_id: 'i1', name: 'One', gateway_endpoint: 'https://a.example.com', proxy_endpoint: 'https://p.example.com', api_key: 'k1' },
    { instance_id: 'i2', name: 'Two', gateway_endpoint: 'https://b.example.com', api_key: 'k2' },
  ];

  it('construct, resolve, listPublic, listAll', () => {
    const reg = new InstanceRegistry(entries);
    expect(reg.resolve('i1').api_key).toBe('k1');
    expect(reg.listPublic()).toEqual([
      { instance_id: 'i1', name: 'One', gateway_endpoint: 'https://a.example.com', proxy_endpoint: 'https://p.example.com' },
      { instance_id: 'i2', name: 'Two', gateway_endpoint: 'https://b.example.com' },
    ]);
    expect(reg.listAll()).toHaveLength(2);
  });

  it('resolve unknown throws 400', () => {
    const reg = new InstanceRegistry(entries);
    try {
      reg.resolve('nope');
      throw new Error('should throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(InstanceRegistryError);
      expect(e.code).toBe(400);
    }
  });

  describe('load', () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    it('loads valid file', () => {
      dir = mkdtempSync(join(tmpdir(), 'reg-'));
      const file = join(dir, 'instances.json');
      writeFileSync(file, JSON.stringify({ instances: [{ id: 'a', name: 'A', gateway_endpoint: 'https://a.example.com', api_key: 'ka' }] }));
      const reg = InstanceRegistry.load(file);
      expect(reg.resolve('a').name).toBe('A');
    });
    it('throws 500 when missing file', () => {
      dir = mkdtempSync(join(tmpdir(), 'reg-'));
      expect(() => InstanceRegistry.load(join(dir, 'missing.json'))).toThrow(InstanceRegistryError);
    });
    it('throws 500 on invalid json', () => {
      dir = mkdtempSync(join(tmpdir(), 'reg-'));
      const file = join(dir, 'bad.json');
      writeFileSync(file, 'not json');
      expect(() => InstanceRegistry.load(file)).toThrow(/invalid metadata instances config/);
    });
    it('throws 500 on schema failure', () => {
      dir = mkdtempSync(join(tmpdir(), 'reg-'));
      const file = join(dir, 'bad.json');
      writeFileSync(file, JSON.stringify({ instances: [{ id: '', name: '', gateway_endpoint: 'nope', api_key: '' }] }));
      expect(() => InstanceRegistry.load(file)).toThrow(/validation failed/);
    });
  });
});

describe('loadPanelConfig', () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  it('defaults', () => {
    // Local .env (dotenv) may export LOG_FORMAT/HOST/etc — strip so defaults are asserted.
    for (const k of ['HOST', 'PORT', 'LOG_LEVEL', 'LOG_FORMAT', 'METADATA_INSTANCES_CONFIG',
      'METADATA_REMOTE_TIMEOUT_MS', 'UI_DIST_DIR', 'KNOWLEDGE_SERVICE_URL', 'KNOWLEDGE_AUTH_TOKEN',
      'KNOWLEDGE_TIMEOUT_MS', 'KNOWLEDGE_LLM_BINDING_SYNC', 'KNOWLEDGE_LLM_PROXY_BASE_URL',
      'TDAI_AGENT_TEMPLATE_DIR']) delete process.env[k];
    const cfg = loadPanelConfig();
    expect(cfg.server.port).toBe(8123);
    expect(cfg.log.level).toBe('info');
    expect(cfg.log.format).toBe('json');
    expect(cfg.knowledgeLlmBinding.sync).toBe(true);
  });

  it('overrides via env', () => {
    process.env.PORT = '9999';
    process.env.LOG_LEVEL = 'debug';
    process.env.LOG_FORMAT = 'pretty';
    process.env.KNOWLEDGE_LLM_BINDING_SYNC = 'false';
    process.env.HOST = '127.0.0.1';
    const cfg = loadPanelConfig();
    expect(cfg.server.port).toBe(9999);
    expect(cfg.log.level).toBe('debug');
    expect(cfg.log.format).toBe('pretty');
    expect(cfg.knowledgeLlmBinding.sync).toBe(false);
    expect(cfg.server.host).toBe('127.0.0.1');
  });

  it('invalid numeric/bool/log fallbacks', () => {
    process.env.PORT = 'abc';
    process.env.LOG_LEVEL = 'bogus';
    process.env.LOG_FORMAT = 'xml';
    process.env.KNOWLEDGE_LLM_BINDING_SYNC = 'maybe';
    const cfg = loadPanelConfig();
    expect(cfg.server.port).toBe(8123);
    expect(cfg.log.level).toBe('info');
    expect(cfg.log.format).toBe('json');
    expect(cfg.knowledgeLlmBinding.sync).toBe(false);
  });
});