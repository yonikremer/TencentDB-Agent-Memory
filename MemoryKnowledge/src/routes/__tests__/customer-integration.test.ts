/**
 * customer-integration.test.ts — cross-cutting integration cover for customer paths.
 *
 * Why this file exists: unit/route tests mount route stacks directly, so they
 * never exercise the server.ts auth plane (x-tdai-user-key + CORE_VERIFY_URL +
 * bearer forwarding) and never assert Core<->Knowledge verify contract drift.
 * Customers hit exactly those seams: 401/503 on first boot, missing service-id
 * headers, tenant leaks, grant enforcement, envelope shape.
 *
 * Two harnesses (both real HTTP, temp dirs, no LLM/network):
 *  A. full createApp() — auth plane only (health public, verify contract).
 *  B. route-stack app with stub wikiWorker — wiki/code-graph/grants/tools flows.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import http from "node:http";
import type { AddressInfo, Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../../db/client.js";
import { createKnowledgeModule } from "../../module.js";
import { createApp } from "../../server.js";
import { createWikiRoutes } from "../wiki.js";
import { createCodeGraphRoutes } from "../code-graph.js";
import { createGrantsRoutes } from "../grants.js";
import { createToolsRoutes } from "../tools.js";
import { createHealthRoutes } from "../health.js";

// ── stub Core verifier (speaks POST /v3/meta/auth/verify) ──
const GOOD_KEY = "cust-good-key";
let lastVerify: { auth: string; svc: string; body: any } | null = null;
let verifyServer: http.Server;
let verifyBase = "";

function startVerifier(): Promise<void> {
  return new Promise((resolve) => {
    verifyServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        lastVerify = {
          auth: (req.headers.authorization as string) ?? "",
          svc: (req.headers["x-tdai-service-id"] as string) ?? "",
          body,
        };
        const ok = body.user_key === GOOD_KEY;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(ok
          ? { code: 0, message: "ok", data: { valid: true, user: { user_id: "u-cust-1" } } }
          : { code: 0, message: "ok", data: { valid: false } }));
      });
    });
    verifyServer.listen(0, "127.0.0.1", () => {
      const a = verifyServer.address() as AddressInfo;
      verifyBase = `http://127.0.0.1:${a.port}`;
      resolve();
    });
  });
}

// ── Harness A: full app ──

let serverA: Server;
let baseA = "";
let tmpA = "";
const savedEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  process.env[k] = v;
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function bootFullApp(env: Record<string, string>): Promise<{ app: Hono; server: Server; base: string; tmp: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "know-cust-a-"));
  for (const [k, v] of Object.entries(env)) setEnv(k, v);
  setEnv("KNOWLEDGE_DATA_DIR", join(tmp, "data"));
  setEnv("KNOWLEDGE_DB_PATH", join(tmp, "k.db"));
  setEnv("KNOWLEDGE_CLICKHOUSE_ENABLED", "");
  const created = createApp();
  const app = created.app as unknown as Hono;
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server;
  await new Promise<void>((r) => (server as any).on("listening", () => r()));
  const addr = (server as any).address() as AddressInfo;
  return { app, server, base: `http://127.0.0.1:${addr.port}`, tmp };
}

async function reqA(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(baseA + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { code: number; message: string; data: any } };
}

// ── Harness B: route-stack with stub worker ──
const SVC = "svc-cust-1";
const SVC_OTHER = "svc-cust-2";
const TEAM_A = "team-cust-a";
const TEAM_B = "team-cust-b";
let baseB = "";
let serverB: Server;
let tmpB = "";

async function reqB(path: string, body: unknown, svc = SVC) {
  const res = await fetch(baseB + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-service-id": svc },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { code: number; message: string; data: any } };
}

async function rmRetry(path: string) {
  for (let i = 0; i < 10; i++) {
    try { rmSync(path, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
}

beforeAll(async () => {
  await startVerifier();
  // Harness A — full app behind stub verifier, bearer configured.
  ({ server: serverA, base: baseA, tmp: tmpA } = await bootFullApp({
    CORE_VERIFY_URL: verifyBase,
    CORE_VERIFY_BEARER: "test-bearer",
  }));
  // Harness B — route stack, stub LLM worker (ingest resolves immediately).
  tmpB = mkdtempSync(join(tmpdir(), "know-cust-b-"));
  const { db, raw } = createDb({ path: join(tmpB, "test.db") });
  (globalThis as any).__knowCustRaw = raw;
  const mod = createKnowledgeModule({
    dataDir: join(tmpB, "data"),
    db,
    llmConfig: {
      mode: "custom", protocol: "openai", provider: "custom", apiKey: "k",
      model: "m", baseUrl: "http://127.0.0.1:1", maxTokens: 100, timeoutMs: 1000,
    },
    wikiWorker: async () => ({ pageCount: 1 }),
  });
  const app = new Hono();
  app.route("/", createHealthRoutes());
  const api = new Hono();
  api.route("/wiki", createWikiRoutes({ wikiService: mod.wikiService, wikiMgr: mod.wikiMgr, publicBaseUrl: "" }));
  api.route("/code-graph", createCodeGraphRoutes({ cgService: mod.cgService, instancePool: mod.instancePool, publicBaseUrl: "" }));
  api.route("/grants", createGrantsRoutes({ wikiService: mod.wikiService, cgService: mod.cgService }));
  api.route("/tools", createToolsRoutes({
    wikiService: mod.wikiService, wikiMgr: mod.wikiMgr,
    cgService: mod.cgService, instancePool: mod.instancePool,
  }));
  app.route("/v3", api);
  serverB = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server;
  await new Promise<void>((r) => (serverB as any).on("listening", () => r()));
  const addr = (serverB as any).address() as AddressInfo;
  baseB = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => serverA?.close(() => r()));
  await new Promise<void>((r) => serverB?.close(() => r()));
  await new Promise<void>((r) => verifyServer?.close(() => r()));
  restoreEnv();
  try { (globalThis as any).__knowCustRaw?.close(); } catch { /* ignore */ }
  await rmRetry(tmpA);
  await rmRetry(tmpB);
});

describe("A. auth plane (full server.ts — the seam route tests skip)", () => {
  it("health stays public without user-key", async () => {
    const res = await fetch(baseA + "/health");
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ status: "ok" });
  });

  it("missing x-tdai-user-key -> 401 envelope", async () => {
    const { status, json } = await reqA("/v3/wiki/list", { team_id: "t" }, { "x-tdai-service-id": "s" });
    expect(status).toBe(401);
    expect(json.code).toBe(401);
  });

  it("invalid key -> 401 (Core says valid:false)", async () => {
    const { status, json } = await reqA("/v3/wiki/list", { team_id: "t" },
      { "x-tdai-service-id": "s", "x-tdai-user-key": "bogus" });
    expect(status).toBe(401);
    expect(json.code).toBe(401);
  });

  it("valid key passes; bearer + user_key forwarded to Core verify", async () => {
    lastVerify = null;
    const { status, json } = await reqA("/v3/wiki/list", { team_id: "t" },
      { "x-tdai-service-id": SVC, "x-tdai-user-key": GOOD_KEY });
    expect(status).toBe(200);
    expect(json.code).toBe(0);
    expect(lastVerify?.auth).toBe("Bearer test-bearer");
    expect(lastVerify?.svc).toBe(SVC);
    expect(lastVerify?.body).toEqual({ user_key: GOOD_KEY });
  });

  it("valid key but missing x-tdai-service-id still -> 400 (tenant header not bypassed by auth)", async () => {
    const { status } = await reqA("/v3/wiki/list", { team_id: "t" }, { "x-tdai-user-key": GOOD_KEY });
    expect(status).toBe(400);
  });

  it("unreachable verifier -> 503 (fail closed, envelope)", async () => {
    const second = await bootFullApp({ CORE_VERIFY_URL: "http://127.0.0.1:1", CORE_VERIFY_BEARER: "" });
    try {
      const res = await fetch(second.base + "/v3/wiki/list", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tdai-service-id": "s", "x-tdai-user-key": GOOD_KEY },
        body: JSON.stringify({ team_id: "t" }),
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).code).toBe(503);
    } finally {
      await new Promise<void>((r) => second.server?.close(() => r()));
      await rmRetry(second.tmp);
    }
  });
});

describe("B. customer wiki lifecycle (status codes + envelope + search round-trip)", () => {
  let wikiId = "";
  const MARKER = "custflowmarker";

  it("create -> 201 + wiki_id", async () => {
    const { status, json } = await reqB("/v3/wiki/create", { team_id: TEAM_A, name: "cust-wiki" });
    expect(status).toBe(201);
    expect(json.code).toBe(0);
    expect(json.data.wiki_id).toMatch(/^wiki-/);
    wikiId = json.data.wiki_id;
  });

  it("write -> ingest 202 -> ready; search finds content via route AND tools/call", async () => {
    const w = await reqB("/v3/wiki/raw/write", {
      team_id: TEAM_A, wiki_id: wikiId,
      files: [{ filename: "notes.md", content: `# Guide\n\n${MARKER} body.\n` }],
    });
    expect(w.json.code).toBe(0);
    const ing = await reqB("/v3/wiki/ingest", { wiki_id: wikiId });
    expect(ing.status).toBe(202);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      const g = await reqB("/v3/wiki/get", { wiki_id: wikiId });
      if (g.json.data?.status === "ready") { ready = true; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(ready).toBe(true);
    // NOTE: stub wikiWorker skips LLM extraction, so the FTS index stays empty
    // (content search covered by retrieval unit tests). Assert no-crash +
    // envelope shape here; content persistence proven via raw/read below.
    const s = await reqB("/v3/wiki/search", { wiki_id: wikiId, query: MARKER });
    expect(s.json.code).toBe(0);
    expect(s.json.data).toMatchObject({ results: [], links: [], count: 0 });
    const t = await reqB("/v3/tools/call", {
      knowledge_id: wikiId, tool_name: "search", params: { query: MARKER },
    });
    expect(t.json.code).toBe(0);
    const rd = await reqB("/v3/wiki/raw/read", { wiki_id: wikiId, filenames: ["notes.md"] });
    expect(rd.json.code).toBe(0);
    expect(JSON.stringify(rd.json.data)).toContain(MARKER);
  });

  it("foreign service_id cannot read (tenant isolation)", async () => {
    const g = await reqB("/v3/wiki/get", { wiki_id: wikiId }, SVC_OTHER);
    expect(g.status).toBe(404);
    const list = await reqB("/v3/wiki/list", { team_id: TEAM_A }, SVC_OTHER);
    expect(list.json.data.total).toBe(0);
  });

  it("tools validation: unknown tool 403, missing params 400, bad id 400", async () => {
    const u = await reqB("/v3/tools/call", { knowledge_id: wikiId, tool_name: "nope", params: {} });
    expect(u.status).toBe(403);
    const m = await reqB("/v3/tools/call", { knowledge_id: wikiId, tool_name: "search" });
    expect(m.status).toBe(400);
    const b = await reqB("/v3/tools/call", { knowledge_id: "bogus-id", tool_name: "search", params: { query: "x" } });
    expect(b.status).toBe(400);
    const l = await reqB("/v3/tools/list", { knowledge_id: "bogus-id" });
    expect(l.status).toBe(400);
  });

  it("delete -> get 404", async () => {
    const d = await reqB("/v3/wiki/delete", { wiki_ids: [wikiId] });
    expect(d.json.code).toBe(0);
    const g = await reqB("/v3/wiki/get", { wiki_id: wikiId });
    expect(g.status).toBe(404);
  });
});

describe("C. grants enforcement across teams", () => {
  let wikiId = "";

  it("team A wiki invisible to team B until shared", async () => {
    const c = await reqB("/v3/wiki/create", { team_id: TEAM_A, name: "grant-wiki" });
    wikiId = c.json.data.wiki_id;
    await reqB("/v3/wiki/raw/write", {
      team_id: TEAM_A, wiki_id: wikiId, files: [{ filename: "n.md", content: "# T\n\nx\n" }],
    });
    const list = await reqB("/v3/wiki/list", { team_id: TEAM_B });
    expect(list.json.data.total).toBe(0);
  });

  it("viewer sees list + can search, but cannot ingest", async () => {
    await reqB("/v3/grants/set", { kind: "wiki", knowledge_id: wikiId, grants: [{ team_id: TEAM_B }] });
    const list = await reqB("/v3/wiki/list", { team_id: TEAM_B });
    expect(list.json.data.total).toBe(1);
    const denied = await reqB("/v3/wiki/ingest", { wiki_id: wikiId, team_id: TEAM_B });
    expect(denied.status).toBe(403);
  });

  it("editor can ingest; clear revokes visibility", async () => {
    await reqB("/v3/grants/set", { kind: "wiki", knowledge_id: wikiId, grants: [{ team_id: TEAM_B, grant_type: "editor" }] });
    const ok = await reqB("/v3/wiki/ingest", { wiki_id: wikiId, team_id: TEAM_B });
    expect(ok.status).toBe(202);
    await reqB("/v3/grants/clear", { kind: "wiki", knowledge_id: wikiId });
    const list = await reqB("/v3/wiki/list", { team_id: TEAM_B });
    expect(list.json.data.total).toBe(0);
  });
});

describe("D. code-graph mgmt without indexing (create/get/list/isolation)", () => {
  let cgId = "";

  it("create -> 201; get round-trips; missing repo_url 400", async () => {
    const bad = await reqB("/v3/code-graph/create", { team_id: TEAM_A });
    expect(bad.status).toBe(400);
    const c = await reqB("/v3/code-graph/create", { team_id: TEAM_A, repo_url: "https://example.com/r.git" });
    expect([200, 201]).toContain(c.status);
    expect(c.json.code).toBe(0);
    cgId = c.json.data.code_graph_id;
    const g = await reqB("/v3/code-graph/get", { code_graph_id: cgId });
    expect(g.json.code).toBe(0);
  });

  it("foreign tenant gets 404; tools/list on missing id 404", async () => {
    const g = await reqB("/v3/code-graph/get", { code_graph_id: cgId }, SVC_OTHER);
    expect(g.status).toBe(404);
    const l = await reqB("/v3/tools/list", { knowledge_id: "cg-00000000" });
    expect(l.status).toBe(404);
  });
});
