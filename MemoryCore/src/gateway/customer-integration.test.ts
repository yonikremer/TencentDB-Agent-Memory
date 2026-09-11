/**
 * customer-integration.test.ts — Core data-plane auth seam with the REAL
 * metadata stack (SqliteMetadataStore + MetadataService, temp DB).
 *
 * The routing unit test fakes the user service. This proves the real
 * verifyAuth path: valid key passes auth (503 no-store, never 401/422),
 * bogus/missing keys 401, missing triad 422. No store/embedding needed —
 * auth runs before dispatch.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleV3Route } from "./v3-router.js";
import type { V3RouterDeps } from "./v3-router.js";
import { SqliteMetadataStore } from "../metadata/store/sqlite-adapter.js";
import { MetadataService } from "../metadata/service/metadata-service.js";

const INST = "test-gw-1";
const ADMIN_KEY = "gw-admin-fake-key";
let tmp = "";
let svc: MetadataService;

const TRIAD = {
  "x-tdai-team-id": "t",
  "x-tdai-agent-id": "a",
  "x-tdai-user-id": "u",
  "x-tdai-session-id": "s",
};

function req(pathname: string, headers: Record<string, string> = {}) {
  return {
    url: pathname,
    method: "POST",
    headers: {
      authorization: "Bearer k",
      "x-tdai-service-id": INST,
      ...headers,
    },
  } as never;
}

async function route(pathname: string, headers: Record<string, string> = {}, body: unknown = {}) {
  const seen: Array<{ status: number; body: any }> = [];
  const handled = await handleV3Route(
    req(pathname, headers),
    {} as never,
    pathname,
    "POST",
    async <T>(): Promise<T> => body as T,
    ((_res: unknown, status: number, b: unknown) => { seen.push({ status, body: b }); }) as never,
    {
      getStore: () => undefined,
      getEmbedding: () => undefined,
      getStorage: () => undefined,
      getMetadataService: async (id) => (id === INST ? (svc as never) : undefined),
      deployMode: "standalone",
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as unknown as V3RouterDeps,
  );
  const last = seen[seen.length - 1];
  return { handled, status: last?.status, code: last?.body?.code };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "core-gw-"));
  const store = new SqliteMetadataStore(join(tmp, "meta.db"));
  (globalThis as any).__gwStore = store;
  store.init();
  svc = new MetadataService(store, INST, { debug: () => {} } as never);
  await svc.initAdminUser({ username: "root", user_key: ADMIN_KEY });
});

afterAll(async () => {
  try { (globalThis as any).__gwStore?.close(); } catch { /* ignore */ }
  rmSync(tmp, { recursive: true, force: true });
});

describe("data-plane auth with real metadata stack", () => {
  it("missing user key -> 401", async () => {
    const r = await route("/v3/conversation/add", { ...TRIAD });
    expect(r.status).toBe(401);
  });

  it("bogus key -> 401", async () => {
    const r = await route("/v3/conversation/add", { ...TRIAD, "x-tdai-user-key": "bogus" });
    expect(r.status).toBe(401);
  });

  it("valid key without triad -> 422 (isolation, not auth)", async () => {
    const r = await route("/v3/conversation/add", { "x-tdai-user-key": ADMIN_KEY });
    expect(r.status).toBe(422);
  });

  it("valid key + triad passes auth (503 no-store proves dispatch reached)", async () => {
    const r = await route("/v3/conversation/add", { ...TRIAD, "x-tdai-user-key": ADMIN_KEY });
    expect(r.handled).toBe(true);
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(422);
  });

  it("unknown instance -> 503 (no user store)", async () => {
    const seen: Array<{ status: number }> = [];
    const { handleV3Route: h } = await import("./v3-router.js");
    await h(
      req("/v3/conversation/add", { ...TRIAD, "x-tdai-user-key": ADMIN_KEY }),
      {} as never,
      "/v3/conversation/add",
      "POST",
      async <T>(): Promise<T> => ({}) as T,
      ((_res: unknown, status: number) => { seen.push({ status }); }) as never,
      {
        getStore: () => undefined,
        getEmbedding: () => undefined,
        getStorage: () => undefined,
        getMetadataService: async () => undefined,
        deployMode: "standalone",
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      } as unknown as V3RouterDeps,
    );
    expect(seen[seen.length - 1]?.status).toBe(503);
  });
});
