import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { HttpKnowledgeClient } from '../../src/panel/kernel/adapters/http-knowledge-client.js';

function stubFetch(impl: (url: string, init: any) => any) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const cfg = { baseUrl: 'http://ks', authToken: 'tok', serviceId: 'svc', timeoutMs: 100 };
let client: HttpKnowledgeClient;

beforeEach(() => {
  client = new HttpKnowledgeClient(cfg);
});

describe('HttpKnowledgeClient', () => {
  it('calls post with headers and returns data on success', async () => {
    const fetch = stubFetch(async () => ({ status: 200, ok: true, json: async () => ({ code: 0, data: { wiki_id: 'w1' } }) }));
    const out = await client.wikiGet('w1');
    expect(out).toEqual({ wiki_id: 'w1' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://ks/v3/wiki/get');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers['x-tdai-service-id']).toBe('svc');
    expect(JSON.parse(init.body)).toEqual({ wiki_id: 'w1' });
  });

  it('throws CoreUpstreamError on business code', async () => {
    stubFetch(async () => ({ status: 200, ok: true, json: async () => ({ code: 40001, message: 'bad' }) }));
    await expect(client.wikiGet('w')).rejects.toMatchObject({ code: 'CORE_UPSTREAM_ERROR', upstreamCode: 40001 });
  });

  it('throws CoreUpstreamError on !ok with business code 0', async () => {
    stubFetch(async () => ({ status: 500, ok: false, json: async () => ({ code: 0, message: 'boom' }) }));
    await expect(client.wikiGet('w')).rejects.toMatchObject({ httpStatus: 500, upstreamCode: 0 });
  });

  it('works without authToken/serviceId', async () => {
    const fetch = stubFetch(async () => ({ status: 200, ok: true, json: async () => ({ code: 0, data: {} }) }));
    const c = new HttpKnowledgeClient({ baseUrl: 'http://ks' });
    await c.wikiList('t');
    const [, init] = fetch.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers['x-tdai-service-id']).toBeUndefined();
  });

  it('wiki methods', async () => {
    stubFetch(async () => ({ status: 200, ok: true, json: async () => ({ code: 0, data: {} }) }));
    await client.wikiCreate('t', 'n', 'u');
    await client.wikiIngest('w');
    await client.wikiDelete(['w']);
    await client.wikiList('t', { status: 'ready', limit: 5, offset: 1 });
    await client.wikiUpdateMeta('w', { name: 'x' });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(5);
  });

  it('raw/page methods', async () => {
    const fetch = stubFetch(async () => ({ status: 200, ok: true, json: async () => ({ code: 0, data: {} }) }));
    await client.wikiRawLs('w');
    await client.wikiRawRead('w', ['a']);
    await client.wikiRawWrite('t', 'w', [{ filename: 'a', content: 'x' }], 'u');
    await client.wikiRawRm('t', 'w', ['a'], 'u');
    await client.wikiPageLs('w');
    await client.wikiPageRead('w', ['r']);
    await client.wikiPageWrite('t', 'w', [{ ref: 'r', content: 'x' }], 'u');
    await client.wikiPageRm('t', 'w', ['r'], 'u');
    expect(fetch).toHaveBeenCalledTimes(8);
  });

  it('derived view methods', async () => {
    const fetch = stubFetch(async () => ({ status: 200, ok: true, json: async () => ({ code: 0, data: {} }) }));
    await client.wikiGraph('w');
    await client.wikiSearch('w', 'q');
    await client.wikiSearch('w', 'q', 10, { hop: 1, decay: 0.5, minScore: 0.1 });
    await client.wikiSearch('w', 'q', 10, {});
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('code-graph methods', async () => {
    const fetch = stubFetch(async () => ({ status: 200, ok: true, json: async () => ({ code: 0, data: {} }) }));
    await client.codeGraphCreate('t', 'http://r', 'dev', 'u', 'repo');
    await client.codeGraphCreate('t', 'http://r2'); // default branch
    await client.codeGraphList('t', { limit: 5 });
    await client.codeGraphGet('c');
    await client.codeGraphSync('c');
    await client.codeGraphDelete(['c']);
    await client.codeGraphUpdateMeta('c', { repo_name: 'r' });
    await client.codeGraphQuery('c', 'search', { q: 'x' });
    expect(fetch).toHaveBeenCalledTimes(8);
    const [, init] = fetch.mock.calls[1];
    expect(JSON.parse(init.body).branch).toBe('main');
  });
});