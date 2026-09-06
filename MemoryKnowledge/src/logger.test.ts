/**
 * logger.test.ts — Unit tests for leveled logger.
 *
 * LOG_LEVEL is captured at module load, so an error-threshold module is loaded
 * via vi.resetModules + dynamic import after setting process.env.LOG_LEVEL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, log } from "./logger.js";

describe("createLogger (default LOG_LEVEL=debug)", () => {
  const calls: Array<{ fn: string; args: unknown[] }> = [];

  beforeEach(() => {
    calls.length = 0;
    vi.spyOn(console, "log").mockImplementation((...a) => calls.push({ fn: "log", args: a }));
    vi.spyOn(console, "warn").mockImplementation((...a) => calls.push({ fn: "warn", args: a }));
    vi.spyOn(console, "error").mockImplementation((...a) => calls.push({ fn: "error", args: a }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("default app logger exists with all four methods", () => {
    expect(log.debug).toBeTypeOf("function");
    expect(log.info).toBeTypeOf("function");
    expect(log.warn).toBeTypeOf("function");
    expect(log.error).toBeTypeOf("function");
  });

  it("debug-level threshold prints every level", () => {
    const l = createLogger("test-tag");
    l.debug("dbg");
    l.info("inf");
    l.warn("wrn");
    l.error("err");
    expect(calls.map((c) => c.fn)).toEqual(["log", "log", "warn", "error"]);
  });

  it("format: message with data appends JSON; without data omits it", () => {
    const l = createLogger("data-tag");
    l.info("plain message");
    l.info("with data", { a: 1, b: [2] });
    const [plain] = calls;
    expect(plain.fn).toBe("log");
    expect(String(plain.args[0])).toContain("[INFO ] [data-tag] plain message");
    const withData = calls[1];
    expect(String(withData.args[0])).toContain("with data {\"a\":1,\"b\":[2]}");
  });

  it("output shape: timestamp + padded level + tag", () => {
    const l = createLogger("shape");
    l.warn("boom");
    const msg = String(calls[0].args[0]);
    expect(msg).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[WARN \] \[shape\] boom$/);
  });
});

describe("createLogger with elevated LOG_LEVEL", () => {
  it("LOG_LEVEL=error suppresses debug/info/warn", async () => {
    vi.resetModules();
    process.env.LOG_LEVEL = "error";
    const mod = await import("./logger.js");
    const out: Array<{ fn: string; args: unknown[] }> = [];
    vi.spyOn(console, "log").mockImplementation((...a) => out.push({ fn: "log", args: a }));
    vi.spyOn(console, "warn").mockImplementation((...a) => out.push({ fn: "warn", args: a }));
    vi.spyOn(console, "error").mockImplementation((...a) => out.push({ fn: "error", args: a }));

    const l = mod.createLogger("t");
    l.debug("x");
    l.info("x");
    l.warn("x");
    l.error("boom", { code: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].fn).toBe("error");
    expect(String(out[0].args[0])).toContain("[ERROR] [t] boom {\"code\":1}");
    vi.restoreAllMocks();
  });

  it("LOG_LEVEL=warn suppresses debug/info but keeps warn+error", async () => {
    vi.resetModules();
    process.env.LOG_LEVEL = "warn";
    const mod = await import("./logger.js");
    const out: Array<{ fn: string; args: unknown[] }> = [];
    vi.spyOn(console, "log").mockImplementation((...a) => out.push({ fn: "log", args: a }));
    vi.spyOn(console, "warn").mockImplementation((...a) => out.push({ fn: "warn", args: a }));
    vi.spyOn(console, "error").mockImplementation((...a) => out.push({ fn: "error", args: a }));

    const l = mod.createLogger("t");
    l.debug("x");
    l.info("x");
    l.warn("w");
    l.error("e");
    expect(out.map((o) => o.fn)).toEqual(["warn", "error"]);
    vi.restoreAllMocks();
  });
});
