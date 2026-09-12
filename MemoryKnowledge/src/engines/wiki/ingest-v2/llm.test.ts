/**
 * llm.test.ts — fail-fast guard: unconfigured endpoint throws an actionable
 * error at client creation instead of a cryptic URL parse error at first call.
 */
import { describe, it, expect } from "vitest";
import { createLlmClient, normalizeLlmConfig } from "./llm.js";

describe("createLlmClient", () => {
  it("throws an actionable error when baseUrl is blank (no binding, proxy mode)", () => {
    const cfg = normalizeLlmConfig({ baseUrl: "", apiKey: "", model: "m" });
    expect(() => createLlmClient(cfg)).toThrow(/LLM endpoint not configured/);
    expect(() => createLlmClient(cfg)).toThrow(/llm-binding\/set/);
  });

  it("throws on whitespace-only baseUrl", () => {
    const cfg = normalizeLlmConfig({ baseUrl: "   ", apiKey: "", model: "m" });
    expect(() => createLlmClient(cfg)).toThrow(/LLM endpoint not configured/);
  });

  it("builds a client when the endpoint is configured", () => {
    const client = createLlmClient(
      normalizeLlmConfig({ baseUrl: "http://localhost:8096/proxy/svc/v1", apiKey: "k", model: "m" }),
    );
    expect(client.config.baseUrl).toBe("http://localhost:8096/proxy/svc/v1");
  });
});
