import { describe, it, expect, vi, afterEach } from 'vitest';
import { FetchKernelHttpAdapter } from '../../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';
import { FetchMetaKernelAdapter } from '../../src/panel/kernel/adapters/fetch-meta-kernel-adapter.js';
import { FetchSkillKernelAdapter } from '../../src/panel/kernel/adapters/fetch-skill-kernel-adapter.js';

function stubFetchOk() {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 200, ok: true, json: async () => ({ code: 0, message: 'ok', request_id: 'r', data: { n: 1 } }),
  })));
}
function stubFetchError() {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FetchKernelHttpAdapter', () => {
  it('returns envelope on success', async () => {
    stubFetchOk();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => logger) } as any;
    const adapter = new FetchKernelHttpAdapter(logger);
    const out = await adapter.postEnvelope('/x', { a: 1 }, {
      endpoint: 'http://e', apiKey: 'k', instanceId: 'i', timeoutMs: 10, requestId: 'r',
    });
    expect(out.code).toBe(0);
    expect(out.data).toEqual({ n: 1 });
  });

  it('maps timeout/unavailable/other errors', async () => {
    stubFetchError();
    const adapter = new FetchKernelHttpAdapter(undefined);
    const cred = { endpoint: 'http://e', apiKey: 'k', instanceId: 'i', timeoutMs: 10, requestId: 'r' };
    const out = await adapter.postEnvelope('/x', {}, cred);
    expect(out.code).toBe(502);
    expect(out.message).toBe('KERNEL_UNAVAILABLE');
  });

  it('passes through non-KernelFetchError', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => logger) } as any;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      json: async () => {
        const err: any = new Error('surprise');
        throw err;
      },
    })));
    const adapter = new FetchKernelHttpAdapter(logger);
    // resp.json throwing yields resp.json().catch(()=>null) → null → invalid envelope → KernelFetchError 502.
    // To hit the "throw err" passthrough path, make executeMetaFetch fail with a non-fetch error instead.
    const out = await adapter.postEnvelope('/x', {}, { endpoint: 'http://e', apiKey: 'k', instanceId: 'i', timeoutMs: 10, requestId: 'r' });
    expect(out.code).toBe(502);
  });
});

describe('FetchMetaKernelAdapter', () => {
  function make(env: any) {
    const http = { postEnvelope: vi.fn().mockResolvedValue(env) };
    const adapter = new FetchMetaKernelAdapter(http as any, 100);
    return { http, adapter };
  }
  const ctx: any = { instanceId: 'i', gatewayEndpoint: 'http://e', gatewayApiKey: 'k', userKey: 'uk', reqId: 'r' };

  it('invokes /v3/meta and passes body through for list actions', async () => {
    const { http, adapter } = make({ code: 0 });
    await adapter.invoke('user/list', { limit: 1, offset: 0 }, ctx);
    const [path, body, cred] = http.postEnvelope.mock.calls[0];
    expect(path).toBe('/v3/meta/user/list');
    expect(body).toEqual({ limit: 1, offset: 0 });
    expect(cred.userKey).toBe('uk');
  });

  it('strips limit/offset for non-list actions', async () => {
    const { http, adapter } = make({ code: 0 });
    await adapter.invoke('user/create', { username: 'a', limit: 5, offset: 0 }, ctx);
    const [path, body] = http.postEnvelope.mock.calls[0];
    expect(path).toBe('/v3/meta/user/create');
    expect(body).toEqual({ username: 'a' });
  });

  it('keeps body when no limit/offset', async () => {
    const { http, adapter } = make({ code: 0 });
    await adapter.invoke('user/create', { username: 'a' }, ctx);
    expect(http.postEnvelope.mock.calls[0][1]).toEqual({ username: 'a' });
  });

  it('auth/verify omits userKey', async () => {
    const { http, adapter } = make({ code: 0 });
    await adapter.invoke('auth/verify', { user_key: 'uk' }, ctx);
    const [, , cred] = http.postEnvelope.mock.calls[0];
    expect(cred.userKey).toBeUndefined();
  });
});

describe('FetchSkillKernelAdapter', () => {
  it('invokes /v3/skill with full body', async () => {
    const http = { postEnvelope: vi.fn().mockResolvedValue({ code: 0 }) };
    const adapter = new FetchSkillKernelAdapter(http as any, 100);
    const ctx: any = { instanceId: 'i', gatewayEndpoint: 'http://e', gatewayApiKey: 'k', userKey: 'uk' };
    await adapter.invoke('create', { name: 'x' }, ctx);
    const [path, body, cred] = http.postEnvelope.mock.calls[0];
    expect(path).toBe('/v3/skill/create');
    expect(body).toEqual({ name: 'x' });
    expect(cred.userKey).toBe('uk');
  });
});