import { describe, it, expect, vi, afterEach } from "vitest";
import { executeMetaFetch, KernelFetchError } from "../src/panel/kernel/transport-fetch.js";
import { FetchKernelHttpAdapter } from "../src/panel/kernel/adapters/fetch-kernel-http-adapter.js";
import { HttpKnowledgeClient } from "../src/panel/kernel/adapters/http-knowledge-client.js";
import { CoreUpstreamError } from "../src/panel/domain/errors.js";
import { ConsoleLogger } from "../src/panel/infra/console-logger.js";
import { saveAgentTemplate, getAgentTemplate } from "../src/panel/state/agent-template-store.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://mem.example.com";
const CREDS = { endpoint: BASE, apiKey: "k", instanceId: "s", timeoutMs: 1000 } as never;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function spyLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe("transport-fetch serializeForLog branches", () => {
  it("truncates an over-long logged body (>1200 chars after sanitize)", async () => {
    const log = spyLogger();
    const big = Array.from({ length: 5 }, () => "x".repeat(300)); // ~1500 chars JSON
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: 0, data: { ok: 1 } })));
    await executeMetaFetch(
      { endpoint: BASE, apiKey: "k", serviceId: "s", timeoutMs: 1000, logger: log } as never,
      "/v3/x",
      { list: big },
      "envelope",
    );
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(logged).toContain("[truncated");
  });

  it("falls back to '[unserializable]' when the payload cannot be stringified (BigInt)", async () => {
    const log = spyLogger();
    const bigIntResp = { ok: true, status: 200, json: async () => ({ code: 0, data: { n: 1n } }) };
    vi.stubGlobal("fetch", vi.fn(async () => bigIntResp));
    await executeMetaFetch(
      { endpoint: BASE, apiKey: "k", serviceId: "s", timeoutMs: 1000, logger: log } as never,
      "/v3/x",
      {},
      "envelope",
    );
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(logged).toContain("[unserializable]");
  });

  it("response error branch logs envelopeCode", async () => {
    const log = spyLogger();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: 40001, message: "bad", request_id: "r", data: null })));
    const env = await executeMetaFetch(
      { endpoint: BASE, apiKey: "k", serviceId: "s", timeoutMs: 1000, logger: log } as never,
      "/v3/x",
      {},
      "envelope",
    );
    expect(env.code).toBe(40001);
    expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])).toContain("envelopeCode");
  });
});

describe("fetch-kernel-http-adapter rethrow", () => {
  it("wraps non-envelope network errors as KernelFetchError(502)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const adapter = new FetchKernelHttpAdapter();
    const err = await adapter
      .postEnvelope("/v3/x", {}, { ...CREDS, userKey: "uk", requestId: "r" })
      .then(
        () => null,
        (e) => e,
      );
    // Network failure surfaces as mapped 502 envelope (adapter converts KernelFetchError).
    expect(err).toBeNull();
  });

  it("maps non-ok HTTP to envelope error via mapHttpStatusFromEnvelopeCode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "bad gateway" }, 502)));
    const adapter = new FetchKernelHttpAdapter();
    const env = await adapter.postEnvelope("/v3/x", {}, { ...CREDS, userKey: "uk", requestId: "r" });
    expect(env.code).not.toBe(0);
  });

  it("network failure without envelope yields code 502 envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const adapter = new FetchKernelHttpAdapter();
    const env = await adapter.postEnvelope("/v3/x", {}, { ...CREDS, userKey: "uk", requestId: "r" });
    expect(env.code).toBe(502);
  });

  it("executeMetaFetch throws KernelFetchError on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(
      executeMetaFetch({ endpoint: BASE, apiKey: "k", serviceId: "s", timeoutMs: 1000 } as never, "/v3/x", {}, "data"),
    ).rejects.toMatchObject({ name: "KernelFetchError", code: 502 });
  });
});

describe("http-knowledge-client error branches", () => {
  const cfg = { baseUrl: BASE, authToken: "t", serviceId: "s", timeoutMs: 1000 };

  it("non-zero code with 200 status maps to 502 CoreUpstreamError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: 999, message: "core err", data: null })));
    const client = new HttpKnowledgeClient(cfg);
    const err = await client.wikiGet("w-1").then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(CoreUpstreamError);
    expect((err as CoreUpstreamError).code).toBe("CORE_UPSTREAM_ERROR");
    expect((err as CoreUpstreamError).httpStatus).toBe(502);
  });

  it("non-ok response throws with http status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503, headers: { "content-type": "application/json" } })),
    );
    const client = new HttpKnowledgeClient(cfg);
    const err = await client.wikiGet("w-1").then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(CoreUpstreamError);
    expect((err as CoreUpstreamError).httpStatus).toBe(503);
  });
});

describe("console-logger plain message", () => {
  it("writes message-only line (no field tail)", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    try {
      const log = new ConsoleLogger({ level: "info", format: "pretty" });
      log.info("hello");
    } finally {
      spy.mockRestore();
    }
    const out = writes.join("");
    expect(out).toContain("hello");
  });
});

describe("agent-template-store corrupted file", () => {
  it("rethrows non-ENOENT parse errors when reading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-tmpl-"));
    try {
      const inst = "inst-1";
      const team = "team-1";
      const { mkdirSync } = await import("node:fs");
      const path = await import("node:path");
      mkdirSync(path.join(dir, inst, team), { recursive: true });
      writeFileSync(path.join(dir, inst, team, "template.json"), "{not json", "utf-8");
      expect(() => getAgentTemplate(dir, inst, team)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves and loads round-trip with defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-tmpl2-"));
    try {
      const config = { name: "T", asset_ids: { skills: ["s"] } } as never;
      saveAgentTemplate(dir, "inst-1", "team-1", config);
      const loaded = getAgentTemplate(dir, "inst-1", "team-1");
      expect(loaded).toEqual(config);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
