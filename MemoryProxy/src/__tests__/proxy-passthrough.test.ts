/**
 * proxy-passthrough.test.ts — POST /v1/messages against a fake upstream.
 *
 * The highest-risk Proxy seam: real createApp + real handler, auth disabled,
 * memory/recall off, upstream = localhost stub. Asserts body passthrough,
 * upstream auth header injection, response relay, and clean 5xx mapping
 * (never a hang) when upstream fails.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import http, { type IncomingMessage } from "node:http";
import type { Server, AddressInfo } from "node:net";

import { createApp } from "../server.js";
import { initAuth } from "../auth.js";
import type { ProxyConfig } from "../types.js";

const UPSTREAM_MODEL = "fake-model-1";
let upstreamBase = "";
let upstream: http.Server;
let upstreamMode: "ok" | "error" = "ok";
const upstreamSeen: Array<{ url: string; key: string; body: any }> = [];

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => { buf += c; });
    req.on("end", () => resolve(buf ? JSON.parse(buf) : {}));
  });
}

async function startUpstream(): Promise<void> {
  upstream = http.createServer(async (req, res) => {
    const body = await readBody(req);
    upstreamSeen.push({ url: req.url ?? "", key: (req.headers["x-api-key"] as string) ?? "", body });
    res.setHeader("content-type", "application/json");
    if (upstreamMode === "error") {
      res.writeHead(500);
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "fake boom" } }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({
      id: "msg_fake1", type: "message", role: "assistant", model: UPSTREAM_MODEL,
      content: [{ type: "text", text: "fake upstream reply" }],
      stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 4 },
    }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const addr = upstream.address() as AddressInfo;
  upstreamBase = `http://127.0.0.1:${addr.port}/v1`;
}

let base = "";
let server: Server;

function cfg(): ProxyConfig {
  return {
    costGuard: { enabled: false, markerOptIn: false, options: {} },
    storage: { enabled: false },
    upstream: { url: upstreamBase, apiKey: "fake-upstream-key", agents: {} },
    opik: { enabled: false },
    rateLimit: { tpm: 0, qpm: 0 },
    admin: { apiKey: "" },
    tdai: { enabled: false },
    langfuse: { enabled: false },
    clickhouse: { enabled: false },
    log: { level: "error" },
    server: { host: "127.0.0.1", port: 0, forwardTimeoutMs: 30_000 },
  } as unknown as ProxyConfig;
}

async function messages(body: unknown) {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

const REQ = { model: UPSTREAM_MODEL, max_tokens: 16, messages: [{ role: "user", content: "ping" }] };

beforeAll(async () => {
  await startUpstream();
  initAuth({ enabled: false } as never);
  const app: Hono = createApp(cfg());
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server;
  await new Promise<void>((r) => (server as any).on("listening", () => r()));
  const addr = (server as any).address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await new Promise<void>((r) => upstream?.close(() => r()));
});

describe("POST /v1/messages passthrough (fake upstream)", () => {
  it("relays upstream reply body to client", async () => {
    upstreamMode = "ok";
    upstreamSeen.length = 0;
    const r = await messages(REQ);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).toContain("fake upstream reply");
  });

  it("forwards model + messages and injects upstream auth", async () => {
    upstreamMode = "ok";
    upstreamSeen.length = 0;
    await messages(REQ);
    expect(upstreamSeen).toHaveLength(1);
    expect(upstreamSeen[0].url).toContain("/messages");
    expect(upstreamSeen[0].body.model).toBe(UPSTREAM_MODEL);
    expect(upstreamSeen[0].key).toBe("fake-upstream-key");
  });

  it("upstream 500 -> clean error status, never a hang", async () => {
    upstreamMode = "error";
    const r = await messages(REQ);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});
