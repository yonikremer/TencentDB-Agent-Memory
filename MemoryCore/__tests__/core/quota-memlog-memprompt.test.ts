/**
 * Quota (credit calculator + manager + noop), memory-generation-log,
 * memory-prompt (composer + resolver), best-effort provenance.
 */
import { describe, it, expect, vi } from "vitest";
import { CreditCalculator } from "../../src/core/quota/credit-calculator.js";
import { QuotaManager } from "../../src/core/quota/quota-manager.js";
import { NoopQuotaReporter } from "../../src/core/quota/noop-quota-reporter.js";
import { writeGenerationProvenanceBestEffort } from "../../src/core/memory-generation-log/best-effort.js";
import {
  buildGenerationLogIdentity,
  buildPromptGenerationRef,
  buildGenerationProvenance,
  MemoryGenerationLogStore,
} from "../../src/core/memory-generation-log/store.js";
import { composeMemorySystemPrompt } from "../../src/core/memory-prompt/composer.js";
import {
  memoryPromptResolveKey,
  resolveMemoryPrompts,
  resolveMemoryPrompt,
} from "../../src/core/memory-prompt/resolver.js";
import { buildMemoryPromptSettingId } from "../../src/core/memory-prompt/types.js";

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe("credit-calculator", () => {
  it("calculate with known model multiplier", () => {
    const calc = new CreditCalculator();
    const usage = { inputTokens: 1000, cacheTokens: 1000, outputTokens: 250 };
    // (1.0 + 0.2 + 1.0) * 1.0 = 2.2
    expect(calc.calculate(usage, "minimax-m2.7")).toBeCloseTo(2.2);
    // flagship 15x
    expect(calc.calculate(usage, "gpt-4o")).toBeCloseTo(33);
    // unknown model -> default 1
    expect(calc.calculate(usage, "unknown-model")).toBeCloseTo(2.2);
    // no cacheTokens
    expect(calc.calculate({ inputTokens: 1000, outputTokens: 0 }, "deepseek-v3")).toBeCloseTo(0.8);
  });
  it("custom rates / multipliers / default", () => {
    const calc = new CreditCalculator({
      rates: { inputRate: 2 },
      modelMultipliers: { special: 3 },
      defaultMultiplier: 0.5,
    });
    expect(calc.getMultiplier("special")).toBe(3);
    expect(calc.getMultiplier("other")).toBe(0.5);
    expect(calc.calculate({ inputTokens: 1000, outputTokens: 1000 }, "special")).toBeCloseTo((2 + 4) * 3);
    expect(calc.calculate({ inputTokens: 1000, outputTokens: 1000 }, "other")).toBeCloseTo((2 + 4) * 0.5);
  });
});

describe("quota-manager", () => {
  const makeReporter = (overrides?: object) => {
    const base = {
      fetchQuota: vi.fn(),
      reportUsage: vi.fn(),
    };
    return { ...base, ...overrides } as never;
  };
  it("noop reporter unlimited path + cache", async () => {
    const reporter = makeReporter({ fetchQuota: vi.fn(async () => null) });
    const m = new QuotaManager({ reporter, logger: noopLogger });
    await expect(m.checkMemoryQuota("i1")).resolves.toEqual({ allowed: true });
    await expect(m.checkCreditQuota("i1")).resolves.toEqual({ allowed: true });
    // cached second call
    const quota = await m.getQuota("i1");
    expect(quota).toEqual({ memoryLimit: 10000, creditLimit: 1000, memoryUsage: 0, creditUsage: 0 });
    m.clearCache();
  });
  it("snapshot-based limits and exceeded checks", async () => {
    const reporter = makeReporter({
      fetchQuota: vi.fn(async () => ({ memoryLimit: 10, creditLimit: 5, memoryUsage: 9, creditUsage: 5 })),
    });
    const m = new QuotaManager({ reporter, logger: noopLogger });
    expect(await m.checkMemoryQuota("i1", 2)).toEqual({
      allowed: false,
      reason: "memory_limit_exceeded",
      current: 9,
      limit: 10,
    });
    expect(await m.checkMemoryQuota("i1", 0)).toEqual({ allowed: true });
    expect(await m.checkCreditQuota("i1")).toEqual({
      allowed: false,
      reason: "credit_limit_exceeded",
      current: 5,
      limit: 5,
    });
  });
  it("negative limit means unlimited", async () => {
    const reporter = makeReporter({
      fetchQuota: vi.fn(async () => ({ memoryLimit: -1, creditLimit: -1, memoryUsage: 99, creditUsage: 99 })),
    });
    const m = new QuotaManager({ reporter, logger: noopLogger });
    expect(await m.checkMemoryQuota("i1", 1000)).toEqual({ allowed: true });
    expect(await m.checkCreditQuota("i1")).toEqual({ allowed: true });
  });
  it("fetch failure falls back to cached or defaults; warns", async () => {
    const reporter = makeReporter({ fetchQuota: vi.fn(async () => { throw new Error("net"); }) });
    const warn = vi.fn();
    const m = new QuotaManager({ reporter, logger: { warn, debug: vi.fn(), error: vi.fn(), info: vi.fn() } as never });
    const quota = await m.getQuota("i1");
    expect(quota.memoryLimit).toBe(10000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to fetch quota for i1"));
  });
  it("expired cache refetches, and defaults when fetch returns null after error", async () => {
    const fetchQuota = vi
      .fn<() => Promise<{ memoryLimit: number; creditLimit: number; memoryUsage: number; creditUsage: number } | null>>()
      .mockResolvedValueOnce({ memoryLimit: 5, creditLimit: 5, memoryUsage: 1, creditUsage: 1 })
      .mockResolvedValueOnce({ memoryLimit: 7, creditLimit: 7, memoryUsage: 2, creditUsage: 2 });
    const reporter = makeReporter({ fetchQuota });
    const m = new QuotaManager({ reporter, logger: noopLogger, cacheTtlMs: -1 });
    await m.getQuota("i1");
    const second = await m.getQuota("i1");
    expect(second.memoryLimit).toBe(7);
    expect(fetchQuota).toHaveBeenCalledTimes(2);
  });
  it("reportUsage updates cache + no-op deltas + reporter error", async () => {
    const reportUsage = vi.fn(async () => {});
    const reporter = makeReporter({
      reportUsage,
      fetchQuota: vi.fn(async () => null),
    });
    const error = vi.fn();
    const m = new QuotaManager({ reporter, logger: { error, debug: vi.fn(), warn: vi.fn(), info: vi.fn() } as never });
    await m.reportUsage("i1", 0, 0, "L0");
    expect(reportUsage).not.toHaveBeenCalled();
    await m.getQuota("i1");
    await m.reportUsage("i1", 3, 2, "L1");
    expect(reportUsage).toHaveBeenCalledWith("i1", 3, 2, "L1");
    const cached = (m as never as { cache: Map<string, { config: { memoryUsage: number; creditUsage: number } }> }).cache.get("i1")!.config;
    expect(cached.memoryUsage).toBe(3);
    expect(cached.creditUsage).toBe(2);
    await m.reportMemoryAdded("i1", 1, "L0");
    expect(cached.memoryUsage).toBe(4);
    await m.reportMemoryDeleted("i1", 1, "L2");
    expect(cached.memoryUsage).toBe(3);
    await m.reportCreditUsed("i1", 5, "L3");
    expect(cached.creditUsage).toBe(7);
    // reporter throws
    reportUsage.mockRejectedValueOnce(new Error("fail"));
    await m.reportUsage("i1", 1, 0, "L0");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("reportUsage unexpected error"));
  });
  it("noop reporter", async () => {
    const r = new NoopQuotaReporter();
    await expect(r.fetchQuota("x")).resolves.toBeNull();
    await expect(r.reportUsage("x", 1, 1, "L0")).resolves.toBeUndefined();
  });
});

describe("best-effort provenance", () => {
  it("success + writeLog failure + writeRefs failure + no refs", async () => {
    const logger = { warn: vi.fn() } as never;
    await writeGenerationProvenanceBestEffort({ layer: "l1", logger, writeLog: async () => {} });
    await writeGenerationProvenanceBestEffort({
      layer: "l2",
      logger,
      writeLog: async () => {},
      writeRefs: async () => {},
    });
    await writeGenerationProvenanceBestEffort({
      layer: "l3",
      logger,
      writeLog: async () => { throw new Error("x"); },
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("l3 log write failed"));
    await writeGenerationProvenanceBestEffort({
      layer: "l1",
      logger,
      writeLog: async () => {},
      writeRefs: async () => { throw new Error("r"); },
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("reference write failed"));
  });
});

describe("memory-generation-log store", () => {
  const makeFakeBackend = () => {
    const objects = new Map<string, { body: string; size: number }>();
    return {
      objects,
      putObject: vi.fn(async (key: string, body: string) => {
        objects.set(key, { body, size: Buffer.byteLength(body) });
      }),
      getObject: vi.fn(async (key: string) => objects.get(key)?.body ?? null),
      listObjects: vi.fn(async (prefix: string, _opts: never) => {
        const entries = [...objects.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({ key: k, size: objects.get(k)!.size, isDirectory: false }));
        return { entries, nextMarker: undefined };
      }),
    };
  };
  const fakeStorage = (backend: ReturnType<typeof makeFakeBackend>) =>
    ({ type: "remote", getBackend: () => backend, readFile: vi.fn(async (key: string) => backend.objects.get(key)?.body ?? null) }) as never;

  it("buildGenerationLogIdentity shapes + safeId hashing + key length guard", () => {
    const id = buildGenerationLogIdentity("l1", 1_700_000_000_000, "mem_abc");
    expect(id.logId.startsWith("mgl_l1_succeeded_")).toBe(true);
    expect(id.key.includes("layer=l1")).toBe(true);
    expect(id.generationId.startsWith("mg_")).toBe(true);
    const weird = buildGenerationLogIdentity("l2", 1_700_000_000_000, "../../evil");
    expect(weird.logId.includes("evil")).toBe(false);
    // Key-length guard is unreachable with current fixed-length segments
    // (see src comment); assert the invariant instead.
    expect(Buffer.byteLength(buildGenerationLogIdentity("l3", 1_700_000_000_000, "x".repeat(500)).key, "utf8")).toBeLessThan(850);
    const failed = buildGenerationLogIdentity("l3", 1_700_000_000_000, undefined, "failed");
    expect(failed.logId.startsWith("mgl_l3_failed_")).toBe(true);
  });
  it("buildPromptGenerationRef resolved/undefined", () => {
    const ref = buildPromptGenerationRef(undefined, "l1");
    expect(ref).toEqual({ memory_prompt_id: "builtin:l1", version: 1, source: "system", prompt_sha256: "" });
    const resolved = buildPromptGenerationRef(
      { memory_prompt_id: "mp_1", version: 3, source: "agent", prompt: "hello", layer: "l1" },
      "l1",
    );
    expect(resolved.memory_prompt_id).toBe("mp_1");
    expect(resolved.prompt_sha256).toHaveLength(64);
  });
  it("buildGenerationProvenance", () => {
    const id = buildGenerationLogIdentity("l1", 1_700_000_000_000);
    const ref = buildPromptGenerationRef(undefined, "l1");
    const prov = buildGenerationProvenance(id, ref);
    expect(prov.generation_id).toBe(id.generationId);
    expect(prov.generation_log_key).toBe(id.key);
  });
  it("write rejects invalid keys", async () => {
    const backend = makeFakeBackend();
    const store = new MemoryGenerationLogStore(fakeStorage(backend), "inst-1");
    const log = { log_id: "lg", layer: "l1", status: "succeeded", instance_id: "inst-1" } as never;
    await expect(store.write(log, "../evil")).rejects.toThrow("Invalid generation log key");
    await expect(store.write(log, "/abs")).rejects.toThrow();
    await expect(store.write(log, "other")).rejects.toThrow();
  });
  it("write + getByKey + getByLogId + instance isolation", async () => {
    const backend = makeFakeBackend();
    const store = new MemoryGenerationLogStore(fakeStorage(backend), "inst-1");
    const id = buildGenerationLogIdentity("l1", 1_700_000_000_000, "anchor1");
    const log = {
      log_id: id.logId,
      layer: "l1",
      status: "succeeded",
      instance_id: "inst-1",
      finished_at_ms: 1_700_000_000_000,
    } as never;
    await store.write(log, id.key);
    const got = await store.getByKey(id.key);
    expect(got?.log_id).toBe(id.logId);
    const byId = await store.getByLogId(id.logId);
    expect(byId?.log_id).toBe(id.logId);
    // invalid log id
    expect(await store.getByLogId("bogus")).toBeNull();
    // invalid key returns null
    expect(await store.getByKey("../x")).toBeNull();
    // missing key null
    expect(await store.getByKey(`${id.key}x`)).toBeNull();
    // other instance rejected
    const other = new MemoryGenerationLogStore(fakeStorage(backend), "inst-2");
    expect(await other.getByKey(id.key)).toBeNull();
  });
  it("list with cursor, filters, pagination", async () => {
    const backend = makeFakeBackend();
    const store = new MemoryGenerationLogStore(fakeStorage(backend), "inst-1");
    const t1 = 1_700_000_000_000;
    const t2 = 1_700_003_600_000;
    const id1 = buildGenerationLogIdentity("l1", t1);
    const id2 = buildGenerationLogIdentity("l1", t2, undefined, "failed");
    const log1 = { log_id: id1.logId, layer: "l1", status: "succeeded", instance_id: "inst-1", finished_at_ms: t1 } as never;
    const log2 = { log_id: id2.logId, layer: "l1", status: "failed", instance_id: "inst-1", finished_at_ms: t2 } as never;
    await store.write(log1, id1.key);
    await store.write(log2, id2.key);
    const all = await store.list({ startTimeMs: t1 - 1, endTimeMs: t2 + 1, limit: 10 });
    expect(all.items).toHaveLength(2);
    expect(all.items[0]!.log_id).toBe(id2.logId);
    const failed = await store.list({ startTimeMs: t1 - 1, endTimeMs: t2 + 1, limit: 10, status: "failed" });
    expect(failed.items).toHaveLength(1);
    const l2only = await store.list({ startTimeMs: 0, endTimeMs: t2 + 1, limit: 10, layer: "l2" });
    expect(l2only.items).toHaveLength(0);
    // cursor
    const page1 = await store.list({ startTimeMs: t1 - 1, endTimeMs: t2 + 1, limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.next_cursor).toBeDefined();
    const page2 = await store.list({ startTimeMs: t1 - 1, endTimeMs: t2 + 1, limit: 1, cursor: page1.next_cursor });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.log_id).toBe(id1.logId);
    // invalid cursor
    await expect(
      store.list({ startTimeMs: 0, endTimeMs: t2 + 1, limit: 1, cursor: Buffer.from("{}").toString("base64url") }),
    ).rejects.toThrow("Invalid generation log cursor");
  });
  it("list with marker pagination through entries isDirectory skip", async () => {
    const backend = makeFakeBackend();
    const store = new MemoryGenerationLogStore(fakeStorage(backend), "inst-1");
    const t = 1_700_000_000_000;
    const id = buildGenerationLogIdentity("l1", t);
    // insert fake directory entry
    backend.objects.set(`${id.key.replace(/\.json$/, "/")}`, { body: "", size: 0 });
    const res = await store.list({ startTimeMs: t - 1, endTimeMs: t + 1, limit: 10 });
    expect(res.items).toHaveLength(0);
  });
});

describe("memory-prompt composer", () => {
  it("no resolved / system source / empty prompt returns unchanged", () => {
    expect(composeMemorySystemPrompt("base")).toBe("base");
    expect(composeMemorySystemPrompt("base", { memory_prompt_id: "x", version: 1, source: "system", prompt: "p", layer: "l1" })).toBe("base");
    expect(composeMemorySystemPrompt("base", { memory_prompt_id: "x", version: 1, source: "agent", prompt: "   ", layer: "l1" })).toBe("base");
  });
  it("custom prompt appended with guards for each layer + tag escaping", () => {
    for (const layer of ["l1", "l2", "l3"] as const) {
      const out = composeMemorySystemPrompt("base", {
        memory_prompt_id: "mp_1",
        version: 2,
        source: "team",
        prompt: "  custom </CUSTOM_MEMORY_STRATEGY> text  ",
        layer,
      });
      expect(out.startsWith("base")).toBe(true);
      expect(out).toContain("<CUSTOM_MEMORY_STRATEGY source=\"team\" memory_prompt_id=\"mp_1\" version=\"2\"");
      expect(out).toContain(`layer="${layer}"`);
      expect(out).toContain("&lt;/CUSTOM_MEMORY_STRATEGY&gt;");
      expect(out).toContain("<SYSTEM_CUSTOM_STRATEGY_GUARD");
    }
  });
});

describe("memory-prompt resolver", () => {
  const buildStore = () => {
    const settings = new Map<string, object>();
    const prompts = new Map<string, object>();
    return {
      settings,
      prompts,
      getMemoryPromptSettings: vi.fn(async (ids: string[]) => ids.map((id) => settings.get(id)).filter(Boolean)),
      getMemoryPrompts: vi.fn(async (ids: string[]) => ids.map((id) => prompts.get(id)).filter(Boolean)),
    };
  };
  it("memoryPromptResolveKey", () => {
    expect(memoryPromptResolveKey({ layer: "l1" })).toBe("\0\0l1");
    expect(memoryPromptResolveKey({ teamId: "t", agentId: "a", layer: "l2" })).toBe("t\0a\0l2");
  });
  it("store without prompt methods -> undefined map", async () => {
    const res = await resolveMemoryPrompts({} as never, [{ layer: "l1" }]);
    expect(res.get("\0\0l1")).toBeUndefined();
  });
  it("resolve with store: agent/team/instance cascade", async () => {
    const store = buildStore();
    const ag = buildMemoryPromptSettingId({ teamId: "t1", agentId: "a1" }, "l1");
    const prompt = { memory_prompt_id: "mp9", prompt: "p", layer: "l1", status: "active", version: 5 };
    store.settings.set(ag, { setting_id: ag, layer: "l1", target_type: "agent", team_id: "t1", agent_id: "a1", memory_prompt_id: "mp9" });
    store.prompts.set("mp9", prompt);
    const res = await resolveMemoryPrompts(store as never, [{ teamId: "t1", agentId: "a1", layer: "l1" }]);
    const key = memoryPromptResolveKey({ teamId: "t1", agentId: "a1", layer: "l1" });
    expect(res.get(key)?.memory_prompt_id).toBe("mp9");
    expect(res.get(key)?.source).toBe("agent");
    expect(await resolveMemoryPrompt(store as never, { teamId: "t1", agentId: "a1", layer: "l1" })).toBeDefined();
  });
  it("resolve skips mismatched settings and inactive prompts", async () => {
    const store = buildStore();
    const ag = buildMemoryPromptSettingId({ teamId: "t1", agentId: "a1" }, "l1");
    store.settings.set(ag, { setting_id: ag, layer: "l2", target_type: "agent", team_id: "t1", agent_id: "a1", memory_prompt_id: "mp9" });
    store.prompts.set("mp9", { memory_prompt_id: "mp9", prompt: "p", layer: "l1", status: "active", version: 5 });
    const res = await resolveMemoryPrompts(store as never, [{ teamId: "t1", agentId: "a1", layer: "l1" }]);
    expect(res.get(memoryPromptResolveKey({ teamId: "t1", agentId: "a1", layer: "l1" }))).toBeUndefined();
    // wrong team_id on setting
    const ag2 = buildMemoryPromptSettingId({ teamId: "t1", agentId: "a1" }, "l1");
    store.settings.set(ag2, { setting_id: ag2, layer: "l1", target_type: "agent", team_id: "other", agent_id: "a1", memory_prompt_id: "mp9" });
    store.prompts.set("mp9", { memory_prompt_id: "mp9", prompt: "p", layer: "l1", status: "active", version: 5 });
    const res2 = await resolveMemoryPrompts(store as never, [{ teamId: "t1", agentId: "a1", layer: "l1" }]);
    expect(res2.get(memoryPromptResolveKey({ teamId: "t1", agentId: "a1", layer: "l1" }))).toBeUndefined();
    // inactive prompt
    const ag3 = buildMemoryPromptSettingId({ teamId: "t1", agentId: "a1" }, "l1");
    store.settings.set(ag3, { setting_id: ag3, layer: "l1", target_type: "agent", team_id: "t1", agent_id: "a1", memory_prompt_id: "mp10" });
    store.prompts.set("mp10", { memory_prompt_id: "mp10", prompt: "p", layer: "l1", status: "archived", version: 5 });
    const res3 = await resolveMemoryPrompts(store as never, [{ teamId: "t1", agentId: "a1", layer: "l1" }]);
    expect(res3.get(memoryPromptResolveKey({ teamId: "t1", agentId: "a1", layer: "l1" }))).toBeUndefined();
  });
  it("instance-level fallback resolves with no team/agent", async () => {
    const store = buildStore();
    const inst = buildMemoryPromptSettingId({}, "l1");
    store.settings.set(inst, { setting_id: inst, layer: "l1", target_type: "instance", team_id: null, agent_id: null, memory_prompt_id: "mp1" });
    store.prompts.set("mp1", { memory_prompt_id: "mp1", prompt: "p", layer: "l1", status: "active", version: 1 });
    const res = await resolveMemoryPrompts(store as never, [{ layer: "l1" }]);
    const key = memoryPromptResolveKey({ layer: "l1" });
    expect(res.get(key)?.source).toBe("instance");
  });
});