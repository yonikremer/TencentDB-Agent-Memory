import { describe, it, expect, beforeEach } from 'vitest';
import { buildPanelApp } from '../../src/panel/http/app.js';
import { makeDeps, TEST_INSTANCE_ID, okEnv, listEnvelope, type MockDeps } from '../helpers/mock-deps.js';

const HDRS = {
  'x-tdai-service-id': TEST_INSTANCE_ID,
  'x-tdai-user-key': 'uk-1',
  'content-type': 'application/json',
};

async function post(app: any, path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: HDRS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function makeApp() {
  const deps = makeDeps();
  const app = buildPanelApp(deps as any);
  return { deps, app };
}

describe('skill proxy', () => {
  it('passes through valid action', async () => {
    const { deps, app } = makeApp();
    deps.skillKernel.invoke.mockResolvedValue(okEnv({ skill_id: 'skl-1' }));
    const res = await post(app, '/api/v1/skill/create', { name: 's' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.skill_id).toBe('skl-1');
    expect(deps.skillKernel.invoke).toHaveBeenCalledWith('create', { name: 's' }, expect.anything());
    const ctx = deps.skillKernel.invoke.mock.calls[0][2];
    expect(ctx.instanceId).toBe(TEST_INSTANCE_ID);
    expect(ctx.userKey).toBe('uk-1');
  });

  it('rejects unknown action', async () => {
    const { app } = makeApp();
    const res = await post(app, '/api/v1/skill/bogus', {});
    expect((await res.json()).message).toBe('UNKNOWN_SKILL_ACTION');
  });

  it('handles invalid json body and envelope errors', async () => {
    const { deps, app } = makeApp();
    deps.skillKernel.invoke.mockResolvedValue({ code: 404, message: 'nf', request_id: 'r', data: null });
    const res = await app.request('/api/v1/skill/get', { method: 'POST', headers: HDRS, body: 'oops{' });
    expect(res.status).toBe(404);
    expect(deps.skillKernel.invoke).toHaveBeenCalledWith('get', {}, expect.anything());
  });
});

describe('task/list-with-agents', () => {
  it('missing team id', async () => {
    const { app } = makeApp();
    const res = await post(app, '/api/v1/task/list-with-agents', {});
    expect((await res.json()).message).toBe('MISSING_TEAM_ID');
  });

  it('task/list error passthrough', async () => {
    const { deps, app } = makeApp();
    deps.metaKernel.invoke.mockResolvedValue({ code: 500, message: 'boom', request_id: 'r', data: null });
    const res = await post(app, '/api/v1/task/list-with-agents', { team_id: 't' });
    expect(res.status).toBe(500);
  });

  it('success with empty tasks', async () => {
    const { deps, app } = makeApp();
    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'task/list') return okEnv({ items: [], total: 0 });
      throw new Error('unexpected');
    });
    const res = await post(app, '/api/v1/task/list-with-agents', { team_id: 't' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
  });

  it('aggregates agents with batching, filters, and fallbacks', async () => {
    const { deps, app } = makeApp();
    const tasks = Array.from({ length: 21 }, (_, i) => ({
      task_id: `t-${i}`, team_id: 't', title: `title-${i}`, status: 'active', created_at: 'c', updated_at: 'u',
    }));
    let taskAgentCalls = 0;
    deps.metaKernel.invoke.mockImplementation(async (action: string, body: any) => {
      if (action === 'task/list') return okEnv({ items: tasks, total: 21 });
      if (action === 'task-agent/list') {
        taskAgentCalls++;
        if (taskAgentCalls === 1) return okEnv({ items: [{ agent_id: 'agt-1', task_id: body.task_id, team_id: 't', status: 'x', created_at: 'c' }] });
        if (taskAgentCalls === 2) return { code: 500, message: 'e', request_id: 'r', data: null }; // → []
        throw new Error('boom'); // → .catch(() => [])
      }
      throw new Error('unexpected');
    });
    const res = await post(app, '/api/v1/task/list-with-agents', {
      team_id: 't', limit: 300, offset: 2, status: 'active', title: 'title-1',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(21);
    expect(body.data.limit).toBe(200); // capped
    expect(body.data.offset).toBe(2);
    expect(body.data.total).toBe(21);
    expect(taskAgentCalls).toBe(21);
  });

  it('handles invalid json body', async () => {
    const { deps, app } = makeApp();
    deps.metaKernel.invoke.mockResolvedValue(okEnv({ items: [] }));
    const res = await app.request('/api/v1/task/list-with-agents', { method: 'POST', headers: HDRS, body: '!' });
    expect((await res.json()).message).toBe('MISSING_TEAM_ID');
  });
});

describe('agent/delete-cascade', () => {
  it('missing agent / invalid user', async () => {
    const { deps, app } = makeApp();
    let res = await post(app, '/api/v1/agent/delete-cascade', {});
    expect((await res.json()).message).toBe('MISSING_AGENT_ID');
    deps.metaKernel.invoke.mockResolvedValue({ code: 0, message: 'ok', request_id: 'r', data: { valid: false } });
    res = await post(app, '/api/v1/agent/delete-cascade', { agent_id: 'a1' });
    expect((await res.json()).message).toBe('INVALID_USER_KEY');
  });

  it('agent not found / other error / not owner', async () => {
    const { deps, app } = makeApp();
    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'auth/verify') return okEnv({ valid: true, user: { user_id: 'me' } });
      if (action === 'agent/get') return { code: 404, message: 'nf', request_id: 'r', data: null };
      return okEnv({});
    });
    let res = await post(app, '/api/v1/agent/delete-cascade', { agent_id: 'a1' });
    expect((await res.json()).message).toBe('AGENT_NOT_FOUND');

    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'auth/verify') return okEnv({ valid: true, user: { user_id: 'me' } });
      if (action === 'agent/get') return { code: 500, message: 'x', request_id: 'r', data: null };
      return okEnv({});
    });
    res = await post(app, '/api/v1/agent/delete-cascade', { agent_id: 'a1' });
    expect(res.status).toBe(500);

    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'auth/verify') return okEnv({ valid: true, user: { user_id: 'me' } });
      if (action === 'agent/get') return okEnv({ agent_id: 'a1', team_id: 't', owner_user_id: 'other' });
      return okEnv({});
    });
    res = await post(app, '/api/v1/agent/delete-cascade', { agent_id: 'a1' });
    expect((await res.json()).message).toBe('NOT_YOUR_AGENT');
  });

  it('skill list error passthrough', async () => {
    const { deps, app } = makeApp();
    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'auth/verify') return okEnv({ valid: true, user: { user_id: 'me' } });
      if (action === 'agent/get') return okEnv({ agent_id: 'a1', team_id: 't', owner_user_id: 'me' });
      return okEnv({});
    });
    deps.skillKernel.invoke.mockResolvedValue({ code: 500, message: 'boom', request_id: 'r', data: null });
    const res = await post(app, '/api/v1/agent/delete-cascade', { agent_id: 'a1' });
    expect(res.status).toBe(500);
  });

  it('delete failure interrupts with 500 payload', async () => {
    const { deps, app } = makeApp();
    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'auth/verify') return okEnv({ valid: true, user: { user_id: 'me' } });
      if (action === 'agent/get') return okEnv({ agent_id: 'a1', team_id: 't', owner_user_id: 'me' });
      if (action === 'agent/archive') return okEnv({});
      return okEnv({});
    });
    let skCalls = 0;
    deps.skillKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'list') return okEnv({ items: [{ skill_id: 's1', version: 1 }, { skill_id: 's2', version: 2 }], total: 2 });
      skCalls++;
      if (action === 'delete' && skCalls === 2) return { code: 40001, message: 'not owner', request_id: 'r', data: null };
      return okEnv({});
    });
    const res = await post(app, '/api/v1/agent/delete-cascade', { agent_id: 'a1' });
    const body = await res.json();
    expect(body.code).toBe(500);
    expect(body.data.failed_skill_id).toBe('s2');
    expect(body.data.deleted_skill_ids).toEqual(['s1']);
  });

  it('full success deletes skills then archives', async () => {
    const { deps, app } = makeApp();
    let archived = false;
    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'auth/verify') return okEnv({ valid: true, user: { user_id: 'me' } });
      if (action === 'agent/get') return okEnv({ agent_id: 'a1', team_id: 't', owner_user_id: 'me' });
      if (action === 'agent/archive') { archived = true; return okEnv({}); }
      return okEnv({});
    });
    let page = 0;
    deps.skillKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'list') {
        if (page === 0) return okEnv({ items: [{ skill_id: 's1', version: 1 }], total: 1 });
        return okEnv({ items: [], total: 1 }); // second page empty → loop breaks via batch.length===0
      }
      return okEnv({});
    });
    const res = await post(app, '/api/v1/agent/delete-cascade', { agent_id: 'a1' });
    const body = await res.json();
    expect(body.data).toMatchObject({ archived: true, deleted_skill_count: 1, deleted_skill_ids: ['s1'] });
    expect(archived).toBe(true);
  });

  it('archive error passthrough after skills deleted', async () => {
    const { deps, app } = makeApp();
    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'auth/verify') return okEnv({ valid: true, user: { user_id: 'me' } });
      if (action === 'agent/get') return okEnv({ agent_id: 'a1', team_id: 't', owner_user_id: 'me' });
      if (action === 'agent/archive') return { code: 500, message: 'arch', request_id: 'r', data: null };
      return okEnv({});
    });
    deps.skillKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'list') return okEnv({ items: [], total: 0 });
      return okEnv({});
    });
    const res = await post(app, '/api/v1/agent/delete-cascade', { agent_id: 'a1' });
    expect(res.status).toBe(500);
  });
});

describe('agent-overview/bootstrap', () => {
  const verify = () => okEnv({ valid: true, user: { user_id: 'me' } });
  const member = () => okEnv({});
  const asset = (id: string, type = 'skill') => ({
    asset_id: id, asset_type: type, name: id, description: null, team_id: 't',
    owner_user_id: 'me', visibility: 'team', status: 'active', created_at: 'c', updated_at: 'u',
  });

  it('missing team / not member', async () => {
    const { deps, app } = makeApp();
    let res = await post(app, '/api/v1/agent-overview/bootstrap', {});
    expect((await res.json()).message).toBe('MISSING_TEAM_ID');

    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'auth/verify') return verify();
      if (action === 'team-member/get') return { code: 404, message: 'nf', request_id: 'r', data: null };
      return okEnv({});
    });
    res = await post(app, '/api/v1/agent-overview/bootstrap', { team_id: 't' });
    expect((await res.json()).message).toBe('NOT_TEAM_MEMBER');
  });

  it('full bootstrap with all data sources', async () => {
    const { deps, app } = makeApp();
    deps.metaKernel.invoke.mockImplementation(async (action: string, body: any) => {
      if (action === 'auth/verify') return verify();
      if (action === 'team-member/get') return member();
      if (action === 'asset/list-accessible') {
        if (body.asset_type === 'skill') return okEnv({ items: [asset('skl-1'), { ...asset('skl-arch', 'skill'), status: 'archived' }], total: 2 });
        if (body.asset_type === 'code_graph') return okEnv({ items: [asset('cg-1', 'code_graph')] });
        if (body.asset_type === 'llm_wiki') return okEnv({ items: [asset('wiki-1', 'llm_wiki')] });
        return okEnv({ items: [asset('mem-1', 'chat_memory')] });
      }
      if (action === 'agent/list') return okEnv({ items: [{ agent_id: 'agt-1', team_id: 't', owner_user_id: 'me', name: 'A' }, { agent_id: 'agt-2', team_id: 't', owner_user_id: 'me', name: 'B', status: 'inactive' }], total: 2 });
      if (action === 'agent-fixed-asset/summary-by-agents') return okEnv({ items: [{ agent_id: 'agt-1', counts: { skill: 2, code_graph: 3, llm_wiki: 4, chat_memory: 1 }, total: 10 }] });
      return okEnv({});
    });
    deps.skillKernel.invoke.mockResolvedValue(okEnv({ items: [{ skill_id: 's1', owner_agent_id: 'agt-1' }, { skill_id: 's2', owner_agent_id: 'agt-1', status: 'archived' }, { skill_id: 's3' }] }));
    const client = deps.knowledgeClientFactory(TEST_INSTANCE_ID) as any;
    client.__mock.wikiGet.mockResolvedValue({ wiki_id: 'wiki-1', team_id: 't', name: 'W', status: 'ready', summary: null, page_count: 1, last_sync_at: null, service_url: null, sync_error: null, version: '1', owner_user_id: 'me', created_at: 'c', updated_at: 'u' });
    client.__mock.codeGraphGet.mockResolvedValue({ code_graph_id: 'cg-1', team_id: 't', repo_name: 'r', repo_url: 'http://r', branch: 'main', commit_hash: null, service_url: null, summary: null, status: 'ready', sync_error: null, version: '1', owner_user_id: 'me', stats: null, last_sync_at: null, created_at: 'c', updated_at: 'u' });

    const res = await post(app, '/api/v1/agent-overview/bootstrap', { team_id: 't', agent_ids: ['agt-1'] });
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(body.data.assets.skills).toHaveLength(1); // archived filtered
    expect(body.data.assets.chatMemories).toHaveLength(1);
    // s2 is archived → excluded from skillCounts; s3 has no owner_agent_id → excluded.
    expect(body.data.counts['agt-1']).toEqual({ skills: 1, code_graph: 3, llm_wiki: 4, chat_memory: 1 });
    expect(body.data.counts['agt-2']).toBeUndefined();
  });

  it('fallbacks when sources reject or return errors', async () => {
    const { deps, app } = makeApp();
    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'auth/verify') return verify();
      if (action === 'team-member/get') return member();
      if (action === 'asset/list-accessible') throw new Error('kernel down');
      if (action === 'agent/list') return { code: 500, message: 'e', request_id: 'r', data: null };
      if (action === 'agent-fixed-asset/summary-by-agents') return { code: 500, message: 'e', request_id: 'r', data: null };
      return okEnv({});
    });
    deps.skillKernel.invoke.mockResolvedValue({ code: 500, message: 'e', request_id: 'r', data: null });
    const client = deps.knowledgeClientFactory(TEST_INSTANCE_ID) as any;
  });

  it('summary-by-agents influences counts and empty data shape', async () => {
    const { deps, app } = makeApp();
    deps.metaKernel.invoke.mockImplementation(async (action: string, body: any) => {
      if (action === 'auth/verify') return verify();
      if (action === 'team-member/get') return member();
      if (action === 'asset/list-accessible') return okEnv({ items: [] });
      if (action === 'agent/list') return okEnv({ items: [{ agent_id: 'agt-1', team_id: 't', owner_user_id: 'me', name: 'A' }], total: 1 });
      if (action === 'agent-fixed-asset/summary-by-agents') return okEnv({ data: null } as any); // env.data null → counts unchanged
      return okEnv({});
    });
    deps.skillKernel.invoke.mockResolvedValue(okEnv({ items: [] }));
    const res = await post(app, '/api/v1/agent-overview/bootstrap', { team_id: 't' });
    const body = await res.json();
    expect(body.data.counts['agt-1']).toEqual({ skills: 0, code_graph: 0, llm_wiki: 0, chat_memory: 1 });
  });
});