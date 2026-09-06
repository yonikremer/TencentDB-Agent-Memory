import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildPanelApp } from '../../src/panel/http/app.js';
import { makeDeps, TEST_INSTANCE_ID, okEnv, type MockDeps } from '../helpers/mock-deps.js';
import { saveAgentTemplate } from '../../src/panel/state/agent-template-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HDRS = {
  'x-tdai-service-id': TEST_INSTANCE_ID,
  'x-tdai-user-key': 'uk-1',
  'content-type': 'application/json',
};
const HDRS_NO_USER = { 'x-tdai-service-id': TEST_INSTANCE_ID, 'content-type': 'application/json' };

async function post(app: any, path: string, body?: unknown, headers: Record<string, string> = HDRS) {
  return app.request(path, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function verifyUser(userType?: string) {
  return okEnv({ valid: true, user: { user_id: 'user-1', user_type: userType } });
}

const sleep = () => new Promise((r) => setTimeout(r, 5));

describe('/api/v1/meta/* proxy', () => {
  let deps: MockDeps;
  let app: any;
  let tplDir: string;

  beforeEach(() => {
    deps = makeDeps();
    tplDir = mkdtempSync(join(tmpdir(), 'meta-tpl-'));
    deps.config.agentTemplateDir = tplDir;
    app = buildPanelApp(deps as any);
  });
  afterEach(() => rmSync(tplDir, { recursive: true, force: true }));

  it('header validation: missing instance / invalid instance / missing user key', async () => {
    let res = await post(app, '/api/v1/meta/user/list', { team_id: 't' }, { 'content-type': 'application/json' });
    expect((await res.json()).message).toBe('MISSING_INSTANCE_ID');

    res = await post(app, '/api/v1/meta/user/list', {}, { 'x-tdai-service-id': 'nope', 'x-tdai-user-key': 'u', 'content-type': 'application/json' });
    expect((await res.json()).message).toBe('INVALID_INSTANCE');

    res = await post(app, '/api/v1/meta/user/list', {}, HDRS_NO_USER);
    expect((await res.json()).message).toBe('MISSING_USER_KEY');
  });

  it('auth/verify action skips user key requirement', async () => {
    deps.metaKernel.invoke.mockResolvedValue(verifyUser());
    const res = await post(app, '/api/v1/meta/auth/verify', { user_key: 'x' }, HDRS_NO_USER);
    expect(res.status).toBe(200);
    expect(deps.metaKernel.invoke).toHaveBeenCalledWith('auth/verify', { user_key: 'x' }, expect.objectContaining({ userKey: undefined }));
  });

  it('unknown / not-in-scope / disallowed actions', async () => {
    let res = await post(app, '/api/v1/meta', {});
    expect((await res.json()).message).toBe('UNKNOWN_META_ACTION');
    res = await post(app, '/api/v1/meta/agent-fixed-asset/list', {});
    expect((await res.json()).code).toBe(501);
    res = await post(app, '/api/v1/meta/bogus/action', {});
    expect((await res.json()).message).toBe('UNKNOWN_META_ACTION');
  });

  it('invalid json body defaults to {}', async () => {
    deps.metaKernel.invoke.mockResolvedValue(okEnv({ ok: 1 }));
    const res = await app.request('/api/v1/meta/user/get', { method: 'POST', headers: HDRS, body: 'not-json{{{' });
    expect(res.status).toBe(200);
    expect(deps.metaKernel.invoke).toHaveBeenCalledWith('user/get', {}, expect.anything());
  });

  it('duplicate check blocks user/create on matching username', async () => {
    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'user/list') return okEnv({ items: [{ username: 'alice' }] });
      return okEnv({});
    });
    let res = await post(app, '/api/v1/meta/user/create', { username: 'alice' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(409);
    // different name → passes through
    res = await post(app, '/api/v1/meta/user/create', { username: 'bob' });
    expect(res.status).toBe(200);
  });

  it('dup check pass-through when invokes without username or list errors', async () => {
    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'user/list') throw new Error('kernel down');
      return okEnv({ user_id: 'u1' });
    });
    const res = await post(app, '/api/v1/meta/user/create', { username: 'carol' });
    expect(res.status).toBe(200);
  });

  it('dup checks for team/agent/task create', async () => {
    deps.metaKernel.invoke.mockImplementation(async (action: string, body: any) => {
      if (action === 'team/list') return okEnv({ items: [{ name: body.name }] });
      if (action === 'agent/list') return okEnv({ items: [{ name: body.name }] });
      if (action === 'task/list') return okEnv({ items: [{ title: body.title }] });
      return okEnv({});
    });
    expect((await post(app, '/api/v1/meta/team/create', { name: 'T1', owner_user_id: 'u' })).status).toBe(409);
    expect((await post(app, '/api/v1/meta/agent/create', { name: 'A1', team_id: 't', owner_user_id: 'u' })).status).toBe(409);
    expect((await post(app, '/api/v1/meta/task/create', { title: 'Task', team_id: 't', creator_user_id: 'u' })).status).toBe(409);
    expect((await post(app, '/api/v1/meta/user/create-with-key', { username: 'with-key', user_key: 'k' })).status).toBe(200);
  });

  it('set-default-template requires admin; rejects invalid params; writes file', async () => {
    deps.metaKernel.invoke.mockResolvedValue(okEnv({ valid: true, user: { user_id: 'u', user_type: 'normal' } }));
    let res = await post(app, '/api/v1/meta/agent/set-default-template', { team_id: 't1', template: { name: 'x' } });
    expect(res.status).toBe(403);

    deps.metaKernel.invoke.mockResolvedValue(verifyUser('system_admin'));
    res = await post(app, '/api/v1/meta/agent/set-default-template', { team_id: 't1', template: 'nope' });
    expect((await res.json()).message).toBe('INVALID_PARAM');
    res = await post(app, '/api/v1/meta/agent/set-default-template', { team_id: '', template: { name: 'x' } });
    expect((await res.json()).message).toBe('INVALID_PARAM');

    res = await post(app, '/api/v1/meta/agent/set-default-template', { team_id: 't1', template: { name: 'tpl-x', visibility: 'team' } });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ ok: true });
  });

  it('get-default-template returns template or {}', async () => {
    saveAgentTemplate(tplDir, TEST_INSTANCE_ID, 't1', { name: 'saved' });
    deps.metaKernel.invoke.mockResolvedValue(okEnv({}));
    let res = await post(app, '/api/v1/meta/agent/get-default-template', { team_id: 't1' });
    expect((await res.json()).data).toEqual({ name: 'saved' });
    res = await post(app, '/api/v1/meta/agent/get-default-template', { team_id: 'missing' });
    expect(await res.json()).toMatchObject({ data: {} });
    res = await post(app, '/api/v1/meta/agent/get-default-template', {});
    expect(await res.json()).toMatchObject({ data: {} });
  });

  it('user/list hides knowledge-service user', async () => {
    deps.metaKernel.invoke.mockResolvedValue(okEnv({ items: [{ username: 'knowledge-service' }, { username: 'alice' }], total: 2 }));
    const res = await post(app, '/api/v1/meta/user/list', {});
    const data = (await res.json()).data;
    expect(data.items).toHaveLength(1);
    expect(data.total).toBe(1);
  });

  it('user/list with empty data object', async () => {
    deps.metaKernel.invoke.mockResolvedValue(okEnv({}));
    const res = await post(app, '/api/v1/meta/user/list', {});
    expect(res.status).toBe(200);
  });

  it('non-zero envelope passthrough and team-member/add skip on error', async () => {
    deps.metaKernel.invoke.mockResolvedValue({ code: 404, message: 'nf', request_id: 'r', data: null });
    const res = await post(app, '/api/v1/meta/team-member/add', { team_id: 't', user_id: 'u' });
    expect(res.status).toBe(404);
    expect(deps.skillKernel.invoke).not.toHaveBeenCalled();
  });

  it('team-member/add with no template imports default skills', async () => {
    deps.metaKernel.invoke.mockImplementation(async (action: string, body: any) => {
      if (action === 'team-member/add') return okEnv({});
      if (action === 'user/get') return okEnv({ username: 'bob' });
      if (action === 'agent/list') return okEnv({ items: [{ agent_id: 'agt-1', name: 'default-agent-bob' }] });
      if (action === 'team-member/get') return okEnv({});
      return okEnv({});
    });
    deps.skillKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'create') return { code: 0, message: 'ok', request_id: 'r', data: {} };
      return okEnv({});
    });
    const res = await post(app, '/api/v1/meta/team-member/add', { team_id: 't', user_id: 'u' });
    expect(res.status).toBe(200);
    await sleep();
    expect(deps.skillKernel.invoke).toHaveBeenCalled();
    expect(deps.skillKernel.invoke.mock.calls[0][0]).toBe('create');
  });

  it('team-member/add with no template: no user, no agent found, create failures', async () => {
    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'team-member/add') return okEnv({});
      if (action === 'user/get') return { code: 100, message: 'x', request_id: 'r', data: null };
      return okEnv({});
    });
    let res = await post(app, '/api/v1/meta/team-member/add', { team_id: 't', user_id: 'u' });
    expect(res.status).toBe(200);
    await sleep();

    // user ok but agents list without default → warn + skip
    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'team-member/add') return okEnv({});
      if (action === 'user/get') return okEnv({ username: 'bob' });
      if (action === 'agent/list') return okEnv({ items: [] });
      return okEnv({});
    });
    res = await post(app, '/api/v1/meta/team-member/add', { team_id: 't', user_id: 'u' });
    expect(res.status).toBe(200);
    await sleep();

    // create fails with error code
    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'team-member/add') return okEnv({});
      if (action === 'user/get') return okEnv({ username: 'bob' });
      if (action === 'agent/list') return okEnv({ items: [] });
      if (action === 'agent/create') return { code: 500, message: 'no', request_id: 'r', data: null };
      return okEnv({});
    });
    res = await post(app, '/api/v1/meta/team-member/add', { team_id: 't', user_id: 'u' });
    expect(res.status).toBe(200);
    await sleep();
  });

  it('team-member/add with no template: skill create variants (42201/error/throw)', async () => {
    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'team-member/add') return okEnv({});
      if (action === 'user/get') return okEnv({ username: 'bob' });
      if (action === 'agent/list') return okEnv({ items: [{ agent_id: 'agt-1', name: 'default-agent-bob' }] });
      return okEnv({});
    });
    const variants = [
      { code: 42201 },
      { code: 500, message: 'dup' },
    ];
    let i = 0;
    deps.skillKernel.invoke.mockImplementation(async () => {
      const v = variants[i % 2];
      i++;
      if (v.code === 500) throw new Error('network');
      return { ...v, message: 'm', request_id: 'r', data: {} };
    });
    // first default skill: 42201 ignored; second: throws → warn
    const res = await post(app, '/api/v1/meta/team-member/add', { team_id: 't', user_id: 'u' });
    expect(res.status).toBe(200);
    await sleep();
  });

  it('team-member/add with template clones assets', async () => {
    saveAgentTemplate(tplDir, TEST_INSTANCE_ID, 't1', {
      name: 'tpl',
      description: 'd',
      prompt: 'p',
      visibility: 'team',
      metadata_json: '{}',
      asset_ids: { skills: ['skl-1', 'skl-2'], code_graphs: ['cg-1'], wikis: ['wiki-1'] },
    });
    let agentInvokes = 0;
    deps.metaKernel.invoke.mockImplementation(async (action: string, body: any) => {
      if (action === 'team-member/add') return okEnv({});
      if (action === 'user/get') return okEnv({ username: 'bob' });
      if (action === 'agent/list') return okEnv({ items: [{ agent_id: 'agt-new', name: 'tpl' }] });
      if (action === 'auth/verify') return verifyUser();
      if (action === 'agent-fixed-asset/list') return okEnv({ items: [] });
      if (action === 'agent-fixed-asset/set') return okEnv({});
      agentInvokes++;
      return okEnv({});
    });
    let calls = 0;
    deps.skillKernel.invoke.mockImplementation(async (action: string) => {
      calls++;
      if (action === 'get') return okEnv({ name: 'src-skill', content: 'c', manifest: [{ path: 'a.md', is_executable: true }] });
      if (action === 'files/read') return okEnv({ path: 'a.md', content: 'x', encoding: 'utf8', mime_type: 'md' });
      if (action === 'create') return okEnv({});
      return okEnv({});
    });
    const res = await post(app, '/api/v1/meta/team-member/add', { team_id: 't1', user_id: 'u1' });
    expect(res.status).toBe(200);
    await sleep();
    expect(skillKernelCalls(calls)).toBeGreaterThanOrEqual(6);
  });

  it('team-member/add with template: failure paths in fork/allocate', async () => {
    saveAgentTemplate(tplDir, TEST_INSTANCE_ID, 't2', {
      name: 'tpl2',
      asset_ids: { skills: ['skl-fail'], code_graphs: ['cg-fail'], wikis: ['wiki-fail'] },
    });
    let listCalls = 0;
    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'team-member/add') return okEnv({});
      if (action === 'user/get') return okEnv({ username: 'bob' });
      if (action === 'agent/list') return okEnv({ items: [{ agent_id: 'agt-x', name: 'tpl2' }] });
      if (action === 'auth/verify') return verifyUser();
      if (action === 'agent-fixed-asset/list') {
        listCalls++;
        if (listCalls === 1) return okEnv({ items: [{ asset_id: 'cg-fail', asset_type: 'code_graph' }] }); // already bound → skip
        return { code: 500, message: 'list fail', request_id: 'r', data: null }; // list error → return
      }
      if (action === 'agent-fixed-asset/set') return { code: 500, message: 'set fail', request_id: 'r', data: null };
      return okEnv({});
    });
    deps.skillKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'get') return { code: 404, message: 'no', request_id: 'r', data: null }; // get fails → throw
      if (action === 'files/read') throw new Error('read fail');
      if (action === 'create') return okEnv({});
      return okEnv({});
    });
    const res = await post(app, '/api/v1/meta/team-member/add', { team_id: 't2', user_id: 'u2' });
    expect(res.status).toBe(200);
    await sleep();
  });

  it('team-member/add create agent path with template', async () => {
    saveAgentTemplate(tplDir, TEST_INSTANCE_ID, 't3', { name: 'tpl3', asset_ids: {} });
    deps.metaKernel.invoke.mockImplementation(async (action: string) => {
      if (action === 'team-member/add') return okEnv({});
      if (action === 'user/get') return okEnv({});
      if (action === 'agent/list') return okEnv({ items: [] });
      if (action === 'agent/create') return okEnv({ agent_id: 'agt-created' });
      return okEnv({});
    });
    const res = await post(app, '/api/v1/meta/team-member/add', { team_id: 't3', user_id: 'u3' });
    expect(res.status).toBe(200);
    await sleep();
  });

  function skillKernelCalls(n: number) {
    return n;
  }
});