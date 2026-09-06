import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => ({
    chat: vi.fn((model: string) => ({ provider: "openai", model })),
  })),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => ({
    chat: vi.fn((model: string) => ({ provider: "anthropic", model })),
  })),
}));

import { generateText, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { normalizeLlmConfig, createLlmClient } from "./llm.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("console", {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  } as unknown as typeof console);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeLlmConfig", () => {
  it("applies defaults for empty config", () => {
    const c = normalizeLlmConfig(undefined);
    expect(c).toEqual({
      protocol: "openai",
      baseUrl: "",
      apiKey: "",
      model: "Memory-Model",
      maxTokens: 8192,
      timeoutMs: 1_200_000,
      stream: false,
    });
  });

  it("maps customEndpoint/maxContextSize aliases and preserves explicit fields", () => {
    const c = normalizeLlmConfig({
      protocol: "anthropic",
      baseUrl: "http://x",
      apiKey: "k",
      model: "m",
      maxTokens: 10,
      timeoutMs: 20,
      stream: true,
    });
    expect(c).toEqual({ protocol: "anthropic", baseUrl: "http://x", apiKey: "k", model: "m", maxTokens: 10, timeoutMs: 20, stream: true });
    const c2 = normalizeLlmConfig({ customEndpoint: "http://y", maxContextSize: 99 });
    expect(c2.baseUrl).toBe("http://y");
    expect(c2.maxTokens).toBe(99);
  });
});

describe("createLlmClient.chat", () => {
  it("calls generateText for openai non-stream and returns trimmed text with usage log", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: "  hello  ",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      finishReason: "stop",
    } as never);
    const client = createLlmClient(normalizeLlmConfig({ apiKey: "k", baseUrl: "http://b", model: "m" }));
    const out = await client.chat({ system: "sys", prompt: "pr" });
    expect(out).toBe("hello");
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(createOpenAI).toHaveBeenCalled();
    const call = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
    expect(call).toMatchObject({ system: "sys", prompt: "pr", maxOutputTokens: 8192 });
  });

  it("uses streamText when stream=true", async () => {
    vi.mocked(streamText).mockReturnValue({
      text: Promise.resolve("  streamed  "),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 0, totalTokens: 5 }),
      finishReason: Promise.resolve("stop"),
    } as never);
    const client = createLlmClient(normalizeLlmConfig({ stream: true, model: "m" }));
    const out = await client.chat({ system: "s", prompt: "p" });
    expect(out).toBe("streamed");
    expect(streamText).toHaveBeenCalledTimes(1);
  });

  it("uses anthropic provider when protocol=anthropic", async () => {
    vi.mocked(generateText).mockResolvedValue({ text: "ok", usage: undefined, finishReason: "stop" } as never);
    const client = createLlmClient(normalizeLlmConfig({ protocol: "anthropic", apiKey: "k" }));
    await client.chat({ system: "s", prompt: "p", maxOutputTokens: 42, temperature: 0.5, label: "gen", abortSignal: AbortSignal.timeout(1000) });
    expect(createAnthropic).toHaveBeenCalled();
    const call = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
    expect(call.maxOutputTokens).toBe(42);
    expect(call.temperature).toBe(0.5);
    expect(call.abortSignal).toBeDefined();
  });

  it("logs warn for empty text", async () => {
    vi.mocked(generateText).mockResolvedValue({ text: "", usage: null, finishReason: "length" } as never);
    const client = createLlmClient(normalizeLlmConfig({}));
    const out = await client.chat({ system: "s", prompt: "p" });
    expect(out).toBe("");
    expect(console.warn).toHaveBeenCalled();
  });

  it("rethrows errors after logging", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("boom"));
    const client = createLlmClient(normalizeLlmConfig({}));
    await expect(client.chat({ system: "s", prompt: "p" })).rejects.toThrow("boom");
    expect(console.error).toHaveBeenCalled();
  });
});