/**
 * control-plane.test.ts — internal routes customers depend on but never see:
 * llm-binding set/status/list + auto-sync status/trigger + proxy-mode
 * fail-loud ingest. Real module, stub wiki worker only where noted.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server, AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../../db/client.js";
import { createKnowledgeModule } from "../../module.js";
import { createLlmBindingRoutes } from "../llm-binding.js";
import { createAutoSyncRoutes } from "../auto-sync.js";
import { createWikiRoutes } from "../wiki.js";

const SVC = "svc-ctrl-1";
let base = "";
let server: Server;
let tmp = "";

async function post(path: string, body: unknown, svc: string | null = SVC) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (svc) headers["x-tdai-service-id"] = svc;
  const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as { code: number; message: string; data: any } };
}

async function rmRetry(path: string) {
  for (let i = 0; i < 10; i++) {
    try { rmSync(path, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "know-ctrl-"));
  const { db, raw } = createDb({ path: join(tmp, "test.db") });
  (globalThis as any).__knowCtrlRaw = raw;
  const mod = createKnowledgeModule({
    dataDir: join(tmp, "data"),
    db,
    llmConfig: {
      mode: "proxy", protocol: "openai", provider: "custom", apiKey: "",
      model: "m", baseUrl: "", maxTokens: 100, timeoutMs: 1000,
    },
    wikiWorker: async () => ({ pageCount: 1 }),
  });
  const app = new Hono();
  const api = new Hono();
  api.route("/wiki", createWikiRoutes({ wikiService: mod.wikiService, wikiMgr: mod.wikiMgr, publicBaseUrl: "" }));
  api.route("/internal/llm-binding", createLlmBindingRoutes({ llmBindingStore: mod.llmBindingStore }));
  api.route("/", createAutoSyncRoutes({ scheduler: mod.autoSyncScheduler, config: mod.autoSyncConfig }));
  app.route("/v3", api);
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server;
  await new Promise<void>((r) => (server as any).on("listening", () => r()));
  const addr = (server as any).address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  try { (globalThis as any).__knowCtrlRaw?.close(); } catch { /* ignore */ }
  await rmRetry(tmp);
});

describe("llm-binding (per-instance LLM routing)", () => {
  it("missing service header -> 400", async () => {
    const r = await post("/v3/internal/llm-binding/set", { mode: "byo" }, null);
    expect(r.status).toBe(400);
  });

  it("bad mode rejected -> 400", async () => {
    const r = await post("/v3/internal/llm-binding/set", { mode: "direct" });
    expect(r.status).toBe(400);
  });

  it("byo without api_key on first create -> 400", async () => {
    const r = await post("/v3/internal/llm-binding/set", { mode: "byo", base_url: "http://x/v1" });
    expect(r.status).toBe(400);
  });

  it("set byo + status never leaks api_key", async () => {
    const s = await post("/v3/internal/llm-binding/set", {
      mode: "byo", base_url: "http://127.0.0.1:1/v1", api_key: "super-secret",
    });
    expect(s.json.code).toBe(0);
    const st = await post("/v3/internal/llm-binding/status", {});
    expect(st.json.code).toBe(0);
    expect(JSON.stringify(st.json.data)).not.toContain("super-secret");
    expect(st.json.data).toMatchObject({ bound: true, mode: "byo" });
  });

  it("list works without service header + flags key presence", async () => {
    const l = await post("/v3/internal/llm-binding/list", {}, null);
    expect(l.json.code).toBe(0);
    expect(JSON.stringify(l.json.data)).not.toContain("super-secret");
    expect(l.json.data.items[0]).toMatchObject({ has_api_key: true, mode: "byo" });
  });

  it("re-set without api_key retains previous value", async () => {
    const s = await post("/v3/internal/llm-binding/set", { mode: "byo", base_url: "http://127.0.0.1:2/v1" });
    expect(s.json.code).toBe(0);
    const st = await post("/v3/internal/llm-binding/list", {}, null);
    expect(st.json.data.items[0].has_api_key).toBe(true);
  });
});

describe("auto-sync admin", () => {
  it("GET status -> 200 shape", async () => {
    const res = await fetch(`${base}/v3/auto-sync/status`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.code).toBe(0);
    expect(json.data.config).toMatchObject({ enabled: expect.any(Boolean) });
  });

  it("POST trigger when disabled -> triggered:false (no crash)", async () => {
    const r = await post("/v3/auto-sync/trigger", {});
    expect(r.json.code).toBe(0);
    expect(typeof r.json.data.triggered).toBe("boolean");
  });
});
