/**
 * telemetry.test.ts — Unit tests for OTel/Langfuse init + withSpan tracing helper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const state = { starts: 0, shutdowns: 0, throwOnStart: false };
  const span = {
    setAttribute: vi.fn(),
    end: vi.fn(),
  };
  const startActiveSpan = vi.fn((name: string, fn: (s: typeof span) => Promise<unknown>) => fn(span));
  const NodeSDK = class {
    constructor(_opts: unknown) {
      this.shutdown = async () => {
        state.shutdowns++;
      };
    }
    start() {
      if (state.throwOnStart) throw new Error("init failed");
      state.starts++;
    }
  };
  const LangfuseSpanProcessor = class {
    constructor(_opts: unknown) {}
  };
  return { state, span, startActiveSpan, NodeSDK, LangfuseSpanProcessor };
});

vi.mock("@opentelemetry/sdk-node", () => ({ NodeSDK: hoisted.NodeSDK }));
vi.mock("@langfuse/otel", () => ({ LangfuseSpanProcessor: hoisted.LangfuseSpanProcessor }));
vi.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: () => ({ startActiveSpan: hoisted.startActiveSpan }),
  },
}));

import { withSpan, tracer } from "./telemetry.js";

/** Fresh module instance so module-level `sdk` singleton resets per test. */
async function freshModule() {
  vi.resetModules();
  return import("./telemetry.js");
}

beforeEach(() => {
  vi.restoreAllMocks();
  hoisted.state.starts = 0;
  hoisted.state.shutdowns = 0;
  hoisted.state.throwOnStart = false;
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_BASE_URL;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.resetModules();
});

describe("initTelemetry", () => {
  it("skips silently when LANGFUSE_SECRET_KEY unset", async () => {
    const { initTelemetry } = await freshModule();
    initTelemetry();
    expect(hoisted.state.starts).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });

  it("initializes SDK when key is set and registers SIGTERM flush", async () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.LANGFUSE_BASE_URL = "http://langfuse";
    const { initTelemetry } = await freshModule();
    initTelemetry();
    expect(hoisted.state.starts).toBe(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("initialized"));
    // second call is a no-op (sdk already set)
    initTelemetry();
    expect(hoisted.state.starts).toBe(1);

    process.emit("SIGTERM" as NodeJS.Signals);
    await vi.waitFor(() => expect(hoisted.state.shutdowns).toBe(1));
  });

  it("falls back to warn when SDK init throws", async () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    hoisted.state.throwOnStart = true;
    const { initTelemetry } = await freshModule();
    initTelemetry();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("init failed"));
    // sdk reset to null; SIGTERM handler with null sdk must not throw
    expect(() => process.emit("SIGTERM" as NodeJS.Signals)).not.toThrow();
  });

  it("defaults LANGFUSE_BASE_URL to cloud when unset", async () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    const { initTelemetry } = await freshModule();
    initTelemetry();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("https://cloud.langfuse.com"),
    );
  });
});

describe("withSpan", () => {
  it("executes fn within span, sets langfuse.name, ends span, returns value", async () => {
    const result = await withSpan("my-span", async () => 42);
    expect(result).toBe(42);
    expect(hoisted.startActiveSpan).toHaveBeenCalledWith("my-span", expect.any(Function));
    expect(hoisted.span.setAttribute).toHaveBeenCalledWith("langfuse.name", "my-span");
    expect(hoisted.span.end).toHaveBeenCalled();
  });

  it("propagates fn error but still ends the span", async () => {
    await expect(
      withSpan("failing", async () => {
        throw new Error("task failed");
      }),
    ).rejects.toThrow("task failed");
    expect(hoisted.span.end).toHaveBeenCalled();
  });

  it("exposes a named tracer", () => {
    expect(tracer).toBeDefined();
  });
});