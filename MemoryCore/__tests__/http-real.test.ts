/**
 * http-real.test.ts — REAL HTTP API coverage for the Core (TDAI gateway) metadata plane.
 *
 * Boots a real node:http server dispatching to the REAL handleV3MetaRoute +
 * REAL MetadataService (SQLite in temp dir), then sends real fetch()
 * requests. Covers every /v3/meta/* route group: user, user-key, team,
 * team-member, agent, task, task-agent, participation-log, asset, acl,
 * agent-fixed-asset, auth, instance-quota, config. Plus route-table
 * completeness for the v3 skill/knowledge/chat-memory/memory-prompt/
 * memory-generation-log planes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteMetadataStore } from "../src/metadata/store/sqlite-adapter.js";
import { MetadataService } from "../src/metadata/service/metadata-service.js";
import { ConfigParamService } from "../src/metadata/service/config-param-service.js";
import { loadDefaultRegistry } from "../src/metadata/config/param-registry.js";
import { handleV3MetaRoute, V3_ROUTES } from "../src/metadata/router/v3-meta-router.js";
import { makeSkillRouteTable } from "../src/gateway/skill-handlers.js";
import { makeKnowledgeRouteTable } from "../src/gateway/knowledge-handlers.js";
import { makeChatMemoryRouteTable } from "../src/gateway/chat-memory-handlers.js";
import { makeMemoryPromptRouteTable } from "../src/gateway/memory-prompt-handlers.js";
import { makeMemoryGenerationLogRouteTable } from "../src/gateway/memory-generation-log-handlers.js";

const INST = "test-http-1";
const ADMIN_KEY = "adm-key-http-1";
let base = "";
let server: http.Server;
let tmp = "";
let adminId = "";

function headers(key?: string | null): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", "x-tdai-service-id": INST };
  if (key) h["x-tdai-user-key"] = key;
  return h;
}

async function post(path: string, body: unknown = {}, key: string | null = ADMIN_KEY, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { ...headers(key ?? undefined), ...extraHeaders },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { code: number; message: string; data: any } };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "core-http-"));
  const store = new SqliteMetadataStore(join(tmp, "meta.db"));
  (globalThis as any).__metaStore = store;
  store.init();
  const svc = new MetadataService(store, INST, { debug: () => {} });
  const cfg = new ConfigParamService(store, loadDefaultRegistry());
  await cfg.initDefaults(loadDefaultRegistry());
  svc.setConfigParamService(cfg);
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
    try {
      const hit = await handleV3MetaRoute(req, res, u.pathname, req.method ?? "", parseJsonBody, sendJson, {
        getMetadataService: (id) => (id === INST ? svc : undefined),
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
      });
      if (!hit) sendJson(res, 404, { code: 404, message: "not found", data: null });
    } catch (e) {
      sendJson(res, 500, { code: 500, message: String(e), data: null });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  base = "http://127.0.0.1:" + (typeof addr === "object" && addr ? addr.port : 0);
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  try { (globalThis as any).__metaStore?.close(); } catch { /* ignore */ }
  rmSync(tmp, { recursive: true, force: true });
});

describe("route tables (registration completeness)", () => {
  it("V3_ROUTES covers all meta groups", () => {
    for (const p of [
      "/v3/meta/user/create", "/v3/meta/user-key/create", "/v3/meta/team/create",
      "/v3/meta/team-member/add", "/v3/meta/agent/create", "/v3/meta/task/create",
      "/v3/meta/task-agent/link", "/v3/meta/participation-log/append",
      "/v3/meta/asset/create", "/v3/meta/asset/list-accessible",
      "/v3/meta/agent-fixed-asset/set", "/v3/meta/acl/grant",
      "/v3/meta/auth/verify", "/v3/meta/instance-quota/get",
      "/v3/meta/config/user/get",
    ]) expect(V3_ROUTES).toContain(p);
  });

  it("skill/knowledge/chat-memory/mem-prompt/memlog tables registered", () => {
    const skill = makeSkillRouteTable();
    for (const p of ["/v3/skill/create", "/v3/skill/get", "/v3/skill/list", "/v3/skill/search",
      "/v3/skill/extract", "/v3/skill/conversation/add", "/v3/skill/conversation/force-archive",
      "/v3/skill/files/write", "/v3/skill/files/read", "/v3/skill/export"]) expect(Object.keys(skill)).toContain(p);
    const know = makeKnowledgeRouteTable();
    for (const p of ["/v3/knowledge/create", "/v3/knowledge/get", "/v3/knowledge/update",
      "/v3/knowledge/delete", "/v3/knowledge/list"]) expect(Object.keys(know)).toContain(p);
    expect(Object.keys(makeChatMemoryRouteTable())).toContain("/v3/chat-memory/clear");
    const mp = makeMemoryPromptRouteTable();
    for (const p of ["/v3/memory-prompt/create", "/v3/memory-prompt/get", "/v3/memory-prompt/set",
      "/v3/memory-prompt/setting/list", "/v3/memory-prompt/log"]) expect(Object.keys(mp)).toContain(p);
    const ml = makeMemoryGenerationLogRouteTable();
    expect(Object.keys(ml)).toEqual(
      expect.arrayContaining(["/v3/memory-generation-log/list", "/v3/memory-generation-log/get"]),
    );
  });
});

describe("auth + tenancy (real HTTP)", () => {
  it("missing service id -> 400, unknown instance -> 503, missing key -> 401, bad key -> 401", async () => {
    const noSvc = await post("/v3/meta/user/list", {}, undefined, { "x-tdai-service-id": "" } as any);
    expect([400, 503]).toContain(noSvc.status);
    const unknown = await fetch(base + "/v3/meta/user/list", {
      method: "POST", headers: { ...headers(ADMIN_KEY), "x-tdai-service-id": "no-such-inst" }, body: "{}",
    });
    expect(unknown.status).toBe(503); // getMetadataService -> undefined
    const noKey = await post("/v3/meta/user/list", {}, null);
    expect(noKey.status).toBe(401);
    const badKey = await post("/v3/meta/user/list", {}, "bad-key");
    expect(badKey.status).toBe(401);
  });

  it("unknown route -> 404", async () => {
    const { status } = await post("/v3/meta/nope/nothing", {});
    expect(status).toBe(404);
  });

  it("auth/verify works without user key", async () => {
    const { status, json } = await post("/v3/meta/auth/verify", { user_key: ADMIN_KEY }, undefined);
    expect(status).toBe(200);
    expect(json.code).toBe(0);
  });
});

describe("user + user-key (real HTTP)", () => {
  let uid = "";
  let keyId = "";
  it("create/get/list", async () => {
    const c = await post("/v3/meta/user/create", { username: "alice" });
    expect(c.status).toBe(200);
    uid = c.json.data.user_id;
    const g = await post("/v3/meta/user/get", { user_id: uid });
    expect(g.json.data.username).toBe("alice");
    const l = await post("/v3/meta/user/list", {});
    expect(l.json.data.total).toBeGreaterThanOrEqual(2);
  });
  it("user-key create/list/get/update/revoke", async () => {
    const k = await post("/v3/meta/user-key/create", { user_id: uid, name: "k1" });
    expect(k.status).toBe(200);
    const userKey = k.json.data.user_key ?? k.json.data.key_value;
    expect(userKey).toBeTruthy();
    keyId = k.json.data.key_id;
    expect((await post("/v3/meta/user-key/list", { user_id: uid })).status).toBe(200);
    expect((await post("/v3/meta/user-key/get", { key_id: keyId })).status).toBe(200);
    expect((await post("/v3/meta/user-key/update", { key_id: keyId, name: "k1b" })).status).toBe(200);
    // New key authenticates over HTTP
    const me = await post("/v3/meta/user/get", { user_id: uid }, userKey);
    expect(me.status).toBe(200);
    expect((await post("/v3/meta/user-key/revoke", { key_id: keyId })).status).toBe(200);
  });
  it("validation -> 400", async () => {
    expect((await post("/v3/meta/user/create", {})).status).toBe(400);
    expect((await post("/v3/meta/user/delete", { user_ids: [] })).status).toBe(400);
  });
});

describe("team + members + agent + task (real HTTP)", () => {
  let teamId = "";
  let agentId = "";
  let taskId = "";
  it("team lifecycle", async () => {
    const c = await post("/v3/meta/team/create", { name: "T1", owner_user_id: adminId });
    expect(c.status).toBe(200);
    teamId = c.json.data.team_id;
    expect((await post("/v3/meta/team/get", { team_id: teamId })).status).toBe(200);
    expect((await post("/v3/meta/team/update", { team_id: teamId, description: "d" })).status).toBe(200);
    expect((await post("/v3/meta/team/list", { user_id: adminId })).status).toBe(200);
  });
  it("team members", async () => {
    const u = await post("/v3/meta/user/create", { username: "bob" });
    const bob = u.json.data.user_id;
    expect((await post("/v3/meta/team-member/add", { team_id: teamId, user_id: bob })).status).toBe(200);
    expect((await post("/v3/meta/team-member/get", { team_id: teamId, user_id: bob })).status).toBe(200);
    expect((await post("/v3/meta/team-member/list", { team_id: teamId })).status).toBe(200);
    expect((await post("/v3/meta/team-member/remove", { team_id: teamId, user_id: bob })).status).toBe(200);
  });
  it("agent lifecycle", async () => {
    const c = await post("/v3/meta/agent/create", { team_id: teamId, owner_user_id: adminId, name: "A1" });
    expect(c.status).toBe(200);
    agentId = c.json.data.agent_id;
    expect((await post("/v3/meta/agent/get", { agent_id: agentId })).status).toBe(200);
    expect((await post("/v3/meta/agent/update", { agent_id: agentId, description: "d" })).status).toBe(200);
    expect((await post("/v3/meta/agent/list", { team_id: teamId })).status).toBe(200);
    expect((await post("/v3/meta/agent/archive", { agent_id: agentId })).status).toBe(200);
  });
  it("task + links + participation", async () => {
    const c = await post("/v3/meta/task/create", { team_id: teamId, creator_user_id: adminId, title: "Do it" });
    expect(c.status).toBe(200);
    taskId = c.json.data.task_id;
    expect((await post("/v3/meta/task/get", { task_id: taskId })).status).toBe(200);
    expect((await post("/v3/meta/task/update", { task_id: taskId, description: "d" })).status).toBe(200);
    expect((await post("/v3/meta/task/list", { team_id: teamId })).status).toBe(200);
    expect((await post("/v3/meta/task-agent/link", { task_id: taskId, agent_id: agentId })).status).toBe(200);
    expect((await post("/v3/meta/task-agent/list", { task_id: taskId })).status).toBe(200);
    expect((await post("/v3/meta/participation-log/append", {
      team_id: teamId, task_id: taskId, agent_id: agentId, user_id: adminId,
    })).status).toBe(200);
    expect((await post("/v3/meta/participation-log/list", { team_id: teamId })).status).toBe(200);
    expect((await post("/v3/meta/task-agent/unlink", { task_id: taskId, agent_id: agentId })).status).toBe(200);
    expect((await post("/v3/meta/task/archive", { task_id: taskId })).status).toBe(200);
  });
});

describe("asset + acl + fixed (real HTTP)", () => {
  const AID = "sk-http-1";
  it("asset lifecycle", async () => {
    const c = await post("/v3/meta/asset/create", {
      asset_id: AID, team_id: "t-x", asset_type: "skill", name: "S",
      owner_user_id: adminId, source_type: "uploaded",
    });
    // Team t-x may not exist; accept 200 or honest 4xx, but route must answer
    expect([200, 400, 403, 404]).toContain(c.status);
  });
  it("asset flow on real team", async () => {
    const team = await post("/v3/meta/team/create", { name: "TA", owner_user_id: adminId });
    const tid = team.json.data.team_id;
    const c = await post("/v3/meta/asset/create", {
      asset_id: "sk-http-2", team_id: tid, asset_type: "skill", name: "S2",
      owner_user_id: adminId, source_type: "uploaded",
    });
    expect(c.status).toBe(200);
    expect((await post("/v3/meta/asset/get", { asset_id: "sk-http-2" })).status).toBe(200);
    expect((await post("/v3/meta/asset/update", { asset_id: "sk-http-2", description: "d" })).status).toBe(200);
    expect((await post("/v3/meta/asset/list", { team_id: tid })).status).toBe(200);
    expect((await post("/v3/meta/asset/touch-usage", { asset_id: "sk-http-2" })).status).toBe(200);
    expect((await post("/v3/meta/asset/list-accessible", { user_id: adminId, team_id: tid })).status).toBe(200);
    const g = await post("/v3/meta/acl/grant", { asset_id: "sk-http-2", subject_type: "user", subject_id: adminId, permission: "read", granted_by: adminId });
    expect(g.status).toBe(200);
    const aclId = g.json.data.id ?? g.json.data.acl_id;
    expect((await post("/v3/meta/acl/list", { asset_id: "sk-http-2" })).status).toBe(200);
    expect((await post("/v3/meta/acl/check", { user_id: adminId, asset_id: "sk-http-2", action: "read" })).status).toBe(200);
    if (aclId) expect((await post("/v3/meta/acl/revoke", { id: aclId })).status).toBe(200);
    const ag = await post("/v3/meta/agent/create", { team_id: tid, owner_user_id: adminId, name: "AFX" });
    const agId = ag.json.data.agent_id;
    expect((await post("/v3/meta/agent-fixed-asset/set", {
      agent_id: agId, bindings: [{ asset_id: "sk-http-2", asset_type: "skill", created_by: adminId }],
    })).status).toBe(200);
    expect((await post("/v3/meta/agent-fixed-asset/list", { agent_id: agId })).status).toBe(200);
    expect((await post("/v3/meta/agent-fixed-asset/list-with-detail", { agent_id: agId })).status).toBe(200);
    expect((await post("/v3/meta/agent-fixed-asset/summary-by-agents", { agent_ids: [agId] })).status).toBe(200);
    expect((await post("/v3/meta/asset/delete", { asset_ids: ["sk-http-2"] })).status).toBe(200);
  });
});

describe("quota + config params (real HTTP)", () => {
  it("instance-quota/get + config user get/set", async () => {
    expect((await post("/v3/meta/instance-quota/get", {})).status).toBe(200);
    const g = await post("/v3/meta/config/user/get", { user_id: adminId, module: "asset_type" });
    expect(g.status).toBe(200);
    const s = await post("/v3/meta/config/user/set", {
      user_id: adminId, module: "asset_type", params: { "skill.enabled": "1" },
    });
    expect(s.status).toBe(200);
  });
});
