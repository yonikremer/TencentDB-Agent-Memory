/**
 * http-real.test.ts — REAL HTTP API coverage for the Panel service.
 *
 * Boots buildPanelApp() with mocked kernel ports on 127.0.0.1 (ephemeral
 * port) and sends real fetch() requests. Mocks sit at the kernel boundary
 * (meta/skill/knowledge upstreams); all routing, auth, validation and
 * response envelopes are the real code path.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPanelApp } from "../src/panel/http/app.js";
import { makeDeps, TEST_INSTANCE_ID, listEnvelope, okEnv, type MockDeps } from "./helpers/mock-deps.js";

const HDRS = {
  "x-tdai-service-id": TEST_INSTANCE_ID,
  "x-tdai-user-key": "uk-1",
  "content-type": "application/json",
};

let base = "";
let server: Server;
let distDir = "";
let deps: MockDeps;

async function post(path: string, body: unknown = {}, headers: Record<string, string> = HDRS) {
  const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as any;
  return { status: res.status, json };
}

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { headers });
  const json = (await res.json().catch(() => null)) as any;
  return { status: res.status, json };
}

function okEnvelope(body: unknown) {
  return { code: 0, message: "ok", request_id: "r", data: body };
}

beforeAll(async () => {
  deps = makeDeps();
  distDir = mkdtempSync(join(tmpdir(), "panel-dist-"));
  mkdirSync(join(distDir, "assets"), { recursive: true });
  writeFileSync(join(distDir, "index.html"), "<html>index</html>");
  writeFileSync(join(distDir, "assets", "app.js"), "console.log(1)");
  deps.config.ui.distDir = distDir;

  deps.metaKernel.invoke.mockImplementation(async (action: string, body: any) => {
    if (action === "auth/verify")
      return okEnvelope({ valid: true, user: { user_id: "u1", user_type: "member" } });
    if (action === "team-member/get")
      return okEnvelope({ team_id: body?.team_id ?? "t1", user_id: "u1" });
    if (action === "asset/create")
      return okEnvelope({
        asset_id: body?.asset_id ?? "mem-x", name: body?.name ?? "n",
        owner_user_id: body?.owner_user_id ?? "u1", visibility: body?.visibility ?? "team",
        asset_type: body?.asset_type ?? "chat_memory", status: "active", updated_at: Date.now(),
      });
    if (action === "asset/get")
      return okEnvelope({
        asset_id: body?.asset_id ?? "mem-x", asset_type: "chat_memory", name: "n",
        owner_user_id: "u1", visibility: "team", status: "active", team_id: "t1",
      });
    if (action === "acl/check") return okEnvelope({ allowed: true });
    if (action === "agent/get")
      return okEnvelope({ agent_id: body?.agent_id ?? "a1", name: "A", team_id: "t1", owner_user_id: "u1" });
    if (action === "agent-fixed-asset/list")
      return okEnvelope({
        items: [{ asset_id: "w-1", asset_type: "llm_wiki", injection_mode: "summary", priority: 50, created_by: "u1" }],
        total: 1,
      });
    if (action === "user/get")
      return okEnvelope({ user_id: body?.user_id ?? "u1", name: "U" });
    return { code: 0, message: "ok", request_id: "r", data: { items: [], total: 0 } };
  });
  deps.kernelHttp.postEnvelope.mockImplementation(async () => okEnvelope({ items: [], total: 0 }));
  deps.skillKernel.invoke.mockImplementation(async () => okEnvelope({ items: [], total: 0 }));

  const app = buildPanelApp(deps as any);
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address();
  base = "http://127.0.0.1:" + (typeof addr === "object" && addr ? addr.port : 0);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  rmSync(distDir, { recursive: true, force: true });
});

describe("health + instances (real HTTP)", () => {
  it("GET /health", async () => {
    const { status, json } = await get("/health");
    expect(status).toBe(200);
    expect(json).toEqual({ status: "ok" });
  });

  it("GET /api/v1/meta/instances strips api_key", async () => {
    const { status, json } = await get("/api/v1/meta/instances");
    expect(status).toBe(200);
    expect(json.instances).toHaveLength(1);
    expect(json.instances[0].api_key).toBeUndefined();
  });
});

describe("meta + skill passthrough (real HTTP)", () => {
  it("POST /api/v1/meta/user/list forwards to metaKernel", async () => {
    deps.metaKernel.invoke.mockResolvedValueOnce(
      okEnvelope({ items: [{ user_id: "u1" }], total: 1 }),
    );
    const { status, json } = await post("/api/v1/meta/user/list", { team_id: "t1" });
    expect(status).toBe(200);
    expect(json.code).toBe(0);
    expect(json.data.items).toHaveLength(1);
  });

  it("POST /api/v1/skill/list forwards to skillKernel", async () => {
    deps.skillKernel.invoke.mockResolvedValueOnce(okEnvelope({ items: [{ skill_id: "s1" }], total: 1 }));
    const { status, json } = await post("/api/v1/skill/list", { team_id: "t1" });
    expect(status).toBe(200);
    expect(json.code).toBe(0);
  });

  it("auth: missing instance -> 400, bad instance -> 400, missing user key -> 400", async () => {
    const noInst = await post("/api/v1/meta/user/list", {}, { "content-type": "application/json" });
    expect(noInst.status).toBe(400);
    const badInst = await post("/api/v1/meta/user/list", {}, { ...HDRS, "x-tdai-service-id": "nope" });
    expect(badInst.status).toBe(400);
    const noKey = await post("/api/v1/meta/user/list", {}, {
      "x-tdai-service-id": TEST_INSTANCE_ID, "content-type": "application/json",
    });
    expect(noKey.status).toBe(400);
  });
});

describe("chat-memory (real HTTP)", () => {
  it("POST /api/v1/chat-memory/mine", async () => {
    const { status, json } = await post("/api/v1/chat-memory/mine", { team_id: "t1" });
    expect(status).toBe(200);
    expect(json.code).toBe(0);
    expect(json.data.total).toBe(0);
  });

  it("POST /api/v1/chat-memory/create", async () => {
    const { status, json } = await post("/api/v1/chat-memory/create", { team_id: "t1", title: "My mem" });
    expect(status).toBe(200);
    expect(json.code).toBe(0);
    expect(json.data.title).toBe("My mem");
  });

  it("POST /api/v1/chat-memory/create validation -> 400", async () => {
    expect((await post("/api/v1/chat-memory/create", { title: "x" })).status).toBe(400);
    expect((await post("/api/v1/chat-memory/create", { team_id: "t1" })).status).toBe(400);
  });

  it.each([
    ["/api/v1/chat-memory/team-assets", { team_id: "t1" }],
    ["/api/v1/chat-memory/agent-fixed", { team_id: "t1" }],
    ["/api/v1/chat-memory/my-agents", { team_id: "t1" }],
    ["/api/v1/chat-memory/import", { team_id: "t1" }],
    ["/api/v1/chat-memory/patch-scope", { team_id: "t1", block_id: "mem-x", scope: "team" }],
    ["/api/v1/chat-memory/set-agent-fixed", { team_id: "t1" }],
    ["/api/v1/chat-memory/allocate", { team_id: "t1" }],
    ["/api/v1/chat-memory/layer", { block_id: "mem-x" }],
    ["/api/v1/chat-memory/clear", { block_id: "mem-x" }],
    ["/api/v1/chat-memory/layer-delete", { block_id: "mem-x" }],
    ["/api/v1/chat-memory/layer-update", { block_id: "mem-x" }],
    ["/api/v1/chat-memory/unbind", { block_id: "mem-x" }],
    ["/api/v1/chat-memory/search", { block_id: "mem-x", query: "q" }],
  ])("POST %s responds", async (path, body) => {
    const { status, json } = await post(path, body);
    expect([200, 400, 403, 404]).toContain(status);
    expect(json).toHaveProperty("code");
  });
});

describe("task + agents (real HTTP)", () => {
  it("POST /api/v1/task/list-with-agents", async () => {
    const { status, json } = await post("/api/v1/task/list-with-agents", { team_id: "t1" });
    expect(status).toBe(200);
    expect(json.code).toBe(0);
  });

  it("POST /api/v1/agent-overview/bootstrap", async () => {
    const { status, json } = await post("/api/v1/agent-overview/bootstrap", { team_id: "t1" });
    expect(status).toBe(200);
    expect(json.code).toBe(0);
  });

  it("POST /api/v1/agent/delete-cascade", async () => {
    const { status, json } = await post("/api/v1/agent/delete-cascade", { agent_id: "a1", team_id: "t1" });
    expect([200, 400]).toContain(status);
    expect(json).toHaveProperty("code");
  });
});

describe("knowledge (real HTTP)", () => {
  it("wiki create/get/list/ingest/delete", async () => {
    const kc: any = deps.knowledgeClientFactory(TEST_INSTANCE_ID);
    kc.wikiCreate.mockResolvedValue({ wiki_id: "w-1", name: "W", service_url: "" });
    kc.wikiGet.mockResolvedValue({ wiki_id: "w-1", name: "W", status: "ready" });
    kc.wikiList.mockResolvedValue({ items: [{ wiki_id: "w-1" }], total: 1 });
    kc.wikiRawLs.mockResolvedValue({ items: [{ filename: "a.md" }] });
    kc.wikiIngest.mockResolvedValue({ wiki_id: "w-1", status: "pending" });
    kc.wikiDelete.mockResolvedValue({ deleted_ids: ["w-1"], failed: [] });

    expect((await post("/api/v1/knowledge/wiki/create", { team_id: "t1", name: "W" })).status).toBe(200);
    const g = await post("/api/v1/knowledge/wiki/get", { wiki_id: "w-1" });
    expect(g.status).toBe(200);
    expect(g.json.data.wiki_id).toBe("w-1");
    const l = await post("/api/v1/knowledge/wiki/list", { team_id: "t1" });
    expect(l.json.data.total).toBe(1);
    expect((await post("/api/v1/knowledge/wiki/ingest", { wiki_id: "w-1" })).status).toBe(200);
    expect((await post("/api/v1/knowledge/wiki/delete", { wiki_ids: ["w-1"] })).status).toBe(200);
  });

  it("wiki file + derived endpoints", async () => {
    const kc: any = deps.knowledgeClientFactory(TEST_INSTANCE_ID);
    kc.wikiRawLs.mockResolvedValue({ items: [] });
    kc.wikiRawRead.mockResolvedValue({ items: [] });
    kc.wikiRawWrite.mockResolvedValue({ items: [] });
    kc.wikiRawRm.mockResolvedValue({ deleted_files: [] });
    kc.wikiPageLs.mockResolvedValue({ items: [] });
    kc.wikiPageRead.mockResolvedValue({ items: [] });
    kc.wikiPageWrite.mockResolvedValue({ items: [] });
    kc.wikiPageRm.mockResolvedValue({ deleted_pages: [] });
    kc.wikiGraph.mockResolvedValue({ nodes: [], edges: [] });
    kc.wikiSearch.mockResolvedValue({ items: [] });
    for (const [path, body] of [
      ["/api/v1/knowledge/wiki/raw/ls", { wiki_id: "w-1" }],
      ["/api/v1/knowledge/wiki/raw/read", { wiki_id: "w-1", filenames: ["a.md"] }],
      ["/api/v1/knowledge/wiki/raw/write", { team_id: "t1", wiki_id: "w-1", files: [] }],
      ["/api/v1/knowledge/wiki/raw/rm", { team_id: "t1", wiki_id: "w-1", filenames: ["a.md"] }],
      ["/api/v1/knowledge/wiki/page/ls", { wiki_id: "w-1" }],
      ["/api/v1/knowledge/wiki/page/read", { wiki_id: "w-1", refs: ["a"] }],
      ["/api/v1/knowledge/wiki/page/rm", { team_id: "t1", wiki_id: "w-1", refs: ["a"] }],
      ["/api/v1/knowledge/wiki/graph", { wiki_id: "w-1" }],
      ["/api/v1/knowledge/wiki/search", { wiki_id: "w-1", query: "q" }],
    ] as Array<[string, unknown]>) {
      const { status, json } = await post(path, body);
      expect([200, 400], path).toContain(status);
      expect(json).toHaveProperty("code");
    }
  });

  it("code-graph create/list/get/sync/delete/search/explore", async () => {
    const kc: any = deps.knowledgeClientFactory(TEST_INSTANCE_ID);
    kc.codeGraphCreate.mockResolvedValue({ code_graph_id: "cg-1" });
    kc.codeGraphList.mockResolvedValue({ items: [{ code_graph_id: "cg-1" }], total: 1 });
    kc.codeGraphGet.mockResolvedValue({ code_graph_id: "cg-1", status: "ready" });
    kc.codeGraphSync.mockResolvedValue({ code_graph_id: "cg-1", status: "pending" });
    kc.codeGraphDelete.mockResolvedValue({ deleted_ids: ["cg-1"], failed: [] });
    kc.codeGraphQuery.mockResolvedValue({ text: "", isError: false });
    for (const [path, body] of [
      ["/api/v1/knowledge/code-graph/create", { team_id: "t1", repo_url: "https://x/y" }],
      ["/api/v1/knowledge/code-graph/register-meta", { team_id: "t1", code_graph_id: "cg-1" }],
      ["/api/v1/knowledge/code-graph/list", { team_id: "t1" }],
      ["/api/v1/knowledge/code-graph/get", { code_graph_id: "cg-1" }],
      ["/api/v1/knowledge/code-graph/sync", { code_graph_id: "cg-1" }],
      ["/api/v1/knowledge/code-graph/search", { code_graph_id: "cg-1", query: "q" }],
      ["/api/v1/knowledge/code-graph/explore", { code_graph_id: "cg-1" }],
      ["/api/v1/knowledge/code-graph/delete", { code_graph_ids: ["cg-1"] }],
    ] as Array<[string, unknown]>) {
      const { status, json } = await post(path, body);
      expect([200, 400], path).toContain(status);
      expect(json).toHaveProperty("code");
    }
  });

  it("allocate/unbind/agent-fixed/set-visibility/grant + team-assets + callback", async () => {
    for (const [path, body] of [
      ["/api/v1/knowledge/allocate", { team_id: "t1", knowledge_id: "w-1", agent_id: "a1" }],
      ["/api/v1/knowledge/unbind", { team_id: "t1", knowledge_id: "w-1", agent_id: "a1" }],
      ["/api/v1/knowledge/agent-fixed", { team_id: "t1", agent_id: "a1" }],
      ["/api/v1/knowledge/set-visibility", { team_id: "t1", knowledge_id: "w-1", visibility: "team" }],
      ["/api/v1/knowledge/grant", { team_id: "t1", knowledge_id: "w-1", subject_type: "user", subject_id: "u1", permission: "read" }],
      ["/api/v1/knowledge/wiki/team-assets", { team_id: "t1" }],
      ["/api/v1/knowledge/code-graph/team-assets", { team_id: "t1" }],
    ] as Array<[string, unknown]>) {
      const { status, json } = await post(path, body);
      expect([200, 400], path).toContain(status);
      expect(json).toHaveProperty("code");
    }
    const cb = await post("/api/v1/knowledge/status-callback", { wiki_id: "w-1", status: "ready" });
    expect([200, 400]).toContain(cb.status);
  });
});
