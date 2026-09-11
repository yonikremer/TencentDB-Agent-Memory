/**
 * core-verify-contract.test.ts — true Core<->Knowledge wire contract.
 *
 * The customer-integration suite stubs Core's /v3/meta/auth/verify. A stub
 * can't catch drift (e.g. Core renames user_id, wraps data differently).
 * Here the verifier is the REAL Core stack (SqliteMetadataStore +
 * MetadataService + handleV3MetaRoute) and the caller is the REAL Knowledge
 * createApp(). Fake data only (temp DBs, localhost).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo, Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteMetadataStore } from "../../../../MemoryCore/src/metadata/store/sqlite-adapter.js";
import { MetadataService } from "../../../../MemoryCore/src/metadata/service/metadata-service.js";
import { handleV3MetaRoute } from "../../../../MemoryCore/src/metadata/router/v3-meta-router.js";
import { createApp } from "../../server.js";

const INST = "test-core-ks-1";
const ADMIN_KEY = "core-admin-fake-key";
const BEARER = "core-gateway-fake-bearer";

let tmpCore = "";
let tmpKs = "";
let coreServer: http.Server;
let ksBase = "";
let ksServer: any;
let seenAuthHeader = "";
const savedEnv: Record<string, string | undefined> = {};

async function rmRetry(path: string) {
  // Windows holds SQLite handles briefly after close; retry before giving up.
  for (let i = 0; i < 10; i++) {
    try { rmSync(path, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
}

function setEnv(k: string, v: string) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  process.env[k] = v;
}

async function reqKs(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${ksBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { code: number; message: string; data: any } };
}

beforeAll(async () => {
  tmpCore = mkdtempSync(join(tmpdir(), "core-ks-core-"));
  tmpKs = mkdtempSync(join(tmpdir(), "core-ks-ks-"));

  // Real Core stack.
  const store = new SqliteMetadataStore(join(tmpCore, "meta.db"));
  (globalThis as any).__coreKsStore = store;
  store.init();
  const svc = new MetadataService(store, INST, { debug: () => {} } as any);
  await svc.initAdminUser({ username: "root", user_key: ADMIN_KEY });

  coreServer = http.createServer(async (req, res) => {
    if (req.method === "POST" && (req.url ?? "").endsWith("/v3/meta/auth/verify")) {
      seenAuthHeader = (req.headers.authorization as string) ?? "";
    }
    const u = new URL(req.url ?? "/", "http://x");
    const sendJson = (r: http.ServerResponse, status: number, body: unknown) => {
      r.writeHead(status, { "content-type": "application/json" });
      r.end(JSON.stringify(body));
    };
    const parseJsonBody = async <T>(rq: http.IncomingMessage): Promise<T> =>
      new Promise((resolve, reject) => {
        let raw = "";
        rq.on("data", (c) => { raw += c; });
        rq.on("end", () => {
          try { resolve(raw ? (JSON.parse(raw) as T) : ({} as T)); }
          catch (e) { reject(e); }
        });
      });
    await handleV3MetaRoute(req, res, u.pathname, req.method ?? "", parseJsonBody, sendJson, {
      getMetadataService: (id) => (id === INST ? svc : undefined),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });
  });
  await new Promise<void>((resolve) => coreServer.listen(0, "127.0.0.1", () => resolve()));
  const coreAddr = coreServer.address() as AddressInfo;
  const coreBase = `http://127.0.0.1:${coreAddr.port}`;

  // Real Knowledge app pointed at real Core.
  setEnv("CORE_VERIFY_URL", coreBase);
  setEnv("CORE_VERIFY_BEARER", BEARER);
  setEnv("KNOWLEDGE_DATA_DIR", join(tmpKs, "data"));
  setEnv("KNOWLEDGE_DB_PATH", join(tmpKs, "k.db"));
  setEnv("KNOWLEDGE_CLICKHOUSE_ENABLED", "");
  const created = createApp();
  const { serve } = await import("@hono/node-server");
  ksServer = serve({ fetch: created.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((r) => (ksServer as Server).on("listening", () => r()));
  const ksAddr = (ksServer as Server).address() as AddressInfo;
  ksBase = `http://127.0.0.1:${ksAddr.port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => ksServer?.close(() => r()));
  await new Promise<void>((r) => coreServer?.close(() => r()));
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { (globalThis as any).__coreKsStore?.close(); } catch { /* ignore */ }
  await rmRetry(tmpCore);
  await rmRetry(tmpKs);
});

describe("Core<->Knowledge verify wire contract (both stacks real)", () => {
  it("real Core admin key passes Knowledge auth + bearer forwarded (first call populates verify cache)", async () => {
    seenAuthHeader = "";
    const { status, json } = await reqKs("/v3/wiki/list", { team_id: "t" }, {
      "x-tdai-service-id": INST,
      "x-tdai-user-key": ADMIN_KEY,
    });
    expect(status).toBe(200);
    expect(json.code).toBe(0);
    expect(seenAuthHeader).toBe(`Bearer ${BEARER}`);
  });

  it("bogus key rejected 401 against real Core", async () => {
    const { status, json } = await reqKs("/v3/wiki/list", { team_id: "t" }, {
      "x-tdai-service-id": INST,
      "x-tdai-user-key": "bogus-key",
    });
    expect(status).toBe(401);
    expect(json.code).toBe(401);
  });
});
