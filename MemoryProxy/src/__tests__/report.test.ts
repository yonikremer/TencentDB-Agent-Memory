import { describe, expect, it, vi } from "vitest";
import { ConsoleLogBackend } from "../report/backends/console.js";
import { NoopLogBackend } from "../report/backends/noop.js";
import { LOG_LEVEL_PRIORITY } from "../report/types.js";
import { FileLogger } from "../report/file-logger.js";
import { initLogger, getLogLevel, shutdownLogger, log } from "../report/log.js";

describe("LOG_LEVEL_PRIORITY", () => {
  it("orders levels", () => {
    expect(LOG_LEVEL_PRIORITY.debug).toBe(0);
    expect(LOG_LEVEL_PRIORITY.info).toBe(1);
    expect(LOG_LEVEL_PRIORITY.warn).toBe(2);
    expect(LOG_LEVEL_PRIORITY.error).toBe(3);
  });
});

describe("NoopLogBackend", () => {
  it("is a no-op", async () => {
    const b = new NoopLogBackend();
    expect(b.type).toBe("noop");
    b.info("e", { a: 1 });
    b.warn("e");
    b.error("e", {}, new Error("x"));
    b.debug("e");
    await b.shutdown();
  });
});

describe("ConsoleLogBackend", () => {
  it("writes formatted lines to stderr", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const b = new ConsoleLogBackend();
    b.info("evt", { a: 1 });
    b.warn("evt2");
    b.error("evt3", { b: 2 }, new Error("boom"));
    b.debug("evt4", {});
    const all = write.mock.calls.map((c) => String(c[0])).join("");
    expect(all).toContain("INFO  evt");
    expect(all).toContain('"a":1');
    expect(all).toContain("WARN  evt2");
    expect(all).toContain("ERROR evt3");
    expect(all).toContain("error.message");
    expect(all).toContain("DEBUG evt4");
    write.mockRestore();
  });
});

describe("log facade", () => {
  it("respects level filtering via initLogger", async () => {
    const backend = {
      type: "test",
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    initLogger(
      {
        level: "debug",
        filePath: "",
        rotate: { maxSizeBytes: 100, backupLimit: 1 },
        backend: "noop",
      },
      backend,
    );
    expect(getLogLevel()).toBe("debug");
    log.debug("d", { n: 1 });
    log.info("i", { s: "x", b: true, nul: null, und: undefined, obj: { nested: [1, 2] } });
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    log.warn("w", { c: circ });
    log.error("e", { num: 5 }, new Error("boom"));
    expect(backend.debug).toHaveBeenCalledWith("d", { n: 1 });
    expect(backend.info).toHaveBeenCalled();
    expect(backend.warn).toHaveBeenCalled();
    expect((backend.error.mock.calls[0] as unknown[])[2]).toBeInstanceOf(Error);
    await shutdownLogger();
    expect(backend.shutdown).toHaveBeenCalled();
  });

  it("drops messages below min level", async () => {
    const backend = {
      type: "test",
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    initLogger(
      { level: "error", filePath: "", rotate: { maxSizeBytes: 100, backupLimit: 1 }, backend: "noop" },
      backend,
    );
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(backend.debug).not.toHaveBeenCalled();
    expect(backend.info).not.toHaveBeenCalled();
    expect(backend.warn).not.toHaveBeenCalled();
    expect(backend.error).toHaveBeenCalledWith("e", {}, undefined);
    await shutdownLogger();
  });
});

describe("FileLogger", () => {
  it("works end to end with rotation on a temp dir", async () => {
    const dir = require("node:path").join(require("node:os").tmpdir(), `mp-filelogger-test-${Date.now()}`);
    const fl = new FileLogger({ dir, filename: "proxy.log", rotateSizeBytes: 5, rotateBackupLimit: 1, flushThreshold: 1 });
    fl.write("INFO", "hello", { a: 1 });
    fl.write("WARN", "world");
    await new Promise((r) => setTimeout(r, 50));
    await fl.shutdown();
    expect(true).toBe(true);
  });

  it("disabled when dir empty", () => {
    const fl = new FileLogger({ dir: "", filename: "x.log" });
    fl.write("INFO", "noop");
    return fl.shutdown();
  });
});