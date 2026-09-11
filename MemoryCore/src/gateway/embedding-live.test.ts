/**
 * embedding-live.test.ts — vector search with a real embedding model.
 *
 * Model liquid/lfm-2.5-embedding-350m:free via OpenRouter (1024 dims, $0).
 * Config from tests/helpers/live-llm-env.ts (LLM_LIVE=1 opt-in + key).
 *
 * Proof strategy: the probe query shares NO vocabulary with the target
 * message, so keyword/FTS matching finds nothing — only dense vectors can
 * rank it first. A silent embedding failure turns this red, not empty-green.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadLiveLlmConfig } from "../../../tests/helpers/live-llm-env.js";
import { handleV3Route } from "./v3-router.js";
import type { V3RouterDeps } from "./v3-router.js";
import { SqliteMetadataStore } from "../metadata/store/sqlite-adapter.js";
import { MetadataService } from "../metadata/service/metadata-service.js";
import { parseConfig } from "../config.js";
import { createStoreBundle } from "../core/store/factory.js";
import type { EmbeddingService } from "../core/store/embedding.js";

const LIVE = loadLiveLlmConfig();
const live = LIVE.live ? describe : describe.skip;
const EMB_MODEL =
  process.env.LLM_TEST_EMBED_MODEL?.trim() ||
  "liquid/lfm-2.5-embedding-350m:free";
const EMB_DIMS = Number(process.env.LLM_TEST_EMBED_DIMS ?? 1024);

const INST = "test-emb-1";
const ADMIN_KEY = "emb-admin-fake-key";
const TEAM = "team-emb-1";
const SESSION = "sess-emb-1";

let tmp = "";
let svc: MetadataService;
let store: any;
let bundle: any;
const nullLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function orEmbedding(): EmbeddingService {
  const call = async (texts: string[]): Promise<Float32Array[]> => {
    const res = await fetch(`${LIVE.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LIVE.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMB_MODEL, input: texts }),
    });
    if (!res.ok) throw new Error(`embedding upstream ${res.status}`);
    const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return json.data.map((d) => Float32Array.from(d.embedding));
  };
  return {
    embed: async (t: string) => (await call([t]))[0] as Float32Array,
    embedBatch: call,
    getDimensions: () => EMB_DIMS,
    getProviderInfo: () => ({ provider: "openrouter", model: EMB_MODEL }),
    isReady: () => true,
    startWarmup: () => {},
  };
}

const embedding = orEmbedding();

function triad() {
  return {
    "x-tdai-team-id": TEAM,
    "x-tdai-agent-id": "a",
    "x-tdai-user-id": "u",
    "x-tdai-session-id": SESSION,
  };
}

async function route(pathname: string, body: unknown) {
  const seen: Array<{ status: number; body: any }> = [];
  await handleV3Route(
    {
      url: pathname,
      method: "POST",
      headers: {
        authorization: "Bearer k",
        "x-tdai-service-id": INST,
        "x-tdai-user-key": ADMIN_KEY,
        ...triad(),
      },
    } as never,
    {} as never,
    pathname,
    "POST",
    async <T>(): Promise<T> => body as T,
    ((_res: unknown, status: number, b: unknown) => {
      seen.push({ status, body: b });
    }) as never,
    {
      getStore: () => store,
      getEmbedding: () => embedding,
      getStorage: () => undefined,
      getMetadataService: async (id: string) =>
        id === INST ? (svc as never) : undefined,
      deployMode: "standalone",
      logger: nullLogger,
    } as unknown as V3RouterDeps,
  );
  const last = seen[seen.length - 1];
  return { status: last?.status, body: last?.body };
}

beforeAll(async () => {
  if (!LIVE.live) return;
  tmp = mkdtempSync(join(tmpdir(), "core-emb-"));
  const meta = new SqliteMetadataStore(join(tmp, "meta.db"));
  (globalThis as any).__embMeta = meta;
  meta.init();
  svc = new MetadataService(meta, INST, { debug: () => {} } as never);
  await svc.initAdminUser({ username: "root", user_key: ADMIN_KEY });
  // Bundle must carry matching embedding dims or vec writes are skipped
  // while handlers still report success (same silent-skip as missing init).
  bundle = createStoreBundle(
    parseConfig({
      embedding: {
        enabled: true,
        provider: "openai",
        baseUrl: LIVE.baseUrl,
        apiKey: LIVE.key,
        model: EMB_MODEL,
        dimensions: EMB_DIMS,
        sendDimensions: false,
      },
    }),
    { dataDir: join(tmp, "store"), logger: nullLogger },
  );
  store = bundle.store;
  (globalThis as any).__embBundle = bundle;
  await store.init(embedding.getProviderInfo());
}, 120_000);

afterAll(async () => {
  if (!LIVE.live) return;
  try {
    await (globalThis as any).__embBundle?.store?.close?.();
  } catch {
    /* ignore */
  }
  try {
    (globalThis as any).__embMeta?.close();
  } catch {
    /* ignore */
  }
  rmSync(tmp, { recursive: true, force: true });
});

live("vector search with live embeddings (zero-overlap probe)", () => {
  it("live dims match configured 1024 (fail loud on model change)", async () => {
    const v = await embedding.embed("dims probe");
    expect(v.length).toBe(EMB_DIMS);
  });

  it("semantic hit ranks first without shared vocabulary", async () => {
    const add = await route("/v3/conversation/add", {
      session_id: SESSION,
      messages: [
        { role: "user", content: "koi carp thrive in cold ponds" },
        { role: "user", content: "quantum circuits need cryogenic cooling" },
      ],
    });
    expect([200, 201, 202]).toContain(add.status);
    const s = await route("/v3/conversation/search", {
      query: "aquatic pets temperature needs",
      limit: 5,
    });
    expect(s.status).toBe(200);
    const results =
      (s.body as any)?.data?.results ?? (s.body as any)?.data?.messages ?? [];
    expect(results.length).toBeGreaterThan(0);
    expect(JSON.stringify(results[0])).toContain("koi");
  }, 180_000);
});
