/**
 * API trace modules: sanitize, policy, config, request context, stdout writer.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  truncateApiString,
  sanitizeApiPayload,
  serializeForApiLog,
  redactSqlParams,
} from "../../src/api-trace/api-sanitize.js";
import {
  resolveProfile,
  resolvePolicy,
} from "../../src/api-trace/api-trace-policy.js";
import {
  initApiTraceConfig,
  getApiTraceConfig,
  resetApiTraceConfigForTests,
  isApiTraceActive,
} from "../../src/api-trace/api-log-config.js";
import {
  runWithApiRequestContext,
  getApiRequestContext,
} from "../../src/api-trace/api-request-context.js";
import {
  buildStdoutPayload,
  writeApiTraceStdout,
  setStdoutWriterForTests,
  getStdoutWriterForTests,
  API_TRACE_INTERFACE,
} from "../../src/api-trace/api-trace-stdout.js";

afterEach(() => {
  resetApiTraceConfigForTests();
  vi.restoreAllMocks();
});

describe("api-sanitize", () => {
  it("truncateApiString", () => {
    expect(truncateApiString("abc", 10)).toBe("abc");
    expect(truncateApiString("abcdefgh", 3)).toContain("[truncated");
  });
  it("sanitizeApiPayload scalars and depth", () => {
    expect(sanitizeApiPayload(null, 10)).toBeNull();
    expect(sanitizeApiPayload(undefined, 10)).toBeUndefined();
    expect(sanitizeApiPayload("long string", 4)).toContain("[truncated");
    expect(sanitizeApiPayload(42, 10)).toBe(42);
    expect(sanitizeApiPayload(false, 10)).toBe(false);
    const deep = (d: number): unknown => (d <= 0 ? "leaf" : [deep(d - 1)]);
    const out = sanitizeApiPayload(deep(12), 10, 0);
    expect(JSON.stringify(out)).toContain("[max_depth]");
    expect(sanitizeApiPayload(new Date(), 10, 0)).toEqual({});
  });
  it("sanitizeApiPayload masks sensitive keys", () => {
    const out = sanitizeApiPayload(
      {
        password: "supersecretvalue",
        initial_password: "x",
        default_user_key: "y",
        user_key: "sk-mem-1234567890",
        key_value: "z",
        granted_by_key: "q",
        owner_user_key: "w",
        creator_user_key: "e",
        authorization: "Bearer abc",
        api_key: "k",
        token: "t",
        secret: "s",
        bearer: "b",
        normal: "hello",
        nested: { Password: "inner" },
        emptySensitive: { token: "" },
      },
      100,
    ) as Record<string, unknown>;
    expect(out.normal).toBe("hello");
    expect(String(out.password)).toContain("…");
    expect(out.nested).toEqual({ Password: expect.stringContaining("…") });
    expect(out.emptySensitive).toEqual({ token: "[redacted]" });
    expect(String(out.authorization)).toContain("…");
  });
  it("serializeForApiLog truncation + unserializable", () => {
    const s = serializeForApiLog({ a: "x".repeat(500) }, 20, 100);
    expect(s).toContain("[truncated");
    const bad = {} as Record<string, unknown>;
    Object.defineProperty(bad, "x", {
      enumerable: true,
      get() {
        throw new Error("no");
      },
    });
    expect(serializeForApiLog(bad, 10, 10)).toBe("[unserializable]");
  });
  it("redactSqlParams", () => {
    expect(redactSqlParams(["uk_12345678901234567890123456789012", "sk-mem-abcdef-1234567890-abcdefghij", "Bearer verylongtokenthatislongerthan32chars", "this is a quite long but harmless string value"], 10)).toEqual([
      "[redacted]",
      "[redacted]",
      "[redacted]",
      expect.stringContaining("[truncated"),
    ]);
    expect(redactSqlParams([42, null, { x: 1 }], 10)).toEqual([42, null, { x: 1 }]);
  });
});

describe("api-trace-policy", () => {
  it("resolveProfile", () => {
    expect(resolveProfile("mongodb")).toBe("full");
    expect(resolveProfile("sqlite")).toBe("lite");
    expect(resolveProfile(undefined)).toBe("lite");
  });
  it("resolvePolicy full vs lite", () => {
    const full = resolvePolicy("mongodb");
    expect(full.profile).toBe("full");
    expect(full.httpBodyOnSuccess).toBe(true);
    expect(full.httpOtelReport).toBe(true);
    const lite = resolvePolicy("sqlite");
    expect(lite.profile).toBe("lite");
    expect(lite.httpBodyOnSuccess).toBe(false);
    expect(lite.module).toBe("meta");
  });
});

describe("api-log-config", () => {
  it("getApiTraceConfig lazily builds sqlite config", () => {
    const cfg = getApiTraceConfig();
    expect(cfg.log.enabled).toBe(true);
    expect(cfg.policy.profile).toBe("lite");
  });
  it("initApiTraceConfig options", () => {
    initApiTraceConfig("mongodb", { enabled: false });
    const cfg = getApiTraceConfig();
    expect(cfg.log.enabled).toBe(false);
    expect(cfg.policy.profile).toBe("full");
  });
  it("initApiTraceConfig defaults", () => {
    initApiTraceConfig();
    const cfg = getApiTraceConfig();
    expect(cfg.log.enabled).toBe(true);
    expect(cfg.policy.profile).toBe("lite");
  });
  it("isApiTraceActive", () => {
    expect(isApiTraceActive()).toBe(true);
    initApiTraceConfig("sqlite", { enabled: false });
    expect(isApiTraceActive()).toBe(false);
  });
});

describe("api-request-context", () => {
  it("runWithApiRequestContext + getApiRequestContext", () => {
    expect(getApiRequestContext()).toBeUndefined();
    const val = runWithApiRequestContext({ requestId: "r1", route: "/v3/mem", module: "meta" }, () => {
      const ctx = getApiRequestContext();
      return ctx?.requestId;
    });
    expect(val).toBe("r1");
  });
});

describe("api-trace-stdout", () => {
  it("buildStdoutPayload + writeApiTraceStdout", () => {
    const lines: string[] = [];
    setStdoutWriterForTests((l) => lines.push(l));
    const payload = buildStdoutPayload("info", "ok", "lite", { a: 1 });
    expect(payload.interface).toBe(API_TRACE_INTERFACE);
    expect(payload.level).toBe("INFO");
    writeApiTraceStdout(payload);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe("ok");
  });
  it("writeApiTraceStdout swallows writer errors", () => {
    setStdoutWriterForTests(() => {
      throw new Error("io");
    });
    expect(() => writeApiTraceStdout({ a: 1 })).not.toThrow();
  });
  it("setStdoutWriterForTests(null) restores default", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    setStdoutWriterForTests(null);
    expect(getStdoutWriterForTests()).toBeDefined();
    writeApiTraceStdout({ x: 1 });
    expect(writeSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});