/**
 * Org-hierarchy-sync P3 — KS grant tests (TDD). PLAN.md P3 acceptance:
 * list union (owner + grants), grant_type default/persist, enforcement
 * (viewer vs ingest/update/delete), clear revokes.
 *
 * Boots the real wiki + code-graph + grants route stacks on a temp dataDir
 * with a stubbed wiki worker; routing/validation/persistence real.
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
import { createGrantsRoutes } from "../grants.js";
import { createToolsRoutes } from "../tools.js";

const SVC = "svc-grants-1";
const TEAM_A = "team-grants-a";
const TEAM_B = "team-grants-b";
const TEAM_C = "team-grants-c";

let base = "";
let server: Server;
let tmp = "";

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-service-id": SVC },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { code: number; message: string; data: any } };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "know-grants-"));
  const { db, raw } = createDb({ path: join(tmp, "test.db") });
  (globalThis as any).__knowRawGrants = raw;
  const mod = createKnowledgeModule({
    dataDir: join(tmp, "data"),
    db,
    llmConfig: {
      mode: "custom", protocol: "openai", provider: "custom", apiKey: "k",
      model: "m", baseUrl: "http://127.0.0.1:1", maxTokens: 100, timeoutMs: 1000,
    },
    wikiWorker: async () => ({ pageCount: 1 }),
  });
  const app = new Hono();
  const api = new Hono();
  api.route("/wiki", createWikiRoutes({ wikiService: mod.wikiService, wikiMgr: mod.wikiMgr, publicBaseUrl: "" }));
  api.route("/code-graph", createCodeGraphRoutes({
    cgService: mod.cgService, instancePool: mod.instancePool, publicBaseUrl: "",
  }));
  api.route("/grants", createGrantsRoutes({ wikiService: mod.wikiService, cgService: mod.cgService }));
  api.route("/tools", createToolsRoutes({
    wikiService: mod.wikiService, wikiMgr: mod.wikiMgr,
    cgService: mod.cgService, instancePool: mod.instancePool,
  }));
  app.route("/v3", api);
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address();
  base = "http://127.0.0.1:" + (typeof addr === "object" && addr ? addr.port : 0);
}, 60_000);

async function rmRetry(path: string) {
  // Windows holds the SQLite WAL briefly after close; retry before giving up.
  for (let i = 0; i < 10; i++) {
    try { rmSync(path, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
}

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  try { (globalThis as any).__knowRawGrants?.close(); } catch { /* ignore */ }
  await rmRetry(tmp);
});

describe("wiki grants", () => {
  let wikiId = "";

  it("create wiki in team A; invisible to team B", async () => {
    const c = await post("/v3/wiki/create", { team_id: TEAM_A, name: "shared-wiki" });
    expect(c.status).toBe(201);
    wikiId = c.json.data.wiki_id;
    const list = await post("/v3/wiki/list", { team_id: TEAM_B });
    expect(list.json.data.total).toBe(0);
  });

  it("grants/set defaults to viewer and unions into team B list", async () => {
    const s = await post("/v3/grants/set", {
      kind: "wiki", knowledge_id: wikiId, grants: [{ team_id: TEAM_B }],
    });
    expect(s.json.code).toBe(0);
    expect(s.json.data.grants).toEqual([{ team_id: TEAM_B, grant_type: "viewer" }]);
    const list = await post("/v3/wiki/list", { team_id: TEAM_B });
    expect(list.json.data.total).toBe(1);
    const other = await post("/v3/wiki/list", { team_id: TEAM_C });
    expect(other.json.data.total).toBe(0);
  });

  it("viewer cannot ingest or edit metadata; editor can", async () => {
    await post("/v3/wiki/raw/write", {
      team_id: TEAM_A, wiki_id: wikiId, files: [{ filename: "n.md", content: "# T\n\nx\n" }],
    });
    const denied = await post("/v3/wiki/ingest", { wiki_id: wikiId, team_id: TEAM_B });
    expect(denied.status).toBe(403);
    const metaDenied = await post("/v3/wiki/update-meta", {
      wiki_id: wikiId, team_id: TEAM_B, summary: "x",
    });
    expect(metaDenied.status).toBe(403);
    await post("/v3/grants/set", {
      kind: "wiki", knowledge_id: wikiId, grants: [{ team_id: TEAM_B, grant_type: "editor" }],
    });
    const metaOk = await post("/v3/wiki/update-meta", {
      wiki_id: wikiId, team_id: TEAM_B, summary: "shared summary",
    });
    expect(metaOk.json.code).toBe(0);
    const ingestOk = await post("/v3/wiki/ingest", { wiki_id: wikiId, team_id: TEAM_B });
    expect(ingestOk.status).toBe(202);
  });

  it("viewer cannot delete; owner team outranks explicit grants", async () => {
    const denied = await post("/v3/wiki/delete", { wiki_ids: [wikiId], team_id: TEAM_B });
    expect(denied.json.data.deleted_ids).toEqual([]);
    expect(denied.json.data.failed).toHaveLength(1);
    // explicit viewer row on the OWNER team does not demote it
    await post("/v3/grants/set", {
      kind: "wiki", knowledge_id: wikiId, grants: [{ team_id: TEAM_A, grant_type: "viewer" }],
    });
    const del = await post("/v3/wiki/delete", { wiki_ids: [wikiId], team_id: TEAM_A });
    expect(del.json.data.deleted_ids).toEqual([wikiId]);
  });

  it("grants/clear removes rows; list drops immediately", async () => {
    const c = await post("/v3/wiki/create", { team_id: TEAM_A, name: "shared-wiki-2" });
    const id2 = c.json.data.wiki_id;
    await post("/v3/grants/set", {
      kind: "wiki", knowledge_id: id2, grants: [{ team_id: TEAM_B }, { team_id: TEAM_C }],
    });
    expect((await post("/v3/wiki/list", { team_id: TEAM_B })).json.data.total).toBe(1);
    const clear = await post("/v3/grants/clear", { kind: "wiki", knowledge_id: id2 });
    expect(clear.json.data.cleared).toBe(2);
    expect((await post("/v3/wiki/list", { team_id: TEAM_B })).json.data.total).toBe(0);
    expect((await post("/v3/wiki/list", { team_id: TEAM_A })).json.data.total).toBe(1);
  });

  it("shared mutations require team_id; unshared keep legacy behavior", async () => {
    const c = await post("/v3/wiki/create", { team_id: TEAM_A, name: "legacy-wiki" });
    const legacyId = c.json.data.wiki_id;
    await post("/v3/wiki/raw/write", {
      team_id: TEAM_A, wiki_id: legacyId, files: [{ filename: "n.md", content: "# T\n\nx\n" }],
    });
    // unshared: no team → legacy owner caps
    expect((await post("/v3/wiki/ingest", { wiki_id: legacyId })).status).toBe(202);
    // shared: no team → 403 even for owner-team callers
    await post("/v3/grants/set", {
      kind: "wiki", knowledge_id: legacyId, grants: [{ team_id: TEAM_B }],
    });
    expect((await post("/v3/wiki/ingest", { wiki_id: legacyId })).status).toBe(403);
    expect((await post("/v3/wiki/update-meta", { wiki_id: legacyId, summary: "x" })).status).toBe(403);
    const del = await post("/v3/wiki/delete", { wiki_ids: [legacyId] });
    expect(del.json.data.deleted_ids).toEqual([]);
    // owner team explicit → allowed again
    expect((await post("/v3/wiki/ingest", { wiki_id: legacyId, team_id: TEAM_A })).status).toBe(202);
  });

  it("tools/list is team-scoped when team_id given", async () => {
    const c = await post("/v3/wiki/create", { team_id: TEAM_A, name: "tools-wiki" });
    const toolsId = c.json.data.wiki_id;
    await post("/v3/grants/set", {
      kind: "wiki", knowledge_id: toolsId, grants: [{ team_id: TEAM_B }],
    });
    expect((await post("/v3/tools/list", { knowledge_id: toolsId })).json.code).toBe(0);
    expect((await post("/v3/tools/list", { knowledge_id: toolsId, team_id: TEAM_B })).json.code).toBe(0);
    expect((await post("/v3/tools/list", { knowledge_id: toolsId, team_id: TEAM_C })).status).toBe(404);
    const gl = await post("/v3/grants/list", { kind: "wiki", knowledge_id: toolsId });
    expect(gl.json.data.grants).toEqual([{ team_id: TEAM_B, grant_type: "viewer" }]);
  });

  it("validation: bad kind / grant_type / unknown id", async () => {
    expect((await post("/v3/grants/set", {
      kind: "nope", knowledge_id: "wiki-x", grants: [{ team_id: TEAM_B }],
    })).status).toBe(400);
    expect((await post("/v3/grants/set", {
      kind: "wiki", knowledge_id: "wiki-x", grants: [{ team_id: TEAM_B, grant_type: "super" }],
    })).status).toBe(400);
    expect((await post("/v3/grants/set", {
      kind: "wiki", knowledge_id: "wiki-does-not-exist", grants: [{ team_id: TEAM_B }],
    })).json.code).toBe(404);
  });
});

describe("code-graph grants", () => {
  let cgId = "";

  it("create in team A; set/clear unions team B list", async () => {
    const c = await post("/v3/code-graph/create", {
      team_id: TEAM_A, repo_url: "https://example.com/r.git", branch: "main",
    });
    expect(c.json.code).toBe(0);
    cgId = c.json.data.code_graph_id;
    expect((await post("/v3/code-graph/list", { team_id: TEAM_B })).json.data.total).toBe(0);
    await post("/v3/grants/set", {
      kind: "code-graph", knowledge_id: cgId, grants: [{ team_id: TEAM_B, grant_type: "editor" }],
    });
    expect((await post("/v3/code-graph/list", { team_id: TEAM_B })).json.data.total).toBe(1);
    const clear = await post("/v3/grants/clear", {
      kind: "code-graph", knowledge_id: cgId, team_ids: [TEAM_B],
    });
    expect(clear.json.data.cleared).toBe(1);
    expect((await post("/v3/code-graph/list", { team_id: TEAM_B })).json.data.total).toBe(0);
  });

  it("viewer cannot edit metadata or delete; editor cannot delete", async () => {
    await post("/v3/grants/set", {
      kind: "code-graph", knowledge_id: cgId, grants: [{ team_id: TEAM_B, grant_type: "viewer" }],
    });
    expect((await post("/v3/code-graph/update-meta", {
      code_graph_id: cgId, team_id: TEAM_B, summary: "x",
    })).status).toBe(403);
    expect((await post("/v3/code-graph/delete", { code_graph_ids: [cgId], team_id: TEAM_B })).json.data.deleted_ids).toEqual([]);
    await post("/v3/grants/clear", { kind: "code-graph", knowledge_id: cgId });
  });
});
