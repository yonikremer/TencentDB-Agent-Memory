import { describe, expect, it, vi, beforeEach } from "vitest";
import { getActualInputTokens } from "../usage.js";
import {
  RedisRateLimitStore,
  dimensionField,
  type RateLimitDecision,
} from "../redis-store.js";
import {
  enforceRateLimit,
  recordInputTokenUsage,
  buildRateLimitResponse,
  isRateLimitExceededError,
  RateLimitExceededError,
  __resetRateLimitStoreForTests,
  __setRateLimitStoreForTests,
} from "../guard.js";

describe("getActualInputTokens", () => {
  it("returns 0 for missing usage", () => {
    expect(getActualInputTokens(null, "openai")).toBe(0);
    expect(getActualInputTokens(undefined, "anthropic")).toBe(0);
  });

  it("openai reads prompt_tokens", () => {
    expect(getActualInputTokens({ prompt_tokens: 123 }, "openai")).toBe(123);
    expect(getActualInputTokens({ prompt_tokens: "50" }, "openai")).toBe(50);
    expect(getActualInputTokens({ prompt_tokens: "abc" }, "openai")).toBe(0);
    expect(getActualInputTokens({ prompt_tokens: -5 }, "openai")).toBe(0);
    expect(getActualInputTokens({ prompt_tokens: 1.9 }, "openai")).toBe(1);
  });

  it("anthropic sums input + cache reads + cache creation", () => {
    expect(getActualInputTokens(
      { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
      "anthropic",
    )).toBe(18);
    expect(getActualInputTokens({ input_tokens: "4", cache_read_input_tokens: 1.5, cache_creation_input_tokens: "x" }, "anthropic")).toBe(5);
  });
});

function fakeRedisClient(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    calls,
    eval: vi.fn(async (lua: string, numKeys: number, ...args: unknown[]) => {
      calls.push("eval");
      if (typeof overrides.evalResult !== "undefined") return overrides.evalResult;
      return [1, 0, 1000, 10, 5, 2, 995, 8, 0];
    }) as unknown as RedisRateLimitStore["client"],
    hmget: vi.fn(async (key: string, ...fields: string[]) => ["7", "3"]),
    hset: vi.fn(async () => 1),
    hdel: vi.fn(async () => 1),
    hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
  };
}

const rlConfig = { tpm: 1000, qpm: 10 };

describe("RedisRateLimitStore", () => {
  it("decides degraded when no client", async () => {
    const store = new RedisRateLimitStore(null, rlConfig);
    expect(store.isAvailable()).toBe(false);
    const decision = await store.checkRequest("inst", "model");
    expect(decision.degraded).toBe(true);
    expect(decision.allowed).toBe(true);
    expect(decision.degradedReason).toBe("redis_unavailable");
    expect(await store.recordInputTokens("i", "m", 5)).toBe(false);
    await expect(store.getLimits()).rejects.toThrow("Redis unavailable");
  });

  it("checkRequest maps eval result to decision", async () => {
    const client = fakeRedisClient({ evalResult: [1, 0, 1000, 10, 5, 2, 995, 8, 0] });
    const store = new RedisRateLimitStore(client as never, rlConfig);
    const decision = await store.checkRequest("inst", "model-x");
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeNull();
    expect(decision.tpm).toBe(1000);
    expect(decision.qpm).toBe(10);
    expect(decision.usedTokens).toBe(5);
    expect(decision.usedRequests).toBe(2);
    expect(decision.remainingTokens).toBe(995);
    expect(decision.remainingRequests).toBe(8);
    expect(decision.retryAfterSeconds).toBe(0);
  });

  it("checkRequest maps tpm/qpm rejections", async () => {
    const client1 = fakeRedisClient({ evalResult: [0, 1, 1000, 10, 1000, 9, 0, 1, 12] });
    const d1 = await new RedisRateLimitStore(client1 as never, rlConfig).checkRequest("i", "m");
    expect(d1.allowed).toBe(false);
    expect(d1.reason).toBe("tpm");

    const client2 = fakeRedisClient({ evalResult: [0, 2, 1000, 10, 5, 10, 995, 0, 30] });
    const d2 = await new RedisRateLimitStore(client2 as never, rlConfig).checkRequest("i", "m");
    expect(d2.allowed).toBe(false);
    expect(d2.reason).toBe("qpm");
  });

  it("checkRequest degrades on eval error", async () => {
    const client = fakeRedisClient();
    client.eval.mockRejectedValueOnce(new Error("conn refused"));
    const decision = await new RedisRateLimitStore(client as never, rlConfig).checkRequest("i", "m");
    expect(decision.degraded).toBe(true);
    expect(decision.degradedReason).toContain("conn refused");
  });

  it("recordInputTokens records and logs failure", async () => {
    const client = fakeRedisClient();
    const store = new RedisRateLimitStore(client as never, rlConfig);
    expect(await store.recordInputTokens("i", "m", 100)).toBe(true);
    expect(await store.recordInputTokens("i", "m", 0)).toBe(false);
    client.eval.mockRejectedValueOnce(new Error("redis down"));
    expect(await store.recordInputTokens("i", "m", 50)).toBe(false);
  });

  it("limits CRUD", async () => {
    const client = fakeRedisClient();
    const store = new RedisRateLimitStore(client as never, rlConfig);
    expect(await store.getLimits()).toEqual({ tpm: 7, qpm: 3 });
    await store.setLimits({ tpm: 9 });
    await store.setLimits({});
    await store.deleteLimits();
    expect(client.hset).toHaveBeenCalled();
    expect(client.hdel).toHaveBeenCalled();
  });

  it("override CRUD", async () => {
    const client = fakeRedisClient();
    const store = new RedisRateLimitStore(client as never, rlConfig);
    client.hget.mockResolvedValueOnce(JSON.stringify({ tpm: 500, qpm: 5 }));
    expect(await store.getOverride("i1", "m1")).toEqual({ tpm: 500, qpm: 5 });
    client.hget.mockResolvedValueOnce(JSON.stringify("600"));
    expect(await store.getOverride("i1", "m1")).toEqual({ tpm: 600, qpm: 10 });
    client.hget.mockResolvedValueOnce("700");
    expect(await store.getOverride("i1", "m1")).toEqual({ tpm: 700, qpm: 10 });
    client.hget.mockResolvedValueOnce("not-json");
    expect(await store.getOverride("i1", "m1")).toEqual({ tpm: NaN, qpm: 10 });
    client.hget.mockResolvedValueOnce(null);
    expect(await store.getOverride("i1", "m1")).toBeNull();
    await store.setOverride("i1", "m1", { tpm: 1, qpm: 2 });
    await store.deleteOverride("i1", "m1");
    client.hgetall.mockResolvedValueOnce({
      [dimensionField("a", "b")]: JSON.stringify({ tpm: 3, qpm: 4 }),
      [dimensionField("x", "y")]: "8",
      "bad-field": "bad-value",
    });
    const all = await store.listOverrides();
    expect(all).toEqual([
      { instanceId: "a", modelId: "b", tpm: 3, qpm: 4 },
      { instanceId: "x", modelId: "y", tpm: 8, qpm: 10 },
    ]);
  });

  it("dimensionField round trips", () => {
    expect(JSON.parse(dimensionField("i", "m"))).toEqual(["i", "m"]);
  });
});

describe("guard.ts", () => {
  beforeEach(() => __resetRateLimitStoreForTests());

  const proxyConfig = {
    rateLimit: rlConfig,
    redis: { enabled: true, url: "" },
  } as unknown as Parameters<typeof enforceRateLimit>[0]["config"];

  it("skips when rate limit disabled or no instanceId", async () => {
    await enforceRateLimit({ config: { ...proxyConfig, rateLimit: { tpm: 0, qpm: 0 } }, modelId: "m", protocol: "openai" });
    await enforceRateLimit({ config: proxyConfig, modelId: "m", protocol: "openai" });
    await enforceRateLimit({ config: proxyConfig, instanceId: "i", modelId: "m", protocol: "openai" });
  });

  it("throws RateLimitExceededError when not allowed", async () => {
    const store = {
      checkRequest: vi.fn(async () => ({
        allowed: false,
        degraded: false,
        reason: "qpm",
        tpm: 1000,
        qpm: 10,
        usedTokens: 1,
        usedRequests: 10,
        remainingTokens: 999,
        remainingRequests: 0,
        retryAfterSeconds: 42,
      })),
    } as unknown as RedisRateLimitStore;
    __setRateLimitStoreForTests(store);
    await expect(
      enforceRateLimit({ config: proxyConfig, instanceId: "i", modelId: "m", protocol: "openai" }),
    ).rejects.toThrow(RateLimitExceededError);
  });

  it("fail-open when degraded (throttled warning)", async () => {
    const store = {
      checkRequest: vi.fn(async () => ({
        allowed: true,
        degraded: true,
        degradedReason: "redis_unavailable",
        reason: null,
        tpm: 1000,
        qpm: 10,
        usedTokens: 0,
        usedRequests: 0,
        remainingTokens: 1000,
        remainingRequests: 10,
        retryAfterSeconds: 0,
      })),
    } as unknown as RedisRateLimitStore;
    __setRateLimitStoreForTests(store);
    await enforceRateLimit({ config: proxyConfig, instanceId: "i", modelId: "m", protocol: "openai" });
    await enforceRateLimit({ config: proxyConfig, instanceId: "i", modelId: "m", protocol: "openai" }); // second call within 30s: no warn
    expect(store.checkRequest).toHaveBeenCalledTimes(2);
  });

  it("recordInputTokenUsage records when config present", async () => {
    const store = {
      recordInputTokens: vi.fn(async () => true),
    } as unknown as RedisRateLimitStore;
    __setRateLimitStoreForTests(store);
    await recordInputTokenUsage({ config: proxyConfig, instanceId: "i", modelId: "m", usage: { prompt_tokens: 55 }, protocol: "openai" });
    expect(store.recordInputTokens).toHaveBeenCalledWith("i", "m", 55);
    await recordInputTokenUsage({ config: proxyConfig, instanceId: "i", modelId: "m", usage: { prompt_tokens: 0 }, protocol: "openai" });
    await recordInputTokenUsage({ config: { ...proxyConfig, rateLimit: { tpm: 0, qpm: 0 } }, instanceId: "i", modelId: "m", usage: { prompt_tokens: 1 }, protocol: "openai" });
    expect(store.recordInputTokens).toHaveBeenCalledTimes(1);
  });

  it("buildRateLimitResponse formats 429 bodies", async () => {
    const decision: RateLimitDecision = {
      allowed: false, degraded: false, reason: "tpm", tpm: 5, qpm: 0,
      usedTokens: 5, usedRequests: 1, remainingTokens: 0, remainingRequests: 0, retryAfterSeconds: 3,
    };
    const anthropic = await buildRateLimitResponse("anthropic", decision).json();
    expect(anthropic.error.type).toBe("rate_limit_error");
    const openai = await buildRateLimitResponse("openai", decision).json();
    expect(openai.error.code).toBe("input_tpm_exceeded");
    const qpmResp = buildRateLimitResponse("openai", { ...decision, reason: "qpm" });
    const qpmJson = await qpmResp.json();
    expect(qpmJson.error.code).toBe("qpm_exceeded");
    expect(qpmResp.headers.get("retry-after")).toBe("3");
    expect(buildRateLimitResponse("openai", { ...decision, retryAfterSeconds: 0 }).headers.get("retry-after")).toBe("1");
  });

  it("isRateLimitExceededError discriminates", () => {
    const err = new RateLimitExceededError(new Response("x", { status: 429 }));
    expect(err.name).toBe("RateLimitExceededError");
    expect(err.response.status).toBe(429);
    expect(isRateLimitExceededError(err)).toBe(true);
    expect(isRateLimitExceededError(new Error("nope"))).toBe(false);
    expect(RateLimitExceededError.prototype).toBeDefined();
  });
});