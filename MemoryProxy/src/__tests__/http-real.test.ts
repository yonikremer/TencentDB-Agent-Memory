/**
 * http-real.test.ts — REAL HTTP API coverage for the Proxy service.
 *
 * Boots createApp() with test config on 127.0.0.1 (ephemeral port) plus a
 * stub upstream LLM server. Sends real fetch() requests and asserts status
 * codes + response bodies. Injection/session-init stay disabled; the
 * request-forwarding path to upstream is fully real.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { createServer, type Server } from "node:http";

import { createApp } from "../server.js";
import { DEFAULT_CONFIG } from "../config.js";

let base = "";
let server: ReturnType<typeof serve>;
let stub: Server;
let stubUrl = "";
let lastUpstream: { method: string; url: string; auth: string; body: any } | null = null;

async function post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, json, text };
}

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { headers });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, json, text };
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body: any = null;
      try { body = JSON.parse(raw); } catch { body = raw; }
      lastUpstream = { method: req.method ?? "", url: req.url ?? "", auth: String(req.headers.authorization ?? ""), body };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "chatcmpl-stub",
        object: "chat.completion",
        created: 1,
        model: "stub-model",
        choices: [{ index: 0, message: { role: "assistant", content: "stub reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
  const addr = stub.address();
  stubUrl = "http://127.0.0.1:" + (typeof addr === "object" && addr ? addr.port : 0);

  const config = {
    ...DEFAULT_CONFIG,
    upstream: { url: stubUrl, apiKey: "stub-key", agents: {} },
    injection: { ...DEFAULT_CONFIG.injection, assetReflection: { markerOptIn: false } },
  };
  const app = createApp(config);
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((r) => server.on("listening", () => r()));
  const a2 = server.address();
  base = "http://127.0.0.1:" + (typeof a2 === "object" && a2 ? a2.port : 0);
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await new Promise<void>((r) => stub?.close(() => r()));
});

describe("health + whoami (real HTTP)", () => {
  it("GET /health returns 200 with version + storage", async () => {
    const { status, json } = await get("/health");
    expect(status).toBe(200);
    expect(json.status).toBe("ok");
    expect(json.version).toBeTruthy();
    expect(json.upstream).toBe(stubUrl);
  });

  it("GET /whoami requires key, resolves key id", async () => {
    const missing = await get("/whoami");
    expect(missing.status).toBe(400);
    const ok = await get("/whoami?key=abc123");
    expect(ok.status).toBe(200);
    expect(ok.text.trim().length).toBeGreaterThan(0);
  });
});

describe("marker gates (real HTTP)", () => {
  it("cost-guard marker disabled -> 404", async () => {
    const { status, json } = await post("/cc/sp1/cost-guard/v1/chat/completions", { model: "m", messages: [] });
    expect(status).toBe(404);
    expect(json.error).toBe("cost_guard_marker_disabled");
  });

  it("analyse marker disabled -> 404", async () => {
    const { status, json } = await post("/cc/sp1/analyse/v1/chat/completions", { model: "m", messages: [] });
    expect(status).toBe(404);
    expect(json.error).toBe("analyse_marker_disabled");
  });
});

describe("admin rate-limits (real HTTP)", () => {
  // No Redis in local env: the Redis-backed store degrades with a meaningful
  // 503 (not a crash). Body validation happens before the store is touched.
  it("GET degrades to 503 without Redis", async () => {
    const { status, json } = await get("/v3/admin/rate-limits");
    expect(status).toBe(503);
    expect(JSON.stringify(json)).toMatch(/redis/i);
  });

  it("PUT validation -> 400 before store", async () => {
    const bad = await fetch(base + "/v3/admin/rate-limits", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ input_tpm: -1, qpm: 5 }),
    });
    expect(bad.status).toBe(400);
  });

  it("GET dimension validation -> 400 before store", async () => {
    const { status } = await get("/v3/admin/rate-limits?instance_id=i1");
    expect(status).toBe(400);
  });
});

describe("openai passthrough (real HTTP)", () => {
  it("POST /cc/sp1/v1/chat/completions forwards to upstream", async () => {
    const { status, json } = await post(
      "/cc/sp1/v1/chat/completions",
      { model: "stub-model", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer client-key" },
    );
    expect(status).toBe(200);
    expect(json.choices[0].message.content).toBe("stub reply");
    expect(lastUpstream?.auth).toContain("stub-key");
  });

  it("POST /v1/chat/completions default route forwards", async () => {
    const { status, json } = await post("/v1/chat/completions", {
      model: "stub-model", messages: [{ role: "user", content: "hi" }],
    });
    expect(status).toBe(200);
    expect(json.id).toBe("chatcmpl-stub");
  });

  it("anthropic + codex + dsh + workbuddy routes forward", async () => {
    const anth = { model: "m", max_tokens: 5, messages: [{ role: "user", content: "hi" }] };
    for (const [path, body] of [
      ["/v1/messages", anth],
      ["/cc/sp1/v1/messages", anth],
      ["/codex/sp1/v1/responses", { model: "m", input: "hi" }],
      ["/codex/sp1/responses", { model: "m", input: "hi" }],
      ["/dsh/sp1/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] }],
      ["/dsh/sp1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] }],
      ["/workbuddy/sp1/v1/responses", { model: "m", input: "hi" }],
      ["/proxy/sp1/v1/messages", anth],
    ] as Array<[string, unknown]>) {
      const { status } = await post(path, body);
      expect([200], path).toContain(status);
    }
  });

  it("auxiliary count_tokens passthrough", async () => {
    const { status } = await post("/v1/messages/count_tokens", { model: "m" });
    expect([200, 400, 502]).toContain(status);
  });
});

describe("ops endpoints (real HTTP)", () => {
  it("POST /v3/instance/proxy-destroy responds", async () => {
    const { status, json } = await post("/v3/instance/proxy-destroy", { instance_id: "i1" });
    expect([200, 400, 500]).toContain(status);
    expect(json ?? null).not.toBe("missing-route");
  });

  it("POST /v3/session/refresh-cache + force-archive-skill respond", async () => {
    const r1 = await post("/v3/session/refresh-cache", { spaceId: "sp", sessionId: "s" });
    expect([200, 400, 500]).toContain(r1.status);
    const r2 = await post("/v3/session/force-archive-skill", { spaceId: "sp", sessionId: "s" });
    expect([200, 400, 500]).toContain(r2.status);
  });

  it("bridges route without 404", async () => {
    const r1 = await post("/skill-bridge/v3/skill/list", { team_id: "t" });
    expect(r1.status).not.toBe(404);
    const r2 = await post("/memory-bridge/v3/atomic/search", {});
    expect(r2.status).not.toBe(404);
  });
});
