import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  ensureKnowledgeLlmBinding,
  ensureKnowledgeLlmBindings,
  KNOWLEDGE_SERVICE_USERNAME,
  type KnowledgeLlmBindingOptions,
} from "../../src/panel/startup/ensure-knowledge-llm-binding.js";
import type { InstanceEntry } from "../../src/panel/config/instance-registry.js";

const OPTS: KnowledgeLlmBindingOptions = {
  knowledgeBaseUrl: "http://ks.example.com/",
  knowledgeAuthToken: "ktok",
  proxyBaseUrl: "http://proxy.example.com",
  timeoutMs: 5000,
};

const INSTANCE: InstanceEntry = {
  instance_id: "inst-1",
  gateway_endpoint: "http://gw.example.com",
  api_key: "gwkey",
} as InstanceEntry;

interface FetchCall {
  url: string;
  init: RequestInit & { signal?: AbortSignal };
}

function stubFetch(
  routes: Record<string, unknown | ((url: string) => unknown)>,
) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const match = Object.entries(routes).find(([prefix]) =>
      String(url).includes(prefix),
    );
    const value = match ? match[1] : { code: 0, data: {} };
    const payload =
      typeof value === "function" ? (value as (url: string) => unknown)(String(url)) : value;
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

beforeEach(() => {
  vi.restoreAllMocks();
  logger.info.mockReset();
  logger.warn.mockReset();
  logger.error.mockReset();
  logger.debug.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ensureKnowledgeLlmBinding", () => {
  it("throws when user/list returns non-zero (existing treated as undefined, create attempted)", async () => {
    const { calls } = stubFetch({
      "/v3/internal/llm-binding/set": { code: 0, data: {} },
      "/v3/meta/user/list": { code: 500, message: "boom", data: null },
      "/v3/meta/user/create": { code: 0, data: { user_id: "u", default_user_key: "k2" } },
    });
    const ks = new Map<string, never>();
    await expect(ensureKnowledgeLlmBinding(INSTANCE, OPTS, logger as never, ks)).resolves.toBe("bound");
    const createCall = calls.find((c) => c.url.includes("/v3/meta/user/create"))!;
    expect(JSON.parse(String(createCall.init.body)).username).toBe(KNOWLEDGE_SERVICE_USERNAME);
  });

  it("scenario A: cached has_api_key → only pushes proxy_base_url (no gateway user flow)", async () => {
    const { calls } = stubFetch({
      "/v3/internal/llm-binding/set": { code: 0, data: { ok: true } },
    });
    const ks = new Map([["inst-1", { service_id: "inst-1", mode: "proxy", proxy_base_url: null, base_url: null, has_api_key: true, enabled: true }]]);
    const out = await ensureKnowledgeLlmBinding(INSTANCE, OPTS, logger as never, ks);
    expect(out).toBe("bound");
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({ mode: "proxy", proxy_base_url: OPTS.proxyBaseUrl, enabled: true });
    expect(body.api_key).toBeUndefined();
    expect(calls[0].url).toContain("/v3/internal/llm-binding/set");
    // service-id header present for /set
    expect((calls[0].init.headers as Record<string, string>)["x-tdai-service-id"]).toBe("inst-1");
    expect(logger.info).toHaveBeenCalledWith("knowledge llm-binding refreshed (key retained)", expect.anything());
  });

  it("scenario B: no existing user → user/list empty, user/create, then set with new key", async () => {
    const { calls } = stubFetch({
      "/v3/internal/llm-binding/set": {
        code: 0, data: { ok: true },
      },
      "/v3/meta/user/list": {
        code: 0, data: { items: [] },
      },
      "/v3/meta/user/create": {
        code: 0, data: { user_id: "knowledge-service", default_user_key: "new-key-1" },
      },
    });
    const ks = new Map<string, never>();
    const out = await ensureKnowledgeLlmBinding(INSTANCE, OPTS, logger as never, ks);
    expect(out).toBe("bound");
    const urls = calls.map((c) => c.url);
    expect(urls.some((u) => u.includes("/v3/meta/user/list"))).toBe(true);
    expect(urls.some((u) => u.includes("/v3/meta/user/create"))).toBe(true);
    const setCall = calls.find((c) => c.url.includes("/llm-binding/set"))!;
    expect(JSON.parse(String(setCall.init.body))).toEqual({
      mode: "proxy",
      proxy_base_url: OPTS.proxyBaseUrl,
      api_key: "new-key-1",
      enabled: true,
    });
    expect(logger.info).toHaveBeenCalledWith("created knowledge-service user", expect.anything());
  });

  it("scenario B: existing user found → mints a new user key then pushes", async () => {
    const { calls } = stubFetch({
      "/v3/internal/llm-binding/set": { code: 0, data: {} },
      "/v3/meta/user/list": {
        code: 0,
        data: { items: [{ user_id: "knowledge-service", username: KNOWLEDGE_SERVICE_USERNAME }] },
      },
      "/v3/meta/user-key/create": { code: 0, data: { key_value: "minted-9" } },
    });
    const ks = new Map<string, never>();
    const out = await ensureKnowledgeLlmBinding(INSTANCE, OPTS, logger as never, ks);
    expect(out).toBe("bound");
    const urls = calls.map((c) => c.url);
    expect(urls.some((u) => u.includes("/v3/meta/user/create"))).toBe(false);
    const mintCall = calls.find((c) => c.url.includes("/user-key/create"))!;
    expect(JSON.parse(String(mintCall.init.body)).user_id).toBe("knowledge-service");
    const setCall = calls.find((c) => c.url.includes("/llm-binding/set"))!;
    expect(JSON.parse(String(setCall.init.body)).api_key).toBe("minted-9");
  });

  it("throws when user/create fails with non-zero envelope", async () => {
    stubFetch({
      "/v3/meta/user/list": { code: 0, data: { items: [] } },
      "/v3/meta/user/create": { code: 40001, message: "dup", data: null },
    });
    const ks = new Map<string, never>();
    await expect(
      ensureKnowledgeLlmBinding(INSTANCE, OPTS, logger as never, ks),
    ).rejects.toThrow(/user\/create failed/);
  });

  it("throws when KS /set returns non-zero code", async () => {
    stubFetch({
      "/v3/internal/llm-binding/list": { code: 0, data: {} },
      "/v3/internal/llm-binding/set": { code: 500, message: "nope", data: null },
    });
    const ks = new Map([["inst-1", { has_api_key: true } as never]]);
    await expect(
      ensureKnowledgeLlmBinding(INSTANCE, OPTS, logger as never, ks),
    ).rejects.toThrow(/KS .* failed/);
  });

  it("throws when KS response is not JSON", async () => {
    const fn = vi.fn(async () => new Response("not json", { status: 200 }));
    vi.stubGlobal("fetch", fn);
    const ks = new Map([["inst-1", { has_api_key: true } as never]]);
    await expect(
      ensureKnowledgeLlmBinding(INSTANCE, OPTS, logger as never, ks),
    ).rejects.toThrow();
  });

  it("aborts via timeout signal", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      });
      throw new Error("unreachable");
    });
    vi.stubGlobal("fetch", fn);
    const ks = new Map([["inst-1", { has_api_key: true } as never]]);
    const p = ensureKnowledgeLlmBinding(INSTANCE, OPTS, logger as never, ks);
    p.catch(() => {}); // avoid unhandled-rejection window while timers advance
    await vi.advanceTimersByTimeAsync(5001);
    await expect(p).rejects.toThrow("aborted");
  });

  it("scenario B mint: no Authorization header leak to KS /list (no service id)", async () => {
    const { calls } = stubFetch({});
    const ksBindings = new Map<string, never>();
    await ensureKnowledgeLlmBindings([], OPTS, logger as never, ksBindings);
    // /list called without service-id header
    const listCall = calls.find((c) => c.url.includes("/llm-binding/list"))!;
    expect((listCall.init.headers as Record<string, string>)["x-tdai-service-id"]).toBeUndefined();
    expect((listCall.init.headers as Record<string, string>).Authorization).toBe("Bearer ktok");
  });
});

describe("ensureKnowledgeLlmBindings", () => {
  it("fetches list once, caches bindings, and processes all instances best-effort", async () => {
    const { calls } = stubFetch({
      "/v3/internal/llm-binding/list": {
        code: 0,
        data: { items: [{ service_id: "inst-1", mode: "proxy", proxy_base_url: null, base_url: null, has_api_key: true, enabled: true }] },
      },
      "/v3/internal/llm-binding/set": { code: 0, data: {} },
    });
    await ensureKnowledgeLlmBindings([INSTANCE], OPTS, logger as never);
    const listCalls = calls.filter((c) => c.url.includes("/llm-binding/list"));
    expect(listCalls).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith("fetched KS llm-binding list", { count: 1 });
  });

  it("fallback: list failure → per-instance mint flow still runs and errors are logged not thrown", async () => {
    const fn = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("/llm-binding/list")) {
        return new Response(JSON.stringify({ code: 1, message: "boom", data: null }), { status: 500 });
      }
      if (String(url).includes("/llm-binding/set")) return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
      if (String(url).includes("/v3/meta/user/list")) return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
      if (String(url).includes("/v3/meta/user/create")) return new Response(JSON.stringify({ code: 0, data: { user_id: "u", default_user_key: "k" } }), { status: 200 });
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", fn);
    await expect(
      ensureKnowledgeLlmBindings([INSTANCE, { ...INSTANCE, instance_id: "inst-2" }], OPTS, logger as never),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "failed to fetch KS llm-binding list, will mint per-instance",
      expect.anything(),
    );
  });

  it("per-instance errors are caught and logged as warn", async () => {
    const fn = vi.fn(async (url: string) => {
      if (String(url).includes("/llm-binding/list")) return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
      if (String(url).includes("/llm-binding/set")) return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
      if (String(url).includes("/v3/meta/user/list")) {
        // network failure for one instance
        throw new Error("net down");
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", fn);
    await expect(
      ensureKnowledgeLlmBindings([INSTANCE], OPTS, logger as never),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "knowledge llm-binding ensure failed (will rely on manual recovery)",
      expect.anything(),
    );
  });

  it("no instances → only the list call", async () => {
    const { calls } = stubFetch({});
    await ensureKnowledgeLlmBindings([], OPTS, logger as never);
    expect(calls.every((c) => c.url.includes("/llm-binding/list"))).toBe(true);
  });
});