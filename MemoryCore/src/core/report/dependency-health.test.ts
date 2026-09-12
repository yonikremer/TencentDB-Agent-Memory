/**
 * dependency-health.test.ts — recorder + /health mapping unit cover.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordDependencyError,
  lastDependencyError,
  resetDependencyErrors,
  embeddingDependency,
} from "./dependency-health.js";

beforeEach(() => resetDependencyErrors());

describe("recorder", () => {
  it("starts unknown (null, not fake-ok)", () => {
    expect(lastDependencyError("embedding")).toBeNull();
  });

  it("records message with timestamp", () => {
    recordDependencyError("embedding", "boom");
    expect(lastDependencyError("embedding")).toMatchObject({ message: "boom" });
    expect(typeof lastDependencyError("embedding")?.at).toBe("string");
  });

  it("channels are independent", () => {
    recordDependencyError("llm", "x");
    expect(lastDependencyError("embedding")).toBeNull();
  });
});

describe("embeddingDependency mapping", () => {
  it("null service -> unconfigured, still surfaces last error", () => {
    recordDependencyError("embedding", "down");
    expect(embeddingDependency(null)).toMatchObject({
      configured: false,
      ready: false,
      lastError: { message: "down" },
    });
  });

  it("ready service, no traffic -> ready true, lastError null", () => {
    expect(embeddingDependency({ isReady: () => true })).toEqual({
      configured: true,
      ready: true,
      lastError: null,
    });
  });

  it("throwing isReady -> ready false (never throws out of health)", () => {
    const svc = {
      isReady: () => { throw new Error("probe failed"); },
    };
    expect(embeddingDependency(svc)).toMatchObject({ configured: true, ready: false });
  });
});
