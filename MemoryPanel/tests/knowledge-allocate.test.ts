/**
 * knowledge-allocate.test.ts — guide section 2.4 through the real panel hop.
 *
 * Boots the real POST /api/v1/knowledge/allocate route with a real
 * InstanceRegistry + a fake MetaKernelPort delegating to a real
 * MetadataService (SQLite temp). Proves the exact failure modes from the
 * guide: 404 KNOWLEDGE_NOT_FOUND when asset/register skipped, 200 +
 * allocated:true + fixed-asset bind with injection_mode tool otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteMetadataStore } from "../../MemoryCore/src/metadata/store/sqlite-adapter.js";
import { MetadataService } from "../../MemoryCore/src/metadata/service/metadata-service.js";
import { InstanceRegistry } from "../src/panel/config/instance-registry.js";
import { registerKnowledgeAllocateRoutes } from "../src/panel/http/routes/knowledge/allocate-routes.js";
import type { PanelDeps } from "../src/panel/panel-deps.js";

const INST = "test-alloc-1";
const ADMIN_KEY = "adm-key-alloc-1";

let base = "";
let server: Server;
let tmp = "";
let svc: MetadataService;
let adminId = "";
let teamId = "";
let agentId = "";
const WIKI = "wiki-alloc00";

async function post(path: string, body: unknown, key: string | null = ADMIN_KEY) {
  const h: Record<string, string> = { "content-type": "application/json", "x-tdai-service-id": INST };
  if (key) h["x-tdai-user-key"] = key;
  const res = await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as { code: number; message: string; data: any } };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "panel-alloc-"));
  const store = new SqliteMetadataStore(join(tmp, "meta.db"));
  (globalThis as any).__metaStore = store;
  store.init();
  svc = new MetadataService(store, INST, { debug: () => {} });
  const admin = await svc.initAdminUser({ username: "root", user_key: ADMIN_KEY });
  adminId = admin.user_id;
  const team = await svc.createTeam({ name: "research", owner_user_id: adminId });
  teamId = team.team_id;
  const agent = await svc.createAgent({ team_id: teamId, owner_user_id: adminId, name: "shared" });
  agentId = agent.agent_id;

  const metaKernel = {
    async invoke(action: string, body: Record<string, unknown>, _ctx: unknown) {
      const ok = (data: unknown) => ({ code: 0, message: "ok", request_id: "t", data });
      switch (action) {
        case "auth/verify":
          return ok(await svc.verifyAuthForCaller(body.user_key as string, {} as any));
        case "team-member/get":
          return ok(await svc.getTeamMember(body.team_id as string, body.user_id as string));
        case "asset/get": {
          const a = await svc.getAssetById(body.asset_id as string);
          return a ? ok(a) : { code: 404, message: "not found", request_id: "t", data: null };
        }
        case "agent/get": {
          const g = await svc.getAgentById(body.agent_id as string);
          return g ? ok(g) : { code: 404, message: "not found", request_id: "t", data: null };
        }
        case "agent-fixed-asset/list":
          return ok(await svc.listAgentFixedAssets(body.agent_id as string, {
            limit: (body.limit as number) ?? 20, offset: (body.offset as number) ?? 0,
          }));
        case "agent-fixed-asset/set":
          await svc.setAgentFixedAssets(body.agent_id as string, (body.bindings as any) ?? []);
          return ok({ ok: true });
        default:
          return { code: 400, message: `unsupported in test: ${action}`, request_id: "t", data: null };
      }
    },
  };
  const deps = {
    instanceRegistry: new InstanceRegistry([{
      instance_id: INST, name: "t", gateway_endpoint: "http://127.0.0.1:9", api_key: "k",
    }]),
    metaKernel,
  } as unknown as PanelDeps;
  const app = new Hono();
  const api = new Hono();
  registerKnowledgeAllocateRoutes(api, deps);
  app.route("/api/v1", api);
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address();
  base = "http://127.0.0.1:" + (typeof addr === "object" && addr ? addr.port : 0);
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  try { (globalThis as any).__metaStore?.close(); } catch { /* ignore */ }
  rmSync(tmp, { recursive: true, force: true });
});

describe("guide 2.4: panel allocate", () => {
  it("404 KNOWLEDGE_NOT_FOUND when asset/register skipped", async () => {
    const r = await post("/api/v1/knowledge/allocate", { team_id: teamId, knowledge_id: WIKI, agent_id: agentId });
    expect(r.json.code).toBe(404);
    expect(r.json.message).toContain("KNOWLEDGE_NOT_FOUND");
  });

  it("allocate after asset/create binds with injection tool", async () => {
    await svc.createAsset({
      asset_id: WIKI, team_id: teamId, asset_type: "llm_wiki", name: "research-shared",
      owner_user_id: adminId, source_type: "uploaded", visibility: "team",
    });
    const r = await post("/api/v1/knowledge/allocate", { team_id: teamId, knowledge_id: WIKI, agent_id: agentId });
    expect(r.json.code).toBe(0);
    expect(r.json.data.allocated).toBe(true);
    const binds = await svc.listAgentFixedAssets(agentId, { limit: 20, offset: 0 });
    const hit = (binds as any).items.find((b: any) => b.asset_id === WIKI);
    expect(hit).toBeTruthy();
    expect(hit.injection_mode).toBe("tool");
  });

  it("double allocate -> 409 ALREADY_ALLOCATED", async () => {
    const r = await post("/api/v1/knowledge/allocate", { team_id: teamId, knowledge_id: WIKI, agent_id: agentId });
    expect(r.json.code).toBe(409);
  });

  it("bad key -> 401, outsider -> 403", async () => {
    const bad = await post("/api/v1/knowledge/allocate",
      { team_id: teamId, knowledge_id: WIKI, agent_id: agentId }, "wrong-key");
    expect(bad.json.code).toBe(401);
    const outsider = await svc.createNormalUser({ username: "mallory" });
    const oustside = await post("/api/v1/knowledge/allocate",
      { team_id: teamId, knowledge_id: WIKI, agent_id: agentId }, outsider.default_user_key);
    expect(oustside.json.code).toBe(403);
  });
});
