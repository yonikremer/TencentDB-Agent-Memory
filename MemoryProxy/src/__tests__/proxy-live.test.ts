/**
 * proxy-live.test.ts — real upstream chat completions through OpenAI protocol.
 *
 * Gated on tests/.env key (OPENROUTER_API_KEY or OPENCODE_API_KEY) +
 * LLM_TEST_BASE_URL / LLM_TEST_MODEL. Defaults target Opencode Zen.
 * NOTE: Zen free-tier models are API-blocked ("only in OpenCode"); live runs
 * need a paid model in LLM_TEST_MODEL.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server, AddressInfo } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../server.js";
import { initAuth } from "../auth.js";
import type { ProxyConfig } from "../types.js";

function loadEnv(): void {
  if (process.env.OPENROUTER_API_KEY || process.env.OPENCODE_API_KEY) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const p = join(here, "..", "..", "..", "tests", ".env");
  try {
    if (!existsSync(p)) return;
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env) && (m[2] ?? "").replace(/^["']|["']$/g, "")) {
        process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
      }
    }
  } catch { /* skip */ }
}
loadEnv();

const API_KEY = (process.env.OPENROUTER_API_KEY ?? process.env.OPENCODE_API_KEY ?? "").trim();
const BASE = process.env.LLM_TEST_BASE_URL?.trim() || "https://opencode.ai/zen/v1";
const MODEL = process.env.LLM_TEST_MODEL?.trim() || "nemotron-3.5-lightning-free";
const live = API_KEY && process.env.LLM_LIVE === "1" ? describe : describe.skip;

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
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server;
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
      body: JSON.stringify({ model: MODEL, max_tokens: 32, messages: [{ role: "user", content: "Reply with exactly: live-ok" }] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(JSON.stringify(json)).toContain("live-ok");
  }, 180_000);
});
