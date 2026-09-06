import { describe, it, expect, vi, afterEach } from "vitest";
import { V3HttpTransport } from "../src/v3/http.js";
import { ParamError, TDAMError } from "../src/errors.js";

const OPTS = { endpoint: "http://mem.example.com/", apiKey: "key-1", serviceId: "svc-1" };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("V3HttpTransport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects invalid endpoint URL", () => {
    expect(() => new V3HttpTransport({ ...OPTS, endpoint: "not a url" })).toThrow(ParamError);
  });

  it("rejects non-http(s) endpoint", () => {
    expect(() => new V3HttpTransport({ ...OPTS, endpoint: "ftp://mem.example.com" })).toThrow(ParamError);
  });

  it("rejects missing apiKey and serviceId", () => {
    expect(() => new V3HttpTransport({ ...OPTS, apiKey: "  " })).toThrow(ParamError);
    expect(() => new V3HttpTransport({ ...OPTS, serviceId: "" })).toThrow(ParamError);
  });

  it("rejects non-positive or non-finite timeout and accepts valid ones", () => {
    expect(() => new V3HttpTransport({ ...OPTS, timeout: 0 })).toThrow(ParamError);
    expect(() => new V3HttpTransport({ ...OPTS, timeout: NaN })).toThrow(ParamError);
    expect(() => new V3HttpTransport({ ...OPTS, timeout: 300 })).not.toThrow();
  });

  it("sets userKey header and builds dispatcher when rejectUnauthorized=false", async () => {
    const t = new V3HttpTransport({ ...OPTS, userKey: "uk", rejectUnauthorized: false });
    const fetchMock = vi.fn(async () => jsonResponse({ code: 0, data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await t.post("/v3/x", { a: 1 });
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["x-tdai-user-key"]).toBe("uk");
    expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeDefined();
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("post success returns data and attaches trace_id from x-trace-id", async () => {
    const t = new V3HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: 0, data: { ok: true } }, 200, { "x-trace-id": "tid-1" })));
    const res = await t.post("/v3/conversation/query", { q: "hi" });
    expect(res).toEqual({ ok: true, trace_id: "tid-1" });
  });

  it("get builds query string filtering undefined and stringifying values", async () => {
    const t = new V3HttpTransport(OPTS);
    const fetchMock = vi.fn(async () => jsonResponse({ code: 0, data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await t.get("/v3/atomic/query", { limit: 5, active: true, name: "x", skip: undefined });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://mem.example.com/v3/atomic/query?limit=5&active=true&name=x");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("get with all-undefined params omits query string", async () => {
    const t = new V3HttpTransport(OPTS);
    const fetchMock = vi.fn(async () => jsonResponse({ code: 0, data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await t.get("/v3/core/read", { limit: undefined });
    expect(fetchMock.mock.calls[0][0]).toBe("http://mem.example.com/v3/core/read");
  });

  it("business error throws TDAMError with code, request id, and object details", async () => {
    const t = new V3HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      code: 40901,
      message: "version stale",
      data: { current_version: 2 },
    }, 200, { "x-qcloud-transaction-id": "hdr-req" })));
    const err = await t.post("/v3/skill/update", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TDAMError);
    expect((err as TDAMError).code).toBe(40901);
    expect((err as TDAMError).message).toContain("version stale");
    expect((err as TDAMError).requestId).toBe("hdr-req");
    expect((err as TDAMError).details).toEqual({ current_version: 2 });
  });

  it("non-ok response with business code 0 uses HTTP status; request id falls back to x-trace-id then envelope", async () => {
    const t = new V3HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: 0, message: "" }, 500, { "x-trace-id": "trace-fb" })));
    const err = await t.post("/v3/x", {}).catch((e: unknown) => e);
    expect((err as TDAMError).code).toBe(500);
    expect((err as TDAMError).requestId).toBe("trace-fb");
    expect((err as TDAMError).message).toContain("HTTP 500");
  });

  it("non-ok response with code undefined falls back to status and envelope request_id", async () => {
    const t = new V3HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ request_id: "env-req" }, 502)));
    const err = await t.post("/v3/x", {}).catch((e: unknown) => e);
    expect((err as TDAMError).code).toBe(502);
    expect((err as TDAMError).requestId).toBe("env-req");
  });

  it("non-JSON body throws TDAMError; ok response uses -1 and template message", async () => {
    const t = new V3HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    const err = await t.post("/v3/x", {}).catch((e: unknown) => e);
    expect((err as TDAMError).code).toBe(-1);
    expect((err as TDAMError).message).toContain("non-JSON response");
  });

  it("non-JSON body on non-ok response uses HTTP status", async () => {
    const t = new V3HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>oops</html>", { status: 400 })));
    const err = await t.post("/v3/x", {}).catch((e: unknown) => e);
    expect((err as TDAMError).code).toBe(400);
    expect((err as TDAMError).message).toContain("<html>oops</html>");
  });

  it("text() rejection on non-ok response falls back to template message", async () => {
    const t = new V3HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      text: async () => { throw new Error("gone"); },
    })));
    const err = await t.post("/v3/x", {}).catch((e: unknown) => e);
    expect((err as TDAMError).code).toBe(503);
    expect((err as TDAMError).message).toContain("non-JSON response");
  });

  it("ok response without numeric code throws with envelope data as details", async () => {
    const t = new V3HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { why: "nope" } }, 200)));
    const err = await t.post("/v3/x", {}).catch((e: unknown) => e);
    expect((err as TDAMError).code).toBe(200);
    expect((err as TDAMError).details).toEqual({ why: "nope" });
  });

  it("trace_id only attached when result is an object", async () => {
    const t = new V3HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: 0, data: "scalar" }, 200, { "x-trace-id": "t" })));
    const res = await t.post("/v3/x", {});
    expect(res).toBe("scalar");
  });

  it("null data with trace header yields object result with trace_id", async () => {
    const t = new V3HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: 0, data: null }, 200, { "x-trace-id": "t2" })));
    const res = await t.get("/v3/x");
    expect(res).toEqual({ trace_id: "t2" });
  });

  it("propagates network errors and abort on timeout", async () => {
    const t = new V3HttpTransport({ ...OPTS, timeout: 5 });
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const err = await t.post("/v3/x", {}).catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });
});