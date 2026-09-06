import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../schema.js";
import { resolveDbPath, getDb, closeDb, __resetDbForTests } from "../index.js";
import { getSessionRepo, setSessionRepo, __resetSessionRepoForTests, type SessionRepo } from "../sessionRepo.js";
import { getHookCacheRepo, setHookCacheRepo, __resetHookCacheRepoForTests } from "../hookCacheRepo.js";
import { RedisBindingRepo, NullBindingRepo, type BindingRepo } from "../binding-repo.js";
import { RedisSessionRepo } from "../redis-session-repo.js";
import { RedisHookCacheRepo } from "../redis-hook-cache-repo.js";
import { KvBindingRepo } from "../kv-binding-repo.js";
import { KvSessionRepo } from "../kv-session-repo.js";
import { KvHookCacheRepo } from "../kv-hook-cache-repo.js";
import { MemoryStorage } from "../../storage/memory-storage.js";
import { getRedisClient, __resetRedisClientForTests } from "../redis-client.js";

afterEach(() => {
  __resetDbForTests();
  __resetSessionRepoForTests();
  __resetHookCacheRepoForTests();
  __resetRedisClientForTests();
  vi.unstubAllEnvs();
});

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    status: "initialized",
    keyId: "k",
    startedAt: 1,
    attemptCount: 0,
    sessionInfo: { agent_id: "a1", task_id: "t1", user_id: "u1" },
    ...overrides,
  } as never;
}

describe("db/index", () => {
  it("resolves DB path from env or home", () => {
    vi.stubEnv("PROXY_DB_PATH", "/tmp/custom/proxy.db");
    expect(resolveDbPath()).toBe("/tmp/custom/proxy.db");
    vi.stubEnv("PROXY_DB_PATH", "   ");
    expect(resolveDbPath()).toContain(".tdai-memory-proxy");
    vi.stubEnv("PROXY_DB_PATH", "");
    expect(resolveDbPath()).toContain("proxy.db");
  });

  it("initializes a real sqlite db with schema + version meta", () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-db-"));
    try {
      vi.stubEnv("PROXY_DB_PATH", join(dir, "proxy.db"));
      const db = getDb();
      expect(db).not.toBeNull();
      const row = db!.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      expect(row.value).toBe(String(SCHEMA_VERSION));
      db!.exec("DROP TABLE sessions");
      db!.exec(SCHEMA_SQL);
      const again = getDb();
      expect(again).toBe(db);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked on win */ }
    }
  });

  it("returns null when db init fails (unwritable path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-db-"));
    try {
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "x");
      vi.stubEnv("PROXY_DB_PATH", join(blocker, "sub", "proxy.db"));
      expect(getDb()).toBeNull();
      // caching of failure
      expect(getDb()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closeDb resets the singleton", () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-db-"));
    try {
      vi.stubEnv("PROXY_DB_PATH", join(dir, "p2.db"));
      expect(getDb()).not.toBeNull();
      closeDb();
      vi.stubEnv("PROXY_DB_PATH", join(dir, "p3.db"));
      expect(getDb()).not.toBeNull();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked on win */ }
    }
  });
});

describe("SqliteSessionRepo", () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "mp-sess-"));
    vi.stubEnv("PROXY_DB_PATH", join(dir, "proxy.db"));
  });

  it("upserts, reads, deletes and hydrates initialized rows", async () => {
    const repo = getSessionRepo();
    const state = makeState();
    await repo.upsert("sp", "u1", "cc", "s1", state);
    const got = await repo.getBySessionId("sp", "u1", "cc", "s1");
    expect(got?.status).toBe("initialized");
    expect(await repo.getBySessionId("sp", "nope", "cc", "s1")).toBeNull();

    await repo.upsert("sp", "u1", "cc", "s2", makeState({ status: "pending_asset_confirm" }));
    const hydrated = await repo.loadAllInitialized();
    expect(hydrated.length).toBe(1);
    expect(hydrated[0].spaceId).toBe("sp");
    expect(hydrated[0].sessionId).toBe("s1");

    repo.deleteBySessionId("sp", "u1", "cc", "s1");
    expect(await repo.getBySessionId("sp", "u1", "cc", "s1")).toBeNull();
  });

  it("defaults spaceId segment to _default", async () => {
    const repo = getSessionRepo();
    await repo.upsert("", "u1", "cc", "s1", makeState());
    expect(await repo.getBySessionId("", "u1", "cc", "s1")).not.toBeNull();
    expect(await repo.getBySessionId("_default", "u1", "cc", "s1")).not.toBeNull();
  });

  it("handles state with sessionInfo containing colons in sessionId", async () => {
    const repo = getSessionRepo();
    await repo.upsert("sp", "u", "cc", "sess:with:colons", makeState());
    const hydrated = await repo.loadAllInitialized();
    expect(hydrated.some((h) => h.sessionId === "sess:with:colons")).toBe(true);
  });
});

describe("NullSessionRepo path", () => {
  it("falls back to null repo when db unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-null-"));
    try {
      const blocker = join(dir, "b");
      writeFileSync(blocker, "x");
      vi.stubEnv("PROXY_DB_PATH", join(blocker, "sub", "x.db"));
      const repo = getSessionRepo();
      await repo.upsert("sp", "u", "cc", "s", makeState());
      expect(await repo.getBySessionId("sp", "u", "cc", "s")).toBeNull();
      repo.deleteBySessionId("sp", "u", "cc", "s");
      expect(await repo.loadAllInitialized()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("setSessionRepo replaces the singleton", async () => {
    const custom: SessionRepo = {
      upsert: vi.fn(async () => {}),
      getBySessionId: vi.fn(async () => null),
      deleteBySessionId: vi.fn(),
      loadAllInitialized: vi.fn(async () => []),
    };
    setSessionRepo(custom);
    expect(getSessionRepo()).toBe(custom);
  });
});

describe("SqliteHookCacheRepo", () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "mp-hook-"));
    vi.stubEnv("PROXY_DB_PATH", join(dir, "proxy.db"));
  });

  it("put / get / putMany / getAllForSession / clearBySession", async () => {
    const repo = getHookCacheRepo();
    // hook_cache has an FK to sessions; seed a session row first
    await getSessionRepo().upsert("sp", "u", "cc", "s1", makeState());
    const blocks = [{ kind: "text" as const, text: "hello" }];
    repo.put("sp", "u", "cc", "s1", "h1", blocks);
    repo.put("sp", "u", "cc", "s1", "h2", [{ kind: "text" as const, text: "two" }]);
    expect(await repo.get("sp", "u", "cc", "s1", "h1")).toEqual(blocks);
    expect(await repo.get("sp", "u", "cc", "s1", "missing")).toBeNull();
    repo.putMany("sp", "u", "cc", "s1", [
      { hookId: "h3", blocks: [{ kind: "text" as const, text: "3" }] },
      { hookId: "h4", blocks: [{ kind: "text" as const, text: "4" }] },
    ]);
    repo.putMany("sp", "u", "cc", "s1", []);
    const all = await repo.getAllForSession("sp", "u", "cc", "s1");
    expect(all.map((e) => e.hookId).sort()).toEqual(["h1", "h2", "h3", "h4"]);
    repo.clearBySession("sp", "u", "cc", "s1");
    expect(await repo.getAllForSession("sp", "u", "cc", "s1")).toEqual([]);

    // corrupt json row is skipped
    const db = getDb()!;
    db.prepare("INSERT INTO sessions (session_id, session_key, status, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("corrupt:sid", "k", "initialized", "{}", Date.now(), Date.now());
    db.prepare("INSERT INTO hook_cache (session_id, hook_id, blocks_json, created_at) VALUES (?, ?, ?, ?)")
      .run("corrupt:sid", "hx", "{bad json", Date.now());
    expect(await repo.get("sp", "u", "cc", "s1", "hx")).toBeNull();
    expect(await repo.getAllForSession("corrupt", "sid", "", "")).toEqual([]);
  });
});

describe("NullHookCacheRepo path", () => {
  it("falls back when db unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-nullh-"));
    try {
      const blocker = join(dir, "b");
      writeFileSync(blocker, "x");
      vi.stubEnv("PROXY_DB_PATH", join(blocker, "sub", "x.db"));
      const repo = getHookCacheRepo();
      repo.put("sp", "u", "cc", "s", "h", []);
      repo.putMany("sp", "u", "cc", "s", [{ hookId: "h", blocks: [] }]);
      expect(await repo.get("sp", "u", "cc", "s", "h")).toBeNull();
      expect(await repo.getAllForSession("sp", "u", "cc", "s")).toEqual([]);
      repo.clearBySession("sp", "u", "cc", "s");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("setHookCacheRepo replaces singleton", () => {
    const custom = {
      put: vi.fn(),
      putMany: vi.fn(),
      get: vi.fn(async () => null),
      getAllForSession: vi.fn(async () => []),
      clearBySession: vi.fn(),
    };
    setHookCacheRepo(custom);
    expect(getHookCacheRepo()).toBe(custom);
  });
});

describe("redis-client", () => {
  it("returns null when disabled / failed", () => {
    expect(getRedisClient({ enabled: false } as never)).toBeNull();
    __resetRedisClientForTests();
    expect(getRedisClient({ enabled: true, host: "127.0.0.1", port: 1, url: "" } as never)).not.toBeNull();
  });
});

describe("RedisBindingRepo", () => {
  function fakeRedis() {
    const store = new Map<string, Record<string, string>>();
    return {
      store,
      hgetall: vi.fn(async (k: string) => store.get(k) ?? {}),
      hset: vi.fn(async (k: string, fields: Record<string, string>) => {
        store.set(k, { ...(store.get(k) ?? {}), ...fields });
        return 1;
      }),
      expire: vi.fn(async () => 1),
      del: vi.fn(async (k: string) => {
        store.delete(k);
        return 1;
      }),
    };
  }

  it("round-trips bindings and tolerates errors", async () => {
    const redis = fakeRedis();
    const repo = new RedisBindingRepo(redis as never, 30);
    expect(await repo.getBinding("sp", "s1")).toBeNull();
    await repo.putBinding("sp", "s1", { outcome: "initialized", userId: "u", teamId: "t", agentId: "a", taskId: "k", agentSource: "cc", userKey: "uk" });
    const got = await repo.getBinding("sp", "s1");
    expect(got?.userId).toBe("u");
    expect(got?.agentSource).toBe("cc");
    expect(got?.outcome).toBe("initialized");
    await repo.touchLastSeen("sp", "s1");
    expect(redis.store.get("inj:binding:sp:s1")?.last_seen).toBeTruthy();
    await repo.putBinding("", "s2", { outcome: "bypassed" });
    expect(await repo.getBinding("", "s2")).not.toBeNull();
    await repo.deleteBinding("sp", "s1");
    expect(await repo.getBinding("sp", "s1")).toBeNull();

    redis.hgetall.mockRejectedValueOnce(new Error("down"));
    expect(await repo.getBinding("sp", "s1")).toBeNull();
    redis.hset.mockRejectedValueOnce(new Error("down"));
    await repo.putBinding("sp", "s3", { outcome: "initialized" });
    redis.del.mockRejectedValueOnce(new Error("down"));
    await repo.deleteBinding("sp", "s3");
    redis.hset.mockRejectedValueOnce(new Error("down"));
    await repo.touchLastSeen("sp", "s3");
  });

  it("NullBindingRepo no-ops", async () => {
    const repo = new NullBindingRepo() as BindingRepo;
    expect(await repo.getBinding("a", "b")).toBeNull();
    await repo.putBinding("a", "b", { outcome: "initialized" });
    await repo.deleteBinding("a", "b");
    await repo.touchLastSeen("a", "b");
  });
});

describe("RedisSessionRepo", () => {
  function fakeRedis() {
    const store = new Map<string, string>();
    return {
      store,
      setex: vi.fn(async (k: string, t: number, v: string) => { store.set(k, v); return "OK"; }),
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
      mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
      scan: vi.fn(async (cursor: string, ..._args: string[]) => {
        if (cursor === "0") {
          return ["0", [...store.keys()]];
        }
        return ["0", []];
      }),
    };
  }

  it("round-trips states with default and custom ttl", async () => {
    const redis = fakeRedis();
    const repo = new RedisSessionRepo(redis as never);
    const state = makeState();
    await repo.upsert("sp", "u", "cc", "s1", state);
    expect(await repo.getBySessionId("sp", "u", "cc", "s1")).toEqual(state);
    expect(await repo.getBySessionId("sp", "u", "cc", "missing")).toBeNull();
    repo.deleteBySessionId("sp", "u", "cc", "s1");
    expect(await repo.getBySessionId("sp", "u", "cc", "s1")).toBeNull();

    await repo.upsert("", "u", "cc", "s2", makeState({ status: "pending" }));
    expect(await repo.getBySessionId("_default", "u", "cc", "s2")).not.toBeNull();

    const repo2 = new RedisSessionRepo(redis as never, 60);
    await repo2.upsert("sp", "u", "cc", "s3", makeState());
    expect(await repo2.getBySessionId("sp", "u", "cc", "s3")).not.toBeNull();
  });

  it("hydrates initialized rows via scan", async () => {
    const redis = fakeRedis();
    const repo = new RedisSessionRepo(redis as never);
    await repo.upsert("sp", "u", "cc", "ok1", makeState());
    await repo.upsert("sp", "u", "cc", "ok2", makeState({ status: "pending_asset_confirm" }));
    redis.store.set("inj:sess:other:junk", "{bad json");
    const hydrated = await repo.loadAllInitialized();
    expect(hydrated.length).toBe(1);
    expect(hydrated[0].sessionId).toBe("ok1");

    redis.scan.mockRejectedValueOnce(new Error("down"));
    expect(await repo.loadAllInitialized()).toEqual([]);
    redis.get.mockRejectedValueOnce(new Error("down"));
    expect(await repo.getBySessionId("sp", "u", "cc", "x")).toBeNull();
    redis.setex.mockRejectedValueOnce(new Error("down"));
    await repo.upsert("sp", "u", "cc", "y", makeState());
  });
});

describe("RedisHookCacheRepo", () => {
  function fakeRedis() {
    const store = new Map<string, Record<string, string>>();
    return {
      store,
      hset: vi.fn(async (k: string, ...args: string[]) => {
        const fields = args.length === 2 ? { [args[0]]: args[1] } : Object.fromEntries(args.map((a, i) => (i % 2 === 0 ? [a, args[i + 1]!] : null)).filter(Boolean));
        store.set(k, { ...(store.get(k) ?? {}), ...fields });
        return 1;
      }),
      expire: vi.fn(async () => 1),
      hget: vi.fn(async (k: string, f: string) => store.get(k)?.[f] ?? null),
      hgetall: vi.fn(async (k: string) => store.get(k) ?? {}),
      del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
    };
  }

  it("put / putMany / get / getAllForSession / clearBySession", async () => {
    const redis = fakeRedis();
    const repo = new RedisHookCacheRepo(redis as never);
    const blocks = [{ kind: "text" as const, text: "x" }];
    await repo.put("sp", "u", "cc", "s1", "h1", blocks);
    expect(await repo.get("sp", "u", "cc", "s1", "h1")).toEqual(blocks);
    await repo.put("", "u", "cc", "s2", "h2", []);
    expect(await repo.get("_default", "u", "cc", "s2", "h2")).toEqual([]);
    await repo.putMany("sp", "u", "cc", "s1", [
      { hookId: "h3", blocks: [{ kind: "text" as const, text: "3" }] },
      { hookId: "h4", blocks: [{ kind: "text" as const, text: "4" }] },
    ]);
    await repo.putMany("sp", "u", "cc", "s1", []);
    const all = await repo.getAllForSession("sp", "u", "cc", "s1");
    expect(all.map((e) => e.hookId).sort()).toEqual(["h1", "h3", "h4"]);
    await repo.clearBySession("sp", "u", "cc", "s1");
    expect(await repo.getAllForSession("sp", "u", "cc", "s1")).toEqual([]);

    redis.hset.mockRejectedValueOnce(new Error("down"));
    await repo.put("sp", "u", "cc", "s9", "h", []);
    redis.hget.mockRejectedValueOnce(new Error("down"));
    expect(await repo.get("sp", "u", "cc", "s9", "h")).toBeNull();
    redis.hgetall.mockRejectedValueOnce(new Error("down"));
    expect(await repo.getAllForSession("sp", "u", "cc", "s9")).toEqual([]);
    redis.del.mockRejectedValueOnce(new Error("down"));
    await repo.clearBySession("sp", "u", "cc", "s9");

    // corrupt entries are skipped
    redis.store.set("inj:hook:sp:u:cc:s5", { bad: "{oops" });
    expect(await repo.get("sp", "u", "cc", "s5", "bad")).toBeNull();
    expect(await repo.getAllForSession("sp", "u", "cc", "s5")).toEqual([]);
  });
});

describe("Kv repos", () => {
  it("KvBindingRepo round-trips with per-key lock", async () => {
    const storage = new MemoryStorage();
    const repo = new KvBindingRepo(storage);
    expect(await repo.getBinding("sp", "s1")).toBeNull();
    await repo.putBinding("sp", "s1", { outcome: "initialized", userId: "u", userKey: "k" });
    expect(await repo.getBinding("sp", "s1")).toMatchObject({ outcome: "initialized", userId: "u", userKey: "k" });
    await repo.putBinding("sp", "s1", { outcome: "bypassed" });
    const second = await repo.getBinding("sp", "s1");
    expect(second?.outcome).toBe("bypassed");
    await repo.touchLastSeen("sp", "s1");
    const seen = await repo.getBinding("sp", "s1");
    expect(seen?.outcome).toBe("bypassed");
    await repo.touchLastSeen("sp", "missing");
    await repo.deleteBinding("sp", "s1");
    expect(await repo.getBinding("sp", "s1")).toBeNull();
    await repo.deleteBinding("sp", "missing");
  });

  it("KvSessionRepo round-trips and hydrates", async () => {
    const storage = new MemoryStorage();
    const repo = new KvSessionRepo(storage);
    await repo.upsert("sp", "u", "cc", "s1", makeState());
    expect(await repo.getBySessionId("sp", "u", "cc", "s1")).not.toBeNull();
    await repo.upsert("sp", "u", "cc", "s2", makeState({ status: "pending" }));
    const hydrated = await repo.loadAllInitialized();
    expect(hydrated.length).toBe(1);
    expect(hydrated[0].sessionId).toBe("s1");
    repo.deleteBySessionId("sp", "u", "cc", "s1");
    expect(await repo.getBySessionId("sp", "u", "cc", "s1")).toBeNull();
  });

  it("KvSessionRepo returns [] for cos storage", async () => {
    const cosLike = { type: "cos" as const, listNames: async () => [] };
    const repo = new KvSessionRepo(cosLike as never);
    expect(await repo.loadAllInitialized()).toEqual([]);
  });

  it("KvHookCacheRepo round-trips", async () => {
    const storage = new MemoryStorage();
    const repo = new KvHookCacheRepo(storage);
    const blocks = [{ kind: "text" as const, text: "b" }];
    await repo.put("sp", "u", "cc", "s1", "h1", blocks);
    expect(await repo.get("sp", "u", "cc", "s1", "h1")).toEqual(blocks);
    await repo.putMany("sp", "u", "cc", "s1", [
      { hookId: "h2", blocks: [{ kind: "text" as const, text: "2" }] },
      { hookId: "h3", blocks: [{ kind: "text" as const, text: "3" }] },
    ]);
    await repo.putMany("sp", "u", "cc", "s1", []);
    const all = await repo.getAllForSession("sp", "u", "cc", "s1");
    expect(all.map((e) => e.hookId).sort()).toEqual(["h1", "h2", "h3"]);
    await repo.clearBySession("sp", "u", "cc", "s1");
    expect(await repo.getAllForSession("sp", "u", "cc", "s1")).toEqual([]);
    await expect(repo.put("sp", "u", "cc", "s1", "../evil", [])).rejects.toBeTruthy();
  });
});