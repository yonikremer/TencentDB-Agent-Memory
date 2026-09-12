/**
 * health.test.ts — /health stays public and reports LLM dependency state.
 *
 * Bare mount keeps backward compat; with deps it reports mode, global
 * creds presence (never values), live binding count, and the last ingest
 * failure. No live inference happens on scrapes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHealthRoutes } from "../health.js";
import {
  recordLlmError,
  lastLlmError,
  resetDependencyErrors,
} from "../../dependency-health.js";

beforeEach(() => resetDependencyErrors());

describe("GET /health", () => {
  it("bare mount keeps legacy shape + unknown llm state", async () => {
    const res = await createHealthRoutes().request("/health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.status).toBe("ok");
    expect(json.dependencies.llm).toMatchObject({
      mode: "unknown",
      globalConfigured: false,
      bindings: 0,
    });
    expect(json.dependencies.llm.lastError).toBeNull();
  });

  it("reports mode, creds presence, bindings — never secrets", async () => {
    const res = await createHealthRoutes({
      llmMode: "custom",
      globalConfigured: true,
      bindingCount: 2,
    }).request("/health");
    const json = (await res.json()) as any;
    expect(json.dependencies.llm).toMatchObject({
      mode: "custom",
      globalConfigured: true,
      bindings: 2,
    });
    expect(JSON.stringify(json)).not.toContain("sk-");
  });

  it("surfaces last ingest failure with timestamp", async () => {
    recordLlmError("upstream timeout");
    expect(lastLlmError()).toMatchObject({ message: "upstream timeout" });
    const res = await createHealthRoutes({}).request("/health");
    const json = (await res.json()) as any;
    expect(json.dependencies.llm.lastError.message).toBe("upstream timeout");
    expect(typeof json.dependencies.llm.lastError.at).toBe("string");
  });
});
