/**
 * http-real.test.ts — REAL HTTP API coverage for the Knowledge service.
 *
 * Boots the real route stack (health + wiki + code-graph + tools +
 * llm-binding + auto-sync) on 127.0.0.1 with a real SQLite DB + temp dataDir,
 * then sends real fetch() requests and asserts status codes + envelopes.
 * LLM/git workers are stubbed (ingest/sync return immediately); everything
 * else (routing, validation, tenancy, persistence) is the real code path.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../../db/client.js";
import { createKnowledgeModule } from "../../module.js";
import { createWikiRoutes } from "../wiki.js";
import { createCodeGraphRoutes } from "../code-graph.js";
import { createToolsRoutes } from "../tools.js";
import { createHealthRoutes } from "../health.js";
import { createLlmBindingRoutes } from "../llm-binding.js";
import { createAutoSyncRoutes } from "../auto-sync.js";

const SVC = "svc-http-1";
const TEAM = "team-http-1";

let base = "";
let server: Server;
let tmp = "";

function hdr(extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", "x-tdai-service-id": SVC, ...extra };
}

async function post(path: string, body: unknown, headers?: Record<string, string>) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: headers ?? hdr(),
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as { code: number; message: string; data: any };
  return { status: res.status, json };
}

async function get(path: string, headers?: Record<string, string>) {
  const res = await fetch(base + path, { headers: headers ?? {} });
  const json = (await res.json().catch(() => null)) as any;
  return { status: res.status, json };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "know-http-"));
  const { db, raw } = createDb({ path: join(tmp, "test.db") });
  (globalThis as any).__knowRaw = raw;
  const mod = createKnowledgeModule({
    dataDir: join(tmp, "data"),
    db,
    llmConfig: {
      mode: "custom", protocol: "openai", provider: "custom", apiKey: "k",
      model: "m", baseUrl: "http://127.0.0.1:1", maxTokens: 100, timeoutMs: 1000,
    },
    tmcCallbackUrl: "",
    wikiWorker: async () => ({ pageCount: 0 }),
    // Never-resolving code worker keeps graphs in `pending` so query tests
    // deterministically hit the unready branch (sync still returns 202).
    codeWorker: async () => { await new Promise(() => {}); return {}; },
  });
  (globalThis as any).__knowMod = mod;

  const app = new Hono();
  app.route("/", createHealthRoutes());
  const api = new Hono();
  api.route("/wiki", createWikiRoutes({ wikiService: mod.wikiService, wikiMgr: mod.wikiMgr, publicBaseUrl: "" }));
  api.route("/code-graph", createCodeGraphRoutes({ cgService: mod.cgService, instancePool: mod.instancePool, publicBaseUrl: "" }));
  api.route("/tools", createToolsRoutes({ wikiService: mod.wikiService, wikiMgr: mod.wikiMgr, cgService: mod.cgService, instancePool: mod.instancePool }));
  api.route("/internal/llm-binding", createLlmBindingRoutes({ llmBindingStore: mod.llmBindingStore }));
  api.route("/", createAutoSyncRoutes({ scheduler: mod.autoSyncScheduler, config: mod.autoSyncConfig }));
  app.route("/v3", api);

  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = "http://127.0.0.1:" + port;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  try { (globalThis as any).__knowRaw?.close(); } catch { /* ignore */ }
  rmSync(tmp, { recursive: true, force: true });
});

describe("health (real HTTP)", () => {
  it("GET /health returns 200 ok", async () => {
    const { status, json } = await get("/health");
    expect(status).toBe(200);
    expect(json.status).toBe("ok");
  });
});

describe("wiki lifecycle (real HTTP)", () => {
  let wikiId = "";

  it("POST /v3/wiki/create -> 201 + wiki_id", async () => {
    const { status, json } = await post("/v3/wiki/create", { team_id: TEAM, name: "HTTP Wiki", user_id: "u1" });
    expect(status).toBe(201);
    expect(json.code).toBe(0);
    expect(json.data.wiki_id).toBeTruthy();
    wikiId = json.data.wiki_id;
  });

  it("POST /v3/wiki/get returns detail", async () => {
    const { status, json } = await post("/v3/wiki/get", { wiki_id: wikiId });
    expect(status).toBe(200);
    expect(json.code).toBe(0);
    expect(json.data.wiki_id).toBe(wikiId);
    expect(json.data.name).toBe("HTTP Wiki");
  });

  it("POST /v3/wiki/list contains created wiki", async () => {
    const { status, json } = await post("/v3/wiki/list", { team_id: TEAM });
    expect(status).toBe(200);
    expect(json.data.total).toBe(1);
    expect(json.data.items[0].wiki_id).toBe(wikiId);
  });

  it("POST /v3/wiki/update-meta renames", async () => {
    const { status, json } = await post("/v3/wiki/update-meta", { wiki_id: wikiId, name: "Renamed" });
    expect(status).toBe(200);
    expect(json.data.name).toBe("Renamed");
  });

  it("POST /v3/wiki/raw/write + ls + read round-trip", async () => {
    const w = await post("/v3/wiki/raw/write", { team_id: TEAM, wiki_id: wikiId, files: [{ filename: "doc.md", content: "# Hello\nbody text" }] });
    expect(w.status).toBe(200);
    expect(w.json.code).toBe(0);
    const ls = await post("/v3/wiki/raw/ls", { wiki_id: wikiId });
    expect(ls.json.data.items.map((i: any) => i.filename)).toContain("doc.md");
    const rd = await post("/v3/wiki/raw/read", { wiki_id: wikiId, filenames: ["doc.md"] });
    expect(rd.status).toBe(200);
    expect(JSON.stringify(rd.json.data)).toContain("Hello");
  });

  it("POST /v3/wiki/page/write + ls + read round-trip", async () => {
    const w = await post("/v3/wiki/page/write", { team_id: TEAM, wiki_id: wikiId, pages: [{ ref: "intro", content: "intro body" }] });
    expect(w.status).toBe(200);
    const ls = await post("/v3/wiki/page/ls", { wiki_id: wikiId });
    expect(ls.status).toBe(200);
    const rd = await post("/v3/wiki/page/read", { wiki_id: wikiId, refs: ["intro"] });
    expect(rd.status).toBe(200);
    expect(JSON.stringify(rd.json.data)).toContain("intro body");
  });

  it("POST /v3/wiki/search + graph respond", async () => {
    const s = await post("/v3/wiki/search", { wiki_id: wikiId, query: "hello" });
    expect(s.status).toBe(200);
    expect(s.json.code).toBe(0);
    const g = await post("/v3/wiki/graph", { wiki_id: wikiId });
    expect(g.status).toBe(200);
    expect(g.json.code).toBe(0);
  });

  it("POST /v3/wiki/ingest enqueues (stub worker)", async () => {
    const { status, json } = await post("/v3/wiki/ingest", { wiki_id: wikiId });
    expect(status).toBe(202);
    expect(json.code).toBe(0);
  });

  it("POST /v3/tools/list exposes wiki tools", async () => {
    const { status, json } = await post("/v3/tools/list", { knowledge_id: wikiId });
    expect(status).toBe(200);
    expect(json.data.type).toBe("wiki");
    expect(json.data.tools.length).toBeGreaterThan(0);
  });

  it("POST /v3/tools/call get_info works", async () => {
    const { status, json } = await post("/v3/tools/call", { knowledge_id: wikiId, tool_name: "get_info", params: {} });
    expect(status).toBe(200);
    expect(json.code).toBe(0);
  });

  it("validation: missing header/team/name -> 400", async () => {
    const noHdr = await post("/v3/wiki/create", { team_id: TEAM, name: "x" }, { "content-type": "application/json" });
    expect(noHdr.status).toBe(400);
    const noTeam = await post("/v3/wiki/create", { name: "x" });
    expect(noTeam.status).toBe(400);
    const noName = await post("/v3/wiki/create", { team_id: TEAM });
    expect(noName.status).toBe(400);
    const noId = await post("/v3/wiki/get", {});
    expect(noId.status).toBe(400);
  });

  it("tenancy: foreign service_id cannot read wiki -> 404", async () => {
    const { status } = await post("/v3/wiki/get", { wiki_id: wikiId }, hdr({ "x-tdai-service-id": "other-svc" }));
    expect(status).toBe(404);
  });

  it("POST /v3/wiki/raw/rm + page/rm remove content", async () => {
    const rm1 = await post("/v3/wiki/raw/rm", { team_id: TEAM, wiki_id: wikiId, filenames: ["doc.md"] });
    expect(rm1.status).toBe(200);
    const rm2 = await post("/v3/wiki/page/rm", { team_id: TEAM, wiki_id: wikiId, refs: ["intro"] });
    expect(rm2.status).toBe(200);
  });

  it("POST /v3/wiki/delete removes wiki", async () => {
    const { status, json } = await post("/v3/wiki/delete", { wiki_ids: [wikiId] });
    expect(status).toBe(200);
    expect(json.data.deleted_ids).toContain(wikiId);
    const g = await post("/v3/wiki/get", { wiki_id: wikiId });
    expect(g.status).toBe(404);
  });
});

describe("code-graph lifecycle (real HTTP)", () => {
  let cgId = "";

  it("POST /v3/code-graph/create -> 201 + id", async () => {
    const { status, json } = await post("/v3/code-graph/create", {
      team_id: TEAM, repo_url: "https://github.com/example/repo", branch: "main", repo_name: "repo",
    });
    expect(status).toBe(201);
    expect(json.code).toBe(0);
    cgId = json.data.code_graph_id;
    expect(cgId).toBeTruthy();
  });

  it("POST /v3/code-graph/get + list + update-meta", async () => {
    const g = await post("/v3/code-graph/get", { code_graph_id: cgId });
    expect(g.status).toBe(200);
    expect(g.json.data.code_graph_id).toBe(cgId);
    const l = await post("/v3/code-graph/list", { team_id: TEAM });
    expect(l.json.data.total).toBe(1);
    const u = await post("/v3/code-graph/update-meta", { code_graph_id: cgId, repo_name: "renamed" });
    expect(u.status).toBe(200);
  });

  it("POST /v3/code-graph/sync while busy -> 409", async () => {
    // Creation build is still pending (never-resolving stub worker) so an
    // explicit sync is concurrency-rejected with 409 + busy payload.
    const { status, json } = await post("/v3/code-graph/sync", { code_graph_id: cgId });
    expect(status).toBe(409);
    expect(json.code).toBe(409);
    expect(["pending", "processing"]).toContain(json.data.status);
  });

  it("query on unready graph degrades to empty 200 (no crash)", async () => {
    const { status, json } = await post("/v3/code-graph/search", { code_graph_id: cgId, query: "foo" });
    expect(status).toBe(200);
    expect(json.code).toBe(0);
  });

  it("POST /v3/tools/list exposes code-graph tools", async () => {
    const { status, json } = await post("/v3/tools/list", { knowledge_id: cgId });
    expect(status).toBe(200);
    expect(json.data.type).toBe("code-graph");
  });

  it("validation + tenancy", async () => {
    const noUrl = await post("/v3/code-graph/create", { team_id: TEAM });
    expect(noUrl.status).toBe(400);
    const foreign = await post("/v3/code-graph/get", { code_graph_id: cgId }, hdr({ "x-tdai-service-id": "other-svc" }));
    expect(foreign.status).toBe(404);
  });

  it("POST /v3/code-graph/delete removes it", async () => {
    const { status, json } = await post("/v3/code-graph/delete", { code_graph_ids: [cgId] });
    expect(status).toBe(200);
    expect(JSON.stringify(json.data)).toContain(cgId);
  });
});

describe("llm-binding + auto-sync (real HTTP)", () => {
  it("POST /v3/internal/llm-binding/set + status + list", async () => {
    const set = await post("/v3/internal/llm-binding/set", {
      mode: "proxy", proxy_base_url: "http://127.0.0.1:8096", api_key: "k",
    });
    expect(set.status).toBe(200);
    expect(set.json.data.mode).toBe("proxy");
    expect(JSON.stringify(set.json.data)).not.toContain("k");
    const st = await post("/v3/internal/llm-binding/status", {});
    expect(st.status).toBe(200);
    const li = await post("/v3/internal/llm-binding/list", {});
    expect(li.status).toBe(200);
    expect(li.json.data.items.length).toBeGreaterThan(0);
  });

  it("llm-binding validation -> 400", async () => {
    const noMode = await post("/v3/internal/llm-binding/set", { proxy_base_url: "http://x" });
    expect(noMode.status).toBe(400);
    const noHdr = await post("/v3/internal/llm-binding/status", {}, { "content-type": "application/json" });
    expect(noHdr.status).toBe(400);
  });

  it("GET /v3/auto-sync/status + POST /v3/auto-sync/trigger", async () => {
    const s = await get("/v3/auto-sync/status");
    expect(s.status).toBe(200);
    expect(s.json.code).toBe(0);
    const t = await post("/v3/auto-sync/trigger", {});
    expect(t.status).toBe(200);
    expect(t.json.code).toBe(0);
  });
});
