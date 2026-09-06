/**
 * callback.test.ts — Unit tests for TMC status/progress callbacks + summary generation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  callbackTMC,
  sendProgressCallback,
  buildProgressFn,
  generateWikiSummary,
  generateCodeGraphSummary,
} from "./callback.js";

const mocks = vi.hoisted(() => ({
  createLlmClient: vi.fn(),
  normalizeLlmConfig: vi.fn((c: unknown) => c),
}));

vi.mock("./engines/wiki/ingest-v2/llm.js", () => ({
  createLlmClient: mocks.createLlmClient,
  normalizeLlmConfig: mocks.normalizeLlmConfig,
}));

const PAYLOAD = {
  knowledge_id: "wiki-abcdef12",
  type: "wiki" as const,
  status: "ready" as const,
  summary: "s",
  sync_error: null,
  timestamp: "t",
};

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Partial<Response>>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const r = await impl(url, init);
    return r as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("callbackTMC", () => {
  it("no-ops when callback url is empty", async () => {
    const fetch = mockFetch(async () => ({ ok: true }));
    await callbackTMC(PAYLOAD, { tmcCallbackUrl: "" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts to url with trailing slash stripped; returns on ok", async () => {
    const fetch = mockFetch(async (url) => {
      expect(url).toBe("http://tmc/api/v1/knowledge/status-callback");
      return { ok: true };
    });
    await callbackTMC(PAYLOAD, { tmcCallbackUrl: "http://tmc/" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries once on non-ok response then gives up", async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(async (url) => ({ ok: false, status: 500, text: async () => "boom" }));
    const p = callbackTMC(PAYLOAD, { tmcCallbackUrl: "http://tmc" });
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    vi.useRealTimers();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("gave up"));
  });

  it("retries once on network error then gives up; unreadable resp text caught", async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(async (url) => {
      throw new Error("net down");
    });
    const p = callbackTMC(PAYLOAD, { tmcCallbackUrl: "http://tmc" });
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    vi.useRealTimers();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("gave up"));
  });

  it("handles resp.text() rejection", async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(async () => ({
      ok: false,
      status: 400,
      text: async () => {
        throw new Error("unreadable");
      },
    }));
    const p = callbackTMC(PAYLOAD, { tmcCallbackUrl: "http://tmc" });
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    vi.useRealTimers();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("(unreadable)"));
  });
});

describe("sendProgressCallback", () => {
  const progressPayload = {
    wiki_id: "wiki-x",
    service_id: "svc",
    team_id: "team",
    event: "ingest_progress" as const,
    progress: { phase: "scan", done: 1, total: 2 } as never,
  };

  it("no-ops without url", () => {
    const fetch = mockFetch(async () => ({ ok: true }));
    sendProgressCallback("", progressPayload);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fires fetch with url and payload; swallows rejection", async () => {
    const fetch = mockFetch(async () => {
      throw new Error("fail");
    });
    sendProgressCallback("http://tmc/", progressPayload);
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("buildProgressFn", () => {
  it("builds a ProgressFn invoking sendProgressCallback with/without run_id", async () => {
    const fetch = mockFetch(async () => ({ ok: true }));
    const fnWithRun = buildProgressFn("http://tmc", "wiki-x", "svc", "team", "run-1");
    fnWithRun({ phase: "extract", done: 1, total: 1 } as never);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.run_id).toBe("run-1");
    expect(body.event).toBe("ingest_progress");

    const fnNoRun = buildProgressFn("http://tmc", "wiki-x", "svc", "team");
    fnNoRun({ phase: "extract", done: 1, total: 1 } as never);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const [, init2] = fetch.mock.calls[1] as [string, RequestInit];
    const body2 = JSON.parse(String(init2.body));
    expect(body2.run_id).toBeUndefined();
  });

  it("returns a fn that no-ops when url empty", () => {
    const fetch = mockFetch(async () => ({ ok: true }));
    const fn = buildProgressFn("", "wiki-x", "svc", "team");
    fn({ phase: "extract", done: 0, total: 1 } as never);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("generateWikiSummary", () => {
  const llmBase = { model: "m", protocol: "openai", mode: "custom", provider: "p", apiKey: "k", baseUrl: "http://l", maxTokens: 100, timeoutMs: 100 } as never;

  it("returns empty when no pages", async () => {
    const res = await generateWikiSummary("wiki-x", "name", [], llmBase);
    expect(res).toBe("");
    expect(mocks.createLlmClient).not.toHaveBeenCalled();
  });

  it("calls llm and truncates to 256 chars", async () => {
    const client = { chat: vi.fn(async () => "x".repeat(400)) };
    mocks.createLlmClient.mockReturnValue(client);
    const res = await generateWikiSummary("wiki-x", "KB", [
      { title: "A", description: "d" },
      { title: "B" },
      { title: "C", description: "z".repeat(200) },
    ], llmBase);
    expect(res).toHaveLength(256);
    expect(mocks.normalizeLlmConfig).toHaveBeenCalledWith(llmBase);
    expect(client.chat).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 1024, temperature: 0.3 }));
    expect(String((client.chat as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt)).toContain("Knowledge base name:KB");
    expect(String((client.chat as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt)).toContain("- A: d");
  });

  it("returns empty when llm throws", async () => {
    mocks.createLlmClient.mockReturnValue({ chat: vi.fn(async () => {
      throw new Error("llm down");
    }) });
    const res = await generateWikiSummary("wiki-x", "KB", [{ title: "A" }], llmBase);
    expect(res).toBe("");
    expect(console.error).toHaveBeenCalled();
  });
});

describe("generateCodeGraphSummary", () => {
  it("formats with stats and slices to 256", () => {
    const s = generateCodeGraphSummary("repo", "main", { files: 10, nodes: 20, edges: 30 });
    expect(s).toBe("repo(main)- 10 files,20 symbol nodes");
  });

  it("falls back to name(branch) without stats", () => {
    expect(generateCodeGraphSummary("repo", "main", null)).toBe("repo（main）");
  });
});