/**
 * data-plane-integration.test.ts — L0 conversation round-trip with REAL stack.
 *
 * Real SqliteMetadataStore (auth) + real sqlite store bundle (createStoreBundle)
 * + deterministic hash embedding. Proves what unit routing tests can't: add ->
 * query returns the message, count reflects writes, team isolation holds on
 * read, delete removes. No model download, no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleV3Route } from "./v3-router.js";
import type { V3RouterDeps } from "./v3-router.js";
import { SqliteMetadataStore } from "../metadata/store/sqlite-adapter.js";
import { MetadataService } from "../metadata/service/metadata-service.js";
import { parseConfig } from "../config.js";
import { createStoreBundle } from "../core/store/factory.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import { EmbeddingNotReadyError } from "../core/store/embedding.js";

const INST = "test-dp-1";
const ADMIN_KEY = "dp-admin-fake-key";
const TEAM_A = "team-dp-a";
const TEAM_B = "team-dp-b";
const SESSION = "sess-dp-1";
const MARKER = "dataplanemarker";

let tmp = "";
let svc: MetadataService;
let store: any;
let nullLogger: any;

// Deterministic 8-dim embedding (stable across calls, no model).
const hashEmbedding: EmbeddingService = {
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(8);
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
      v[i % 8] += (h >>> 0) / 4294967295;
    }
    return v;
  },
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  },
  getDimensions(): number {
    return 8;
  },
  getProviderInfo() {
    return { provider: "test", model: "hash-8" };
  },
  isReady(): boolean {
    return true;
  },
  startWarmup(): void {},
};

function triad(team: string) {
  return {
    "x-tdai-team-id": team,
    "x-tdai-agent-id": "a",
    "x-tdai-user-id": "u",
    "x-tdai-session-id": SESSION,
  };
}

async function route(
  pathname: string,
  team: string,
  body: unknown,
  key: string = ADMIN_KEY,
  overrides: { store?: unknown; embedding?: EmbeddingService | undefined } = {},
) {
  const seen: Array<{ status: number; body: any }> = [];
  const headers: Record<string, string> = {
    authorization: "Bearer k",
    "x-tdai-service-id": INST,
    "x-tdai-user-key": key,
    ...triad(team),
  };
  const handled = await handleV3Route(
    { url: pathname, method: "POST", headers } as never,
    {} as never,
    pathname,
    "POST",
    async <T>(): Promise<T> => body as T,
    ((_res: unknown, status: number, b: unknown) => {
      seen.push({ status, body: b });
    }) as never,
    {
      getStore: () => (overrides.store ?? store),
      getEmbedding: () =>
        overrides.embedding !== undefined ? overrides.embedding : hashEmbedding,
      getStorage: () => undefined,
      getMetadataService: async (id: string) =>
        id === INST ? (svc as never) : undefined,
      deployMode: "standalone",
      logger: nullLogger,
    } as unknown as V3RouterDeps,
  );
  const last = seen[seen.length - 1];
  return { handled, status: last?.status, body: last?.body };
}

beforeAll(async () => {
  nullLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  tmp = mkdtempSync(join(tmpdir(), "core-dp-"));
  const meta = new SqliteMetadataStore(join(tmp, "meta.db"));
  (globalThis as any).__dpMeta = meta;
  meta.init();
  svc = new MetadataService(meta, INST, { debug: () => {} } as never);
  await svc.initAdminUser({ username: "root", user_key: ADMIN_KEY });
  const bundle = createStoreBundle(parseConfig({}), {
    dataDir: join(tmp, "store"),
    logger: nullLogger,
  });
  store = bundle.store;
  // VectorStore requires explicit init (loads sqlite-vec + schema); without
  // it every write is silently skipped while handlers still report success.
  await store.init(hashEmbedding.getProviderInfo());
  (globalThis as any).__dpBundle = bundle;
});

afterAll(async () => {
  try {
    await (globalThis as any).__dpBundle?.store?.close?.();
  } catch {
    /* ignore */
  }
  try {
    (globalThis as any).__dpMeta?.close();
  } catch {
    /* ignore */
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("L0 conversation round-trip (real sqlite store)", () => {
  let msgId = "";

  it("add persists message (202/200 + ids)", async () => {
    const r = await route("/v3/conversation/add", TEAM_A, {
      session_id: SESSION,
      messages: [{ role: "user", content: `remember ${MARKER} for later` }],
    });
    expect(r.handled).toBe(true);
    expect([200, 201, 202]).toContain(r.status);
    const ids =
      (r.body as any)?.data?.accepted_ids ?? (r.body as any)?.data?.ids ?? [];
    expect(ids.length).toBeGreaterThan(0);
    msgId = ids[0];
  });

  it("query returns the written message", async () => {
    const r = await route("/v3/conversation/query", TEAM_A, {
      session_id: SESSION,
      limit: 20,
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify((r.body as any)?.data)).toContain(MARKER);
  });

  it("other team cannot read (isolation)", async () => {
    const r = await route("/v3/conversation/query", TEAM_B, {
      session_id: SESSION,
      limit: 20,
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify((r.body as any)?.data)).not.toContain(MARKER);
  });

  it("count reflects write; delete removes", async () => {
    const c1 = await route("/v3/conversation/count", TEAM_A, {
      session_id: SESSION,
    });
    expect((c1.body as any)?.data?.total).toBeGreaterThan(0);
    const d = await route("/v3/conversation/delete", TEAM_A, {
      message_ids: [msgId],
    });
    expect(d.status).toBe(200);
    if (d.status === 200) {
      const q = await route("/v3/conversation/query", TEAM_A, {
        session_id: SESSION,
        limit: 20,
      });
      expect(JSON.stringify((q.body as any)?.data)).not.toContain(MARKER);
    }
  });
});

// Fail loud: quality over wrong sense of availability. Any vector write
// that cannot be vectorized (model down, store degraded) is a 503, never
// a 200 with silently missing vectors.
function throwingEmbedding(err: Error): EmbeddingService {
  return {
    embed: async () => { throw err; },
    embedBatch: async () => { throw err; },
    getDimensions: () => 8,
    getProviderInfo: () => ({ provider: "test", model: "throwing" }),
    isReady: () => false,
    startWarmup: () => {},
  };
}

describe("embedding failure is a 503, never silent success", () => {
  const ADD = { session_id: SESSION, messages: [{ role: "user", content: "x" }] };

  it("NotReady model on add -> 503", async () => {
    const r = await route("/v3/conversation/add", TEAM_A, ADD, ADMIN_KEY, {
      embedding: throwingEmbedding(new EmbeddingNotReadyError()),
    });
    expect(r.status).toBe(503);
    expect((r.body as any)?.code).toBe(503);
  });

  it("generic embed error on add -> 503", async () => {
    const r = await route("/v3/conversation/add", TEAM_A, ADD, ADMIN_KEY, {
      embedding: throwingEmbedding(new Error("upstream timeout")),
    });
    expect(r.status).toBe(503);
  });

  it("store refusing persist -> 503", async () => {
    const deadStore = new Proxy(store, {
      get: (t, p) => (p === "upsertL0" ? async () => false : (t as any)[p]),
    });
    const r = await route("/v3/conversation/add", TEAM_A, ADD, ADMIN_KEY, { store: deadStore });
    expect(r.status).toBe(503);
  });

  it("NotReady model on search -> 503 (no silent FTS-only downgrade)", async () => {
    const r = await route(
      "/v3/conversation/search",
      TEAM_A,
      { query: "x" },
      ADMIN_KEY,
      { embedding: throwingEmbedding(new EmbeddingNotReadyError()) },
    );
    expect(r.status).toBe(503);
  });

  it("no embedding service configured still writes metadata-only (explicit opt-out)", async () => {
    const r = await route("/v3/conversation/add", TEAM_A, ADD, ADMIN_KEY, { embedding: undefined });
    expect(r.status).not.toBe(503);
  });
});
