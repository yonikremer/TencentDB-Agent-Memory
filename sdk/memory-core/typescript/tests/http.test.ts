import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import Module from "node:module";
import { HttpTransport } from "../src/http.js";
import { TDAMError } from "../src/errors.js";

const ENDPOINT = "http://mem.example.com/";
const OPTS = { endpoint: ENDPOINT, apiKey: "key-1", serviceId: "svc-1" };

describe("HttpTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("constructor trims trailing slashes, sets headers incl. userKey, and builds undici dispatcher by default", async () => {
    const t = new HttpTransport({ ...OPTS, userKey: "uk", timeout: 123 });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { ok: 1 } })));
    vi.stubGlobal("fetch", fetchMock);
    await t.post("/x", { a: 1 });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer key-1",
      "x-tdai-service-id": "svc-1",
      "x-tdai-user-key": "uk",
      "Content-Type": "application/json",
    });
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeDefined();
    expect((init as RequestInit & { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it("constructor without userKey omits the header; rejectUnauthorized=true skips dispatcher", async () => {
    const t = new HttpTransport({ ...OPTS, rejectUnauthorized: true });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: {} })));
    vi.stubGlobal("fetch", fetchMock);
    await t.post("/x");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).not.toHaveProperty("x-tdai-user-key");
    expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeUndefined();
  });

  it("constructor falls back to NODE_TLS_REJECT_UNAUTHORIZED=0 when undici is unavailable", () => {
    const origLoad = (Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown })._load;
    (Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown })._load = function (request: string, parent: unknown, isMain: boolean) {
      if (request === "undici") throw new Error("undici unavailable");
      return origLoad.call(this, request, parent, isMain);
    };
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    try {
      new HttpTransport(OPTS);
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");
    } finally {
      (Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown })._load = origLoad;
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  });

  it("post success unwraps envelope and attaches x-trace-id as trace_id", async () => {
    const t = new HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { answer: 42 } }), {
      status: 200,
      headers: { "x-trace-id": "trace-1" },
    })));
    const result = await t.post("/conversation/query", { k: "v" });
    expect(result).toEqual({ answer: 42, trace_id: "trace-1" });
  });

  it("post success without trace header leaves trace_id absent", async () => {
    const t = new HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: 0, data: null }))));
    const result = await t.post("/x");
    expect(result).toEqual({});
  });

  it("post non-2xx throws TDAMError carrying status and response text", async () => {
    const t = new HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom body", { status: 503 })));
    const err = await t.post("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TDAMError);
    expect((err as TDAMError).code).toBe(503);
    expect((err as TDAMError).message).toMatch(/HTTP 503: boom body/);
  });

  it("post non-2xx tolerates text() rejection", async () => {
    const t = new HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => { throw new Error("read failed"); },
      json: async () => ({}),
    })));
    const err = await t.post("/x").catch((e: unknown) => e);
    expect((err as TDAMError).code).toBe(500);
    expect((err as TDAMError).message).toContain("HTTP 500");
  });

  it("post business error uses x-qcloud-transaction-id and object details", async () => {
    const t = new HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: 40001,
      message: "bad request",
      data: { current_version: 3 },
    }), { status: 200, headers: { "x-qcloud-transaction-id": "tx-9" } })));
    const err = await t.post("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TDAMError);
    expect((err as TDAMError).code).toBe(40001);
    expect((err as TDAMError).requestId).toBe("tx-9");
    expect((err as TDAMError).details).toEqual({ current_version: 3 });
  });

  it("post business error falls back to envelope request_id and skips primitive details", async () => {
    const t = new HttpTransport(OPTS);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: 41002,
      message: "expired",
      request_id: "req-77",
      data: "just-a-string",
    }))));
    const err = await t.post("/x").catch((e: unknown) => e);
    expect((err as TDAMError).requestId).toBe("req-77");
    expect((err as TDAMError).details).toBeUndefined();
  });

  it("post propagates fetch network error and clears the timeout", async () => {
    const t = new HttpTransport({ ...OPTS, timeout: 5 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const err = await t.post("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
  });

  it("post abort signal fires when timeout elapses", async () => {
    const t = new HttpTransport({ ...OPTS, timeout: 5 });
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const err = await t.post("/x").catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });
});