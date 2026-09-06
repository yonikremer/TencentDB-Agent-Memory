/**
 * guide-team-flow.test.ts — guide sections 2.3 + 2.4 as executable contract.
 *
 * Mirrors docs/research-team-setup.md step for step against the real
 * handleV3MetaRoute + MetadataService (SQLite temp): team -> members ->
 * agents -> task (TITLE not name) -> task-agent/link -> wiki asset
 * (visibility team) -> agent-fixed-asset/set -> list shows the bind.
 * Panel-level /allocate is the same bind through the panel proxy.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteMetadataStore } from "../src/metadata/store/sqlite-adapter.js";
import { MetadataService } from "../src/metadata/service/metadata-service.js";
import { handleV3MetaRoute } from "../src/metadata/router/v3-meta-router.js";

const INST = "test-guide-1";
const ADMIN_KEY = "adm-key-guide-1";
let base = "";
let server: http.Server;
let tmp = "";
let adminId = "";

function post(path: string, body: unknown = {}, key: string | null = ADMIN_KEY) {
  return (async () => {
    const h: Record<string, string> = { "content-type": "application/json", "x-tdai-service-id": INST };
    if (key) h["x-tdai-user-key"] = key;
    const res = await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as { code: number; message: string; data: any } };
  })();
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "core-guide-"));
  const store = new SqliteMetadataStore(join(tmp, "meta.db"));
  (globalThis as any).__metaStore = store;
  store.init();
  const svc = new MetadataService(store, INST, { debug: () => {} });
  const admin = await svc.initAdminUser({ username: "root", user_key: ADMIN_KEY });
  adminId = admin.user_id;
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const sendJson = (r: http.ServerResponse, status: number, body: unknown) => {
      r.writeHead(status, { "content-type": "application/json" });
      r.end(JSON.stringify(body));
    };
    const parseJsonBody = async <T>(rq: http.IncomingMessage): Promise<T> =>
      new Promise((resolve, reject) => {
        let raw = "";
        rq.on("data", (c) => { raw += c; });
        rq.on("end", () => {
          try { resolve(raw ? (JSON.parse(raw) as T) : ({} as T)); }
          catch (e) { reject(e); }
        });
      });
    await handleV3MetaRoute(req, res, u.pathname, req.method ?? "", parseJsonBody, sendJson, {
      getMetadataService: (id) => (id === INST ? svc : undefined),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  base = "http://127.0.0.1:" + (typeof addr === "object" && addr ? addr.port : 0);
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  try { (globalThis as any).__metaStore?.close(); } catch { /* ignore */ }
  rmSync(tmp, { recursive: true, force: true });
});

describe("guide 2.3: team + members + agents + task", () => {
  let teamId = "";
  let agentShared = "";
  let agentPrivate = "";
  let taskId = "";

  it("team/create with owner_user_id", async () => {
    const r = await post("/v3/meta/team/create", { name: "research", owner_user_id: adminId });
    expect(r.json.code).toBe(0);
    teamId = r.json.data.team_id;
  });

  it("team-member/add second user as member", async () => {
    const u = await post("/v3/meta/user/create", { username: "alice" });
    expect(u.json.code).toBe(0);
    const m = await post("/v3/meta/team-member/add", { team_id: teamId, user_id: u.json.data.user_id, role: "member" });
    expect(m.json.code).toBe(0);
  });

  it("agent/create shared + private", async () => {
    const s = await post("/v3/meta/agent/create", { team_id: teamId, owner_user_id: adminId, name: "shared" });
    const p = await post("/v3/meta/agent/create", { team_id: teamId, owner_user_id: adminId, name: "private-alice" });
    expect(s.json.code).toBe(0);
    expect(p.json.code).toBe(0);
    agentShared = s.json.data.agent_id;
    agentPrivate = p.json.data.agent_id;
  });

  it("task/create uses title; old name+user_ids body fails", async () => {
    const bad = await post("/v3/meta/task/create", { team_id: teamId, creator_user_id: adminId, name: "project-x", user_ids: [] });
    expect(bad.json.code).not.toBe(0);
    const good = await post("/v3/meta/task/create", { team_id: teamId, creator_user_id: adminId, title: "project-x" });
    expect(good.json.code).toBe(0);
    taskId = good.json.data.task_id;
    const link = await post("/v3/meta/task-agent/link", { task_id: taskId, agent_id: agentShared });
    expect(link.json.code).toBe(0);
    const list = await post("/v3/meta/task-agent/list", { task_id: taskId });
    expect(JSON.stringify(list.json.data)).toContain(agentShared);
  });

  it("guide 2.4: wiki asset (team) + fixed bind visible on agent", async () => {
    const wikiId = "wiki-guide00";
    const a = await post("/v3/meta/asset/create", {
      asset_id: wikiId, team_id: teamId, asset_type: "llm_wiki", name: "research-shared",
      owner_user_id: adminId, source_type: "uploaded", visibility: "team",
    });
    expect(a.json.code).toBe(0);
    const set = await post("/v3/meta/agent-fixed-asset/set", {
      agent_id: agentShared,
      bindings: [{ asset_id: wikiId, asset_type: "llm_wiki", created_by: adminId }],
    });
    expect(set.status).toBe(200);
    const list = await post("/v3/meta/agent-fixed-asset/list", { agent_id: agentPrivate });
    expect(list.json.code).toBe(0);
    const bound = await post("/v3/meta/agent-fixed-asset/list", { agent_id: agentShared });
    expect(JSON.stringify(bound.json.data)).toContain(wikiId);
  });
});
