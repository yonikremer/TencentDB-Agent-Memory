/**
 * customer-integration.test.ts — Proxy seams customers hit first.
 *
 * Boots the real createApp() with fake config (storage off, no upstream) and
 * asserts: health shape, whoami auth, /cost-guard + /analyse marker gating
 * (markerOptIn=false must 404, never fall through to upstream), and
 * /v3/instance/proxy-destroy admin auth. No network beyond localhost.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:net";
import type { AddressInfo } from "node:net";

import { createApp } from "../server.js";
import { initAuth } from "../auth.js";
import type { ProxyConfig } from "../types.js";

let base = "";
let server: Server;

function cfg(): ProxyConfig {
  return {
    costGuard: { enabled: false, markerOptIn: false, options: {} },
    storage: { enabled: false },
    upstream: { url: "", agents: {} },
    opik: { enabled: false },
    rateLimit: { tpm: 0, qpm: 0 },
    admin: { apiKey: "test-admin-key" },
  } as unknown as ProxyConfig;
}

beforeAll(async () => {
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
  await new Promise<void>((r) => server?.close(() => r()));
});

describe("health + whoami (no upstream, no auth service)", () => {
  it("GET /health -> 200 ok when storage disabled", async () => {
    const res = await fetch(base + "/health");
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ status: "ok" });
  });

  it("GET /whoami without key -> 401", async () => {
    const res = await fetch(base + "/whoami");
    expect(res.status).toBe(401);
  });

  it("GET /whoami with bearer -> 200 key id (derived locally)", async () => {
    const res = await fetch(base + "/whoami", {
      headers: { authorization: "Bearer fake-cust-key" },
    });
    expect(res.status).toBe(200);
    expect((await res.text()).trim().length).toBeGreaterThan(0);
  });
});

describe("marker gates (markerOptIn=false must 404, never passthrough)", () => {
  it("POST /cost-guard/ path -> 404 cost_guard_marker_disabled", async () => {
    const res = await fetch(
      base + "/claude-code/svc-fake/cost-guard/v1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    );
    expect(res.status).toBe(404);
    expect((await res.json()) as any).toMatchObject({
      error: "cost_guard_marker_disabled",
    });
  });

  it("POST /analyse/ path -> 404 analyse_marker_disabled", async () => {
    const res = await fetch(
      base + "/claude-code/svc-fake/analyse/v1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    );
    expect(res.status).toBe(404);
    expect((await res.json()) as any).toMatchObject({
      error: "analyse_marker_disabled",
    });
  });
});

describe("ops endpoint auth", () => {
  async function destroy(body: unknown, key?: string) {
    const res = await fetch(base + "/v3/instance/proxy-destroy", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  }

  it("wrong/missing admin key -> 401", async () => {
    const bad = await destroy({ instance_id: "svc-fake" }, "wrong-key");
    expect(bad.status).toBe(401);
  });

  it("bad instance_id -> 400 (path traversal rejected)", async () => {
    const r = await destroy({ instance_id: "../evil" }, "test-admin-key");
    expect(r.status).toBe(400);
  });

  it("valid key + id -> 200 envelope with cleaned report", async () => {
    const r = await destroy({ instance_id: "svc-fake" }, "test-admin-key");
    expect(r.status).toBe(200);
    expect(r.json.code).toBe(0);
    expect(r.json.data.cleaned).toBeDefined();
  });
});
