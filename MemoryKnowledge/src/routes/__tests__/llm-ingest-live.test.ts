/**
 * llm-ingest-live.test.ts — real LLM ingest through an OpenAI-compatible endpoint.
 *
 * Default: Opencode Zen nemotron-3.5-lightning-free (user key is Zen).
 * Override via tests/.env LLM_BASE_URL + LLM_MODEL for real OpenRouter
 * (model nvidia/nemotron-3.5-lightning:free). Key in tests/.env (gitignored,
 * NEVER committed). Without a key the suite skips.
 *
 * Customer value: stub-worker suites prove routing/persistence but never that
 * a real model turns source files into searchable pages. This closes that.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server, AddressInfo } from "node:net";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createDb } from "../../db/client.js";
import { createKnowledgeModule } from "../../module.js";
import { createWikiRoutes } from "../wiki.js";
import { createLlmBindingRoutes } from "../llm-binding.js";

const SVC_BYO = "svc-live-byo";

// tests/.env values load first so MODEL/ENDPOINT below respect them.
function loadTestEnvFile(): void {
  if (process.env.OPENROUTER_API_KEY || process.env.OPENCODE_API_KEY) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, "..", "..", "..", "..", "tests", ".env");
  try {
    if (!existsSync(envPath)) return;
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env) && (m[2] ?? "").replace(/^["']|["']$/g, "")) {
        process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* missing file = skip */
  }
}
loadTestEnvFile();
const MODEL = process.env.LLM_TEST_MODEL?.trim() || "nemotron-3.5-lightning-free";
const ENDPOINT = process.env.LLM_TEST_BASE_URL?.trim() || "https://opencode.ai/zen/v1";
const SVC = "svc-live-1";
const TEAM = "team-live-1";

export function loadTestKey(): string {
  // loadTestEnvFile already merged tests/.env into process.env.
  return (process.env.OPENROUTER_API_KEY ?? process.env.OPENCODE_API_KEY ?? "").trim();
}

const API_KEY = loadTestKey();
// Live runs cost money / hit rate limits: explicit opt-in even with a key.
const live = API_KEY && process.env.LLM_LIVE === "1" ? describe : describe.skip;

let base = "";
let server: Server;
let baseByo = "";
let serverByo: Server;
let tmp = "";

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-service-id": SVC },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as { code: number; message: string; data: any },
  };
}

async function rmRetry(path: string) {
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

beforeAll(async () => {
  if (!API_KEY) return;
  tmp = mkdtempSync(join(tmpdir(), "know-live-"));
  const { db, raw } = createDb({ path: join(tmp, "test.db") });
  (globalThis as any).__knowLiveRaw = raw;
  // No wikiWorker stub: real LLM worker via OpenRouter custom endpoint.
  const mod = createKnowledgeModule({
    dataDir: join(tmp, "data"),
    db,
    llmConfig: {
      mode: "custom",
      protocol: "openai",
      provider: "custom",
      apiKey: API_KEY,
      model: MODEL,
      baseUrl: ENDPOINT,
      maxTokens: 8192,
      timeoutMs: 300000,
    },
  });
  const app = new Hono();
  const api = new Hono();
  api.route(
    "/wiki",
    createWikiRoutes({
      wikiService: mod.wikiService,
      wikiMgr: mod.wikiMgr,
      publicBaseUrl: "",
    }),
  );
  app.route("/v3", api);
  server = serve({
    fetch: app.fetch,
    port: 0,
    hostname: "127.0.0.1",
  }) as unknown as Server;
  await new Promise<void>((r) => (server as any).on("listening", () => r()));
  const addr = (server as any).address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  // Second module: proxy mode + blank global creds. Only a byo binding can
  // make ingest work here — proves the binding path end to end.
  const modByo = createKnowledgeModule({
    dataDir: join(tmp, "data-byo"),
    db,
    llmConfig: {
      mode: "proxy", protocol: "openai", provider: "custom", apiKey: "",
      model: MODEL, baseUrl: "", maxTokens: 8192, timeoutMs: 300000,
    },
  });
  modByo.llmBindingStore.upsert(SVC_BYO, { mode: "byo", base_url: ENDPOINT, api_key: API_KEY });
  const app2 = new Hono();
  const api2 = new Hono();
  api2.route("/wiki", createWikiRoutes({ wikiService: modByo.wikiService, wikiMgr: modByo.wikiMgr, publicBaseUrl: "" }));
  api2.route("/internal/llm-binding", createLlmBindingRoutes({ llmBindingStore: modByo.llmBindingStore }));
  app2.route("/v3", api2);
  serverByo = serve({ fetch: app2.fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server;
  await new Promise<void>((r) => (serverByo as any).on("listening", () => r()));
  const addr2 = (serverByo as any).address() as AddressInfo;
  baseByo = `http://127.0.0.1:${addr2.port}`;
}, 60_000);

async function postByo(path: string, body: unknown) {
  const res = await fetch(baseByo + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-service-id": SVC_BYO },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { code: number; message: string; data: any } };
}

afterAll(async () => {
  if (!API_KEY) return;
  await new Promise<void>((r) => server?.close(() => r()));
  await new Promise<void>((r) => serverByo?.close(() => r()));
  try {
    (globalThis as any).__knowLiveRaw?.close();
  } catch {
    /* ignore */
  }
  await rmRetry(tmp);
});

live("live LLM ingest (OpenRouter nemotron, tiny doc)", () => {
  let wikiId = "";

  it("create + write small source file", async () => {
    const c = await post("/v3/wiki/create", {
      team_id: TEAM,
      name: "live-wiki",
    });
    expect(c.status).toBe(201);
    wikiId = c.json.data.wiki_id;
    const w = await post("/v3/wiki/raw/write", {
      team_id: TEAM,
      wiki_id: wikiId,
      files: [
        {
          filename: "guide.md",
          content: "# Koi Care\n\nKoi needs cold clean water and shade.\n",
        },
      ],
    });
    expect(w.json.code).toBe(0);
  });

  it("ingest reaches ready with real model (up to 8 min on free tier)", async () => {
    const ing = await post("/v3/wiki/ingest", { wiki_id: wikiId });
    expect(ing.status).toBe(202);
    let detail: any = null;
    for (let i = 0; i < 160; i++) {
      const g = await post("/v3/wiki/get", { wiki_id: wikiId });
      expect(g.json.code).toBe(0);
      detail = g.json.data;
      if (detail.status === "ready" || detail.status === "failed") break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    expect(detail.status).toBe("ready");
    expect(detail.page_count).toBeGreaterThan(0);
  }, 500_000);

  it("model output searchable (extraction round-trips content)", async () => {
    const s = await post("/v3/wiki/search", {
      wiki_id: wikiId,
      query: "koi water",
    });
    expect(s.json.code).toBe(0);
    expect(s.json.data.count).toBeGreaterThan(0);
    expect(JSON.stringify(s.json.data)).toContain("koi");
  });
});

live("live LLM ingest via byo binding (proxy mode, no global creds)", () => {
  let wikiId = "";

  it("binding status bound without leaking key", async () => {
    const st = await postByo("/v3/internal/llm-binding/status", {});
    expect(st.json.data).toMatchObject({ bound: true, mode: "byo" });
  });

  it("ingest resolves key from binding and reaches ready", async () => {
    const c = await postByo("/v3/wiki/create", { team_id: TEAM, name: "live-byo" });
    expect(c.status).toBe(201);
    wikiId = c.json.data.wiki_id;
    const w = await postByo("/v3/wiki/raw/write", {
      team_id: TEAM, wiki_id: wikiId,
      files: [{ filename: "guide.md", content: "# Tea\n\nBrew green tea below boiling.\n" }],
    });
    expect(w.json.code).toBe(0);
    const ing = await postByo("/v3/wiki/ingest", { wiki_id: wikiId });
    expect(ing.status).toBe(202);
    let detail: any = null;
    for (let i = 0; i < 160; i++) {
      const g = await postByo("/v3/wiki/get", { wiki_id: wikiId });
      detail = g.json.data;
      if (detail.status === "ready" || detail.status === "failed") break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    expect(detail.status).toBe("ready");
    const s = await postByo("/v3/wiki/search", { wiki_id: wikiId, query: "tea brew" });
    expect(s.json.data.count).toBeGreaterThan(0);
  }, 500_000);
});
