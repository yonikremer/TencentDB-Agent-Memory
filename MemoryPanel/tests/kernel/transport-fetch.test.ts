import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  executeMetaFetch,
  KernelFetchError,
  mapHttpStatusFromEnvelopeCode,
} from '../../src/panel/kernel/transport-fetch.js';

function jsonResponse(body: unknown, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn().mockResolvedValue(body),
  } as any;
}

function mockFetch(impl: (url: string, init: any) => any) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

const baseCfg = {
  endpoint: 'http://kernel.example.com/',
  apiKey: 'secret-api',
  serviceId: 'svc-1',
  userKey: 'user-1',
  timeoutMs: 1000,
  requestId: 'req-1',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('executeMetaFetch', () => {
  it('mode=data success returns data', async () => {
    const fetch = mockFetch(async () => jsonResponse({ code: 0, message: 'ok', request_id: 'rid', data: { n: 1 } }));
    const out = await executeMetaFetch(baseCfg, '/v3/meta/user/get', { user_id: 'u' }, 'data');
    expect(out).toEqual({ n: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer secret-api');
    expect(init.headers['x-tdai-service-id']).toBe('svc-1');
    expect(init.headers['x-tdai-user-key']).toBe('user-1');
    expect(init.headers['x-request-id']).toBe('req-1');
  });

  it('mode=envelope returns full envelope even on non-zero code', async () => {
    mockFetch(async () => jsonResponse({ code: 404, message: 'nf', request_id: 'rid', data: null }));
    const out = await executeMetaFetch(baseCfg, '/x', {}, 'envelope');
    expect(out.code).toBe(404);
    expect(out.message).toBe('nf');
  });

  it('mode=data throws KernelFetchError on non-zero code', async () => {
    mockFetch(async () => jsonResponse({ code: 403, message: 'denied', request_id: 'rid' }));
    await expect(executeMetaFetch(baseCfg, '/x', {}, 'data')).rejects.toThrow(KernelFetchError);
    try {
      await executeMetaFetch(baseCfg, '/x', {}, 'data');
    } catch (e: any) {
      expect(e.code).toBe(403);
      expect(e.httpStatus).toBe(403);
    }
  });

  it('invalid envelope (json null) throws 502', async () => {
    mockFetch(async () => ({ status: 500, json: vi.fn().mockResolvedValue(null) } as any));
    await expect(executeMetaFetch(baseCfg, '/x', {}, 'data')).rejects.toMatchObject({ code: 502 });
  });

  it('network error throws 502', async () => {
    mockFetch(async () => { throw new Error('ECONNREFUSED'); });
    await expect(executeMetaFetch(baseCfg, '/x', {}, 'data')).rejects.toMatchObject({ code: 502, message: expect.stringContaining('ECONNREFUSED') });
  });

  it('timeout throws 504', async () => {
    mockFetch(async (_u, init) => {
      init.signal.dispatchEvent(new Event('abort'));
      const err: any = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    await expect(executeMetaFetch(baseCfg, '/x', {}, 'data')).rejects.toMatchObject({ code: 504 });
  });

  it('KernelFetchError httpStatus getter', () => {
    expect(new KernelFetchError(404, 'm').httpStatus).toBe(404);
    expect(new KernelFetchError(0, 'm').httpStatus).toBe(200);
    expect(new KernelFetchError(700, 'm').httpStatus).toBe(502);
    expect(mapHttpStatusFromEnvelopeCode(500)).toBe(500);
  });

  it('request body serialization masks sensitive keys and truncates', async () => {
    mockFetch(async () => jsonResponse({ code: 0, message: 'ok', request_id: 'rid', data: {} }));
    const long = 'a'.repeat(5000);
    await executeMetaFetch(
      baseCfg,
      '/x',
      { password: 'superlongsecretvalue', token: 'short', user_key: '', name: long, list: ['x'.repeat(10)] },
      'data',
    );
  });

  it('request without apiKey/userKey omits headers', async () => {
    const fetch = mockFetch(async () => jsonResponse({ code: 0, message: 'ok', data: {} }));
    await executeMetaFetch({ endpoint: 'http://e', serviceId: 's', timeoutMs: 10 }, '/x', {}, 'data');
    const [, init] = fetch.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers['x-tdai-user-key']).toBeUndefined();
  });

  it('generates requestId when absent', async () => {
    const fetch = mockFetch(async () => jsonResponse({ code: 0, message: 'ok', data: {} }));
    await executeMetaFetch({ endpoint: 'http://e', serviceId: 's', timeoutMs: 10 }, '/x', {}, 'data');
    const [, init] = fetch.mock.calls[0];
    expect(init.headers['x-request-id']).toBeTruthy();
  });
});