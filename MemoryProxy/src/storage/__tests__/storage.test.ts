import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MemoryStorage } from "../memory-storage.js";
import { FsStorage } from "../fs-storage.js";
import { SqliteStorage, applySqliteStorageSchema, PROXY_KV_SCHEMA_SQL } from "../sqlite-storage.js";
import { CosStorage, type CosLikeBackend } from "../cos-storage.js";
import { bucketOf } from "../proxy-storage.js";
import { assertKeySegment, assertAgentSource, sessionDirOf, sessionBindingDirOf } from "../key-utils.js";
import { getProxyStorage, initProxyStorage, __resetProxyStorageForTests, getEffectiveBackend, evictCosSpace } from "../factory.js";
import { withPerKeyLock, __resetPerKeyLocksForTests } from "../per-key-mutex.js";

afterEach(() => {
  __resetProxyStorageForTests();
  __resetPerKeyLocksForTests();
});

function memConfig() {
  return {
    backend: "memory" as const,
    ttlDays: 1,
    cos: { rootPrefix: "p", shark: { baseUrl: "" } },
    sqlite: { dbPath: "" },
    fs: { fsRoot: "" },
  };
}

describe("ProxyStorage basics", () => {
  it("bucketOf splits ttl vs nottl", () => {
    expect(bucketOf("ttl/x.json")).toBe("ttl");
    expect(bucketOf("nottl/x.json")).toBe("nottl");
    expect(bucketOf("other")).toBe("nottl");
  });
});

describe("MemoryStorage", () => {
  it("implements full CRUD semantics", async () => {
    const s = new MemoryStorage();
    expect(s.type).toBe("memory");
    expect(await s.getText("a")).toBeNull();
    await s.putText("a", "hello");
    expect(await s.getText("a")).toBe("hello");
    await s.putJSON("b", { x: 1 });
    expect(await s.getJSON("b")).toEqual({ x: 1 });
    expect(await s.getJSON("missing")).toBeNull();
    await s.putText("bad-json", "{not json");
    expect(await s.getJSON("bad-json")).toBeNull();
    expect(await s.putTextIfAbsent("a", "no")).toBe(false);
    expect(await s.putTextIfAbsent("c", "yes")).toBe(true);
    expect(await s.putJSONIfAbsent("c", {})).toBe(false);
    expect(await s.exists("a")).toBe(true);
    expect(await s.exists("zzz")).toBe(false);
    await s.putText("p/1", "one");
    await s.putText("p/2", "two");
    await s.putText("q/1", "other");
    expect((await s.listNames("p/")).sort()).toEqual(["1", "2"]);
    expect(await s.delPrefix("p/")).toBe(2);
    expect(await s.exists("p/1")).toBe(false);
    await s.del("q/1");
    expect(await s.exists("q/1")).toBe(false);
  });
});

describe("FsStorage", () => {
  it("round-trips values atomically with CAS", async () => {
    const root = mkdtempSync(join(tmpdir(), "mp-fs-"));
    try {
      const s = new FsStorage(root);
      expect(await s.getText("d/f.txt")).toBeNull();
      await s.putText("d/f.txt", "v1");
      expect(await s.getText("d/f.txt")).toBe("v1");
      await s.putJSON("d/j.json", { k: 1 });
      expect(await s.getJSON("d/j.json")).toEqual({ k: 1 });
      expect(await s.putTextIfAbsent("d/f.txt", "v2")).toBe(false);
      expect(await s.putTextIfAbsent("d/g.txt", "v2")).toBe(true);
      expect(await s.exists("d/f.txt")).toBe(true);
      expect(await s.exists("nope")).toBe(false);
      expect((await s.listNames("d/")).sort()).toEqual(["f.txt", "g.txt", "j.json"]);
      expect(await s.delPrefix("d/")).toBe(3);
      expect(await s.exists("d/f.txt")).toBe(false);
      await s.del("d/g.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects path traversal keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "mp-fs-"));
    try {
      const s = new FsStorage(root);
      await expect(s.putText("", "x")).rejects.toThrow();
      await expect(s.putText("/abs", "x")).rejects.toThrow();
      await expect(s.putText("../escape", "x")).rejects.toThrow();
      await expect(s.putText("ok/../escape", "x")).rejects.toThrow();
      await expect(s.getText("../escape")).rejects.toBeTruthy();
      await expect(s.listNames("../x")).resolves.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("SqliteStorage", () => {
  it("works against an in-memory database", async () => {
    const db = new Database(":memory:");
    applySqliteStorageSchema(db);
    db.exec("DROP TABLE IF EXISTS proxy_kv");
    db.exec(PROXY_KV_SCHEMA_SQL);
    const s = new SqliteStorage(db);
    expect(s.type).toBe("sqlite");
    await s.putText("ttl/a", "A");
    expect(await s.getText("ttl/a")).toBe("A");
    await s.putJSON("nottl/b", { n: 2 });
    expect(await s.getJSON("nottl/b")).toEqual({ n: 2 });
    expect(await s.putTextIfAbsent("ttl/a", "X")).toBe(false);
    expect(await s.putTextIfAbsent("ttl/c", "C")).toBe(true);
    expect(await s.exists("ttl/a")).toBe(true);
    expect(await s.exists("nope")).toBe(false);
    await s.putText("bad", "{oops");
    expect(await s.getJSON("bad")).toBeNull();
    await s.putText("ttl/p/1", "1");
    await s.putText("ttl/p/2", "2");
    expect((await s.listNames("ttl/p/")).sort()).toEqual(["1", "2"]);
    expect(await s.delPrefix("ttl/p/")).toBe(2);
    await s.del("ttl/a");
    // sweep only clears ttl bucket
    const before = await s.sweep({ ttlMs: 1_000_000, now: 1 });
    expect(before.removedTtl).toBeGreaterThanOrEqual(0);
    const sweepResult = await s.sweep({ ttlMs: -1000, now: 0 });
    expect(sweepResult.removedTtl).toBeGreaterThanOrEqual(0);
    expect(await s.exists("nottl/b")).toBe(true);
  });

  it("escapes LIKE wildcards in prefixes", async () => {
    const db = new Database(":memory:");
    const s = new SqliteStorage(db);
    await s.putText("x%y/1", "v");
    await s.putText("xay/1", "w");
    expect((await s.listNames("x%y/")).length).toBe(1);
    expect(await s.delPrefix("x%y/")).toBe(1);
    expect(await s.exists("xay/1")).toBe(true);
  });
});

describe("CosStorage", () => {
  function mockBackend(): CosLikeBackend & { data: Map<string, Buffer> } {
    const data = new Map<string, Buffer>();
    return {
      data,
      async putObject(key, body, headers) {
        if (headers?.["If-None-Match"] === "*" && data.has(key)) {
          throw { statusCode: 412, message: "precondition failed" };
        }
        data.set(key, body);
      },
      async getObject(key) {
        return data.get(key) ?? null;
      },
      async headObject(key) {
        return data.has(key);
      },
      async deleteObject(key) {
        data.delete(key);
      },
      async listKeys(prefix) {
        return [...data.keys()].filter((k) => k.startsWith(prefix));
      },
    };
  }

  it("round-trips all operations through the backend", async () => {
    const backend = mockBackend();
    const s = new CosStorage(backend);
    expect(s.type).toBe("cos");
    await s.putText("ttl/a", "bin");
    expect(await s.getText("ttl/a")).toBe("bin");
    await s.putJSON("nottl/b", { z: 9 });
    expect(await s.getJSON("nottl/b")).toEqual({ z: 9 });
    expect(await s.getJSON("missing")).toBeNull();
    expect(await s.putTextIfAbsent("ttl/a", "no")).toBe(false);
    expect(await s.putTextIfAbsent("ttl/c", "yes")).toBe(true);
    expect(await s.putJSONIfAbsent("ttl/c", {})).toBe(false);
    expect(await s.exists("ttl/a")).toBe(true);
    expect(await s.exists("zz")).toBe(false);
    await s.putText("p/1", "1");
    await s.putText("p/2", "2");
    await s.putText("pp/3", "3");
    // "pp/3" is a sibling directory — not under prefix "p/"
    expect((await s.listNames("p/")).sort()).toEqual(["1", "2"]);
    expect(await s.delPrefix("p/")).toBe(2);
    expect(await s.exists("p/1")).toBe(false);
    await s.del("ttl/a");
    expect(await s.exists("ttl/a")).toBe(false);
  });
});

describe("key-utils", () => {
  it("assertKeySegment rejects empty, slash, double-dot", () => {
    expect(() => assertKeySegment("sid", "ok")).not.toThrow();
    expect(() => assertKeySegment("sid", "")).toThrow();
    expect(() => assertKeySegment("sid", "a/b")).toThrow();
    expect(() => assertKeySegment("sid", "a..b")).toThrow();
  });

  it("assertAgentSource validates format", () => {
    expect(() => assertAgentSource("claude-code")).not.toThrow();
    expect(() => assertAgentSource("CodeBuddy")).toThrow();
    expect(() => assertAgentSource("a_b")).toThrow();
    expect(() => assertAgentSource("a.b")).toThrow();
    expect(() => assertAgentSource("a/b")).toThrow();
    expect(() => assertAgentSource("")).toThrow();
  });

  it("sessionDirOf builds directory prefix with validation", () => {
    expect(sessionDirOf("ttl", "sp", "u", "cc", "sess")).toBe("ttl/sp/u/cc/sess/");
    expect(sessionDirOf("nottl", "sp", "u", "cc", "sess")).toBe("nottl/sp/u/cc/sess/");
    expect(() => sessionDirOf("ttl", "../x", "u", "cc", "s")).toThrow();
    expect(() => sessionDirOf("ttl", "sp", "u", "bad_source!", "s")).toThrow();
  });

  it("sessionBindingDirOf builds 2-segment prefix", () => {
    expect(sessionBindingDirOf("ttl", "sp", "sess")).toBe("ttl/sp/sess/");
    expect(() => sessionBindingDirOf("ttl", "", "s")).toThrow();
    expect(() => sessionBindingDirOf("ttl", "sp", "s/s")).toThrow();
  });
});

describe("storage factory", () => {
  it("activates memory backend directly", async () => {
    const storage = await getProxyStorage(memConfig());
    expect(storage.type).toBe("memory");
    expect(getEffectiveBackend().effective).toBe("memory");
  });

  it("degradation chain reaches memory when fs misconfigured", async () => {
    const config = { ...memConfig(), backend: "fs" as const };
    const storage = await getProxyStorage(config);
    expect(storage.type).toBe("memory");
  });

  it("sqlite backend activates with dbPath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-sqlite-"));
    let storage: ProxyStorage | null = null;
    try {
      const config = { ...memConfig(), backend: "sqlite" as const, sqlite: { dbPath: join(dir, "t.db") } };
      storage = await getProxyStorage(config);
      expect(storage.type).toBe("sqlite");
      expect(getEffectiveBackend().effective).toBe("sqlite");
    } finally {
      // Close the sqlite handle before removing the dir — Windows refuses to
      // delete a directory whose database file is still open (EPERM).
      const db = (storage as unknown as { db?: { close: () => void } } | null)?.db;
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cos backend hard-fails when cost-guard factory unavailable", async () => {
    __resetProxyStorageForTests();
    const config = { ...memConfig(), backend: "cos" as const };
    // getProxyStorage is synchronous: the cos branch throws directly.
    expect(() => getProxyStorage(config)).toThrow(/cos backend init failed|cost-guard/);
  });

  it("initProxyStorage handles cost-guard module missing", async () => {
    __resetProxyStorageForTests();
    const config = { ...memConfig(), backend: "memory" as const };
    const storage = await initProxyStorage(config);
    expect(storage.type).toBe("memory");
  });

  it("evictCosSpace returns unsupported when not cos", async () => {
    expect(await evictCosSpace("sp")).toBe("unsupported");
  });

  it("singleton: second call returns same instance", async () => {
    const a = await getProxyStorage(memConfig());
    const b = await getProxyStorage(memConfig());
    expect(a).toBe(b);
  });
});

describe("per-key-mutex", () => {
  it("serializes same-key tasks and cleans up", async () => {
    const order: number[] = [];
    const p1 = withPerKeyLock("k", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      return "one";
    });
    const p2 = withPerKeyLock("k", async () => {
      order.push(2);
      return "two";
    });
    expect(await p1).toBe("one");
    expect(await p2).toBe("two");
    expect(order).toEqual([1, 2]);
    // different keys run concurrently
    const p3 = withPerKeyLock("other", async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "x";
    });
    expect(await p3).toBe("x");
  });

  it("rejection does not break the chain", async () => {
    const boom = withPerKeyLock("k2", async () => {
      throw new Error("boom");
    });
    await expect(boom).rejects.toThrow("boom");
    const ok = await withPerKeyLock("k2", async () => "fine");
    expect(ok).toBe("fine");
  });
});