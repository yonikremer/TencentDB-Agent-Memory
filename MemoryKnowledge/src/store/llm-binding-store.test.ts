/**
 * llm-binding-store.test.ts — resolveLlmConfig blanking chain: proxy mode with
 * no usable binding blanks baseUrl/apiKey so createLlmClient fails fast.
 */
import { describe, it, expect } from "vitest";
import { resolveLlmConfig } from "./llm-binding-store.js";
import type { LlmConfig } from "../config.js";
import { createLlmClient, normalizeLlmConfig } from "../engines/wiki/ingest-v2/llm.js";

const proxyFallback: LlmConfig = {
  mode: "proxy",
  protocol: "openai",
  provider: "custom",
  apiKey: "",
  model: "m",
  baseUrl: "",
  maxTokens: 100,
  timeoutMs: 1000,
};

describe("resolveLlmConfig", () => {
  it("blanks baseUrl/apiKey in proxy mode with no binding", () => {
    const eff = resolveLlmConfig("svc-1", null, proxyFallback);
    expect(eff.baseUrl).toBe("");
    expect(eff.apiKey).toBe("");
  });

  it("blanks baseUrl/apiKey when the binding is disabled", () => {
    const eff = resolveLlmConfig(
      "svc-1",
      { service_id: "svc-1", mode: "proxy", proxy_base_url: "http://127.0.0.1:8096", api_key: "k", base_url: null, enabled: false, updated_at: "" },
      proxyFallback,
    );
    expect(eff.baseUrl).toBe("");
  });

  it("routes through the proxy with per-instance billing path when bound", () => {
    const eff = resolveLlmConfig(
      "svc-1",
      { service_id: "svc-1", mode: "proxy", proxy_base_url: "http://127.0.0.1:8096/", api_key: "k", base_url: null, enabled: true, updated_at: "" },
      proxyFallback,
    );
    expect(eff.baseUrl).toBe("http://127.0.0.1:8096/proxy/svc-1/v1");
    expect(eff.apiKey).toBe("k");
  });

  it("blanked config fails fast at client creation (full chain)", () => {
    const eff = resolveLlmConfig("svc-1", null, proxyFallback);
    expect(() => createLlmClient(normalizeLlmConfig(eff))).toThrow(/LLM endpoint not configured/);
  });
});
