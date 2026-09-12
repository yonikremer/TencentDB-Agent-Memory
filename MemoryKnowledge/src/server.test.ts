/**
 * server.test.ts — /v3/internal/* service bearer: correct token bypasses the
 * user-key verifier, wrong/missing token falls through (fail closed), and the
 * bearer never opens non-internal routes.
 *
 * Boots the real app on a temp dataDir via createApp (config from env).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "kst-test-bearer-.shop";
const SVC = "svc-internal-1";

let base = "";
let server: Server;
let tmp = "";
const savedEnv: Record<string, string | undefined> = {};

async function post(path: string, headers: Record<string, string>, body: unknown = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { code: number; message: string; data: any } };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "know-internal-"));
  for (const k of ["KNOWLEDGE_DATA_DIR", "KNOWLEDGE_DB_PATH", "KNOWLEDGE_AUTH_TOKEN", "LOG_LEVEL"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.KNOWLEDGE_DATA_DIR = join(tmp, "data");
  process.env.KNOWLEDGE_DB_PATH = join(tmp, "test.db");
  process.env.KNOWLEDGE_AUTH_TOKEN = TOKEN;
  process.env.LOG_LEVEL = "error";
  const { createApp } = await import("./server.js");
  const { app } = createApp();
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address();
  base = "http://127.0.0.1:" + (typeof addr === "object" && addr ? addr.port : 0);
}, 90_000);

async function rmRetry(path: string) {
  // Windows holds the SQLite WAL briefly after close; retry before giving up.
  for (let i = 0; i < 10; i++) {
    try { rmSync(path, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
}

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rmRetry(tmp);
});

describe("internal service bearer", () => {
  it("accepts the correct token without a user key", async () => {
    const r = await post("/v3/internal/llm-binding/status", {
      "x-tdai-service-id": SVC,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(r.status).toBe(200);
    expect(r.json.code).toBe(0);
    expect(r.json.data.bound).toBe(false);
  });

  it("rejects a wrong token (fail closed)", async () => {
    const r = await post("/v3/internal/llm-binding/status", {
      "x-tdai-service-id": SVC,
      authorization: "Bearer wrong",
    });
    expect(r.status).toBe(401);
  });

  it("rejects missing auth (unchanged behavior)", async () => {
    const r = await post("/v3/internal/llm-binding/status", { "x-tdai-service-id": SVC });
    expect(r.status).toBe(401);
  });

  it("does not open non-internal routes", async () => {
    const r = await post("/v3/wiki/list", {
      "x-tdai-service-id": SVC,
      authorization: `Bearer ${TOKEN}`,
    }, { team_id: "team-x" });
    expect(r.status).toBe(401);
  });
});
