/**
 * wiki-guide-flow.test.ts — guide section 3 regression tests.
 *
 * Covers what docs/research-team-setup.md promises a dumb agent:
 * create -> raw/write (incl. nested subdirs) -> ingest -> share-ready state.
 * Boots the real wiki route stack on a temp dataDir with a stubbed LLM
 * worker (ingest returns immediately); routing/validation/persistence real.
 *
 * Regression history:
 * - raw/write rejected every file on Windows (resolveRawPath compared
 *   resolve() backslash paths against a hardcoded "/" suffix).
 * - nested filenames (docs/x.md) died with ENOENT (no parent mkdir).
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
import { createHealthRoutes } from "../health.js";

const SVC = "svc-guide-1";
const TEAM = "team-guide-1";

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
  tmp = mkdtempSync(join(tmpdir(), "know-guide-"));
  const { db, raw } = createDb({ path: join(tmp, "test.db") });
  (globalThis as any).__knowRaw = raw;
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
  app.route("/", createHealthRoutes());
  const api = new Hono();
  api.route("/wiki", createWikiRoutes({ wikiService: mod.wikiService, wikiMgr: mod.wikiMgr, publicBaseUrl: "" }));
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
  try { (globalThis as any).__knowRaw?.close(); } catch { /* ignore */ }
  await rmRetry(tmp);
});

describe("guide section 3: wiki create -> files -> ingest", () => {
  let wikiId = "";

  it("create returns wiki_id", async () => {
    const { status, json } = await post("/v3/wiki/create", { team_id: TEAM, name: "guide-wiki" });
    expect(status).toBe(201);
    expect(json.code).toBe(0);
    wikiId = json.data.wiki_id;
    expect(wikiId).toMatch(/^wiki-/);
  });

  it("raw/write accepts root + nested subdir files (parent dirs created)", async () => {
    const { status, json } = await post("/v3/wiki/raw/write", {
      team_id: TEAM, wiki_id: wikiId,
      files: [
        { filename: "notes.md", content: "# Topic\n\nBody.\n" },
        { filename: "docs/extra.md", content: "# More\n\nSubdir.\n" },
      ],
    });
    expect(status).toBe(200);
    expect(json.code).toBe(0);
    const ls = await post("/v3/wiki/raw/ls", { wiki_id: wikiId });
    const names = ls.json.data.items.map((i: any) => i.filename);
    expect(names).toContain("notes.md");
    expect(names).toContain("docs/extra.md");
    const rd = await post("/v3/wiki/raw/read", { wiki_id: wikiId, filenames: ["docs/extra.md"] });
    expect(JSON.stringify(rd.json.data)).toContain("Subdir");
  });

  it("traversal filename rejected, batch atomic (good file not written)", async () => {
    const w = await post("/v3/wiki/create", { team_id: TEAM, name: "guide-evil" });
    const evilId = w.json.data.wiki_id;
    const bad = await post("/v3/wiki/raw/write", {
      team_id: TEAM, wiki_id: evilId,
      files: [
        { filename: "../evil.md", content: "x" },
        { filename: "good.md", content: "x" },
      ],
    });
    expect(bad.status).toBe(400);
    const ls = await post("/v3/wiki/raw/ls", { wiki_id: evilId });
    expect(ls.json.data.items).toEqual([]);
  });

  it("ingest empty wiki -> 400; with sources -> 202 + status leaves draft", async () => {
    const w = await post("/v3/wiki/create", { team_id: TEAM, name: "guide-empty" });
    const emptyId = w.json.data.wiki_id;
    const noSrc = await post("/v3/wiki/ingest", { wiki_id: emptyId });
    expect(noSrc.status).toBe(400);
    const ok = await post("/v3/wiki/ingest", { wiki_id: wikiId });
    expect(ok.status).toBe(202);
    expect(ok.json.data.wiki_id).toBe(wikiId);
  });

  it("poll wiki/get reaches ready (stubbed LLM worker)", async () => {
    let detail: any = null;
    for (let i = 0; i < 100; i++) {
      const g = await post("/v3/wiki/get", { wiki_id: wikiId });
      expect(g.json.code).toBe(0);
      detail = g.json.data;
      if (detail.status === "ready" || detail.status === "failed") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(detail.status).toBe("ready");
    expect(detail.page_count).toBe(1);
  });
});
