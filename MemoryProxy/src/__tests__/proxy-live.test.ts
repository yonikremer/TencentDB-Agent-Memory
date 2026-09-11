/**
 * proxy-live.test.ts — real upstream chat completions through OpenAI protocol.
 *
 * Config from tests/helpers/live-llm-env.ts (OPENROUTER_API_KEY,
 * LLM_TEST_BASE_URL / LLM_TEST_MODEL overrides, LLM_LIVE=1 opt-in).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server, AddressInfo } from "node:net";
import { loadLiveLlmConfig } from "../../../tests/helpers/live-llm-env.js";

import { createApp } from "../server.js";
import { initAuth } from "../auth.js";
import type { ProxyConfig } from "../types.js";

// Shared live-LLM config: key + endpoint + model + LLM_LIVE opt-in gate.
const LIVE = loadLiveLlmConfig();
const API_KEY = LIVE.key;
const BASE = LIVE.baseUrl;
const MODEL = LIVE.model;
const live = LIVE.live ? describe : describe.skip;

let base = "";
let server: Server;

function cfg(): ProxyConfig {
  return {
    costGuard: { enabled: false, markerOptIn: false, options: {} },
    storage: { enabled: false },
    upstream: { url: BASE, apiKey: API_KEY, agents: {} },
    opik: { enabled: false },
    rateLimit: { tpm: 0, qpm: 0 },
    admin: { apiKey: "" },
    tdai: { enabled: false },
    langfuse: { enabled: false },
    clickhouse: { enabled: false },
    log: { level: "error" },
    server: { host: "127.0.0.1", port: 0, forwardTimeoutMs: 120_000 },
  } as unknown as ProxyConfig;
}

beforeAll(async () => {
  if (!API_KEY) return;
  initAuth({ enabled: false } as never);
  const app: Hono = createApp(cfg());
  server = serve({
    fetch: app.fetch,
    port: 0,
    hostname: "127.0.0.1",
  }) as unknown as Server;
  await new Promise<void>((r) => (server as any).on("listening", () => r()));
  const addr = (server as any).address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  if (!API_KEY) return;
  await new Promise<void>((r) => server?.close(() => r()));
});

live("live upstream chat completions (OpenAI protocol)", () => {
  it("relays a real model reply", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 32,
        messages: [{ role: "user", content: "Reply with exactly: live-ok" }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(JSON.stringify(json)).toContain("live-ok");
  }, 180_000);
});
