import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildPanelApp } from '../../src/panel/http/app.js';
import { makeDeps, TEST_INSTANCE_ID, type MockDeps } from '../helpers/mock-deps.js';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HDRS = {
  'x-tdai-service-id': TEST_INSTANCE_ID,
  'x-tdai-user-key': 'uk-1',
  'content-type': 'application/json',
};

function post(app: any, path: string, body?: unknown, headers: Record<string, string> = HDRS) {
  return app.request(path, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('buildPanelApp', () => {
  let deps: MockDeps;
  let app: any;
  let distDir: string;

  beforeEach(() => {
    deps = makeDeps();
    distDir = mkdtempSync(join(tmpdir(), 'dist-'));
    mkdirSync(join(distDir, 'assets'), { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<html>index</html>');
    writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log(1)');
    deps.config.ui.distDir = distDir;
    app = buildPanelApp(deps as any);
  });

  afterEach(() => rmSync(distDir, { recursive: true, force: true }));

  it('serves /health', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('serves meta/instances without auth headers', async () => {
    const res = await app.request('/api/v1/meta/instances');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.instances).toHaveLength(1);
    expect(json.instances[0].instance_id).toBe(TEST_INSTANCE_ID);
    expect(json.instances[0].api_key).toBeUndefined();
    expect(json.instances[0].proxy_endpoint).toBe('https://proxy.example.com');
  });

  it('proxies meta action with valid headers', async () => {
    deps.metaKernel.invoke.mockResolvedValue({ code: 0, message: 'ok', request_id: 'r', data: { items: [] } });
    const res = await post(app, '/api/v1/meta/user/list', { team_id: 't' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.code).toBe(0);
    expect(deps.metaKernel.invoke).toHaveBeenCalledWith('user/list', { team_id: 't' }, expect.anything());
  });

  it('onError returns 500 INTERNAL when handler throws', async () => {
    deps.metaKernel.invoke.mockRejectedValue(new Error('kaboom'));
    const res = await post(app, '/api/v1/meta/user/get', { user_id: 'u' });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toMatchObject({ code: 500, message: 'INTERNAL' });
  });

  it('serves static assets and index fallback for non-api paths', async () => {
    const asset = await app.request('/assets/app.js');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('console.log');
    const index = await app.request('/some/client/route');
    expect(index.status).toBe(200);
    const txt = await index.text();
    expect(txt).toContain('index');
  });

  it('api paths without route fall through to static 404', async () => {
    const res = await app.request('/api/v1/unknown-route', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});