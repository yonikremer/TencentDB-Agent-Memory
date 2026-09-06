import { describe, it, expect, vi, afterEach } from "vitest";
import {
  StsCredential,
  StsCredentialManager,
  MemoryFileReader,
  createMemoryFileReader,
  cosV5Sign,
} from "../src/cos.js";
import { TDAMError } from "../src/errors.js";

const COS_DATA = {
  CosUrl: "https://mybucket.cos.ap-guangzhou.myqcloud.com",
  TmpSecretId: "sid",
  TmpSecretKey: "skey",
  TmpToken: "tok-1",
  ExpirationTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  PathPrefix: "mem/abc",
};

describe("StsCredential", () => {
  it("parses public host, normalizes prefix, stores token and expiry", () => {
    const c = new StsCredential(COS_DATA);
    expect(c.bucket).toBe("mybucket");
    expect(c.region).toBe("ap-guangzhou");
    expect(c.cosHost).toBe("mybucket.cos.ap-guangzhou.myqcloud.com");
    expect(c.prefix).toBe("mem/abc/");
    expect(c.token).toBe("tok-1");
    expect(c.tmpSecretId).toBe("sid");
    expect(c.tmpSecretKey).toBe("skey");
    expect(c.expiresAtMs).toBe(new Date(COS_DATA.ExpirationTime).getTime());
    expect(c.isValid()).toBe(true);
  });

  it("parses internal tencentcos host", () => {
    const c = new StsCredential({ ...COS_DATA, CosUrl: "https://b.cos-internal.nanjing.tencentcos.cn" });
    expect(c.region).toBe("nanjing");
    expect(c.bucket).toBe("b");
  });

  it("defaults token and adds trailing slash to prefix", () => {
    const c = new StsCredential({ ...COS_DATA, TmpToken: "", PathPrefix: "p/" });
    expect(c.token).toBe("");
    expect(c.prefix).toBe("p/");
  });

  it("falls back to 30-minute expiry when ExpirationTime missing", () => {
    const c = new StsCredential({ ...COS_DATA, ExpirationTime: "" });
    const expectMs = Date.now() + 30 * 60 * 1000;
    expect(Math.abs(c.expiresAtMs - expectMs)).toBeLessThan(2000);
  });

  it("isValid false when within buffer / expired", () => {
    const c = new StsCredential({ ...COS_DATA, ExpirationTime: new Date(Date.now() + 60_000).toISOString() });
    expect(c.isValid()).toBe(false);
    expect(c.isValid(600_000)).toBe(false);
    const exp = new StsCredential({ ...COS_DATA, ExpirationTime: new Date(Date.now() - 1000).toISOString() });
    expect(exp.isValid()).toBe(false);
  });

  it("throws TDAMError on unparsable CosUrl", () => {
    expect(() => new StsCredential({ ...COS_DATA, CosUrl: "not a url" })).toThrow(TDAMError);
    expect(() => new StsCredential({ ...COS_DATA, CosUrl: "https://example.com/plain" })).toThrow(/Cannot parse CosUrl/);
  });
});

describe("StsCredentialManager", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches credentials, caches while valid, invalidate forces refresh", async () => {
    const mgr = new StsCredentialManager({ endpoint: "http://mem.example.com/", apiKey: "k", serviceId: "s" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(COS_DATA)));
    vi.stubGlobal("fetch", fetchMock);
    const c1 = await mgr.getCredential();
    const c2 = await mgr.getCredential();
    expect(c1).toBe(c2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://mem.example.com/v2/cos/secret");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(init.body).toBe("{}");
    mgr.invalidate();
    await mgr.getCredential();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent getCredential calls", async () => {
    const mgr = new StsCredentialManager({ endpoint: "http://mem.example.com", apiKey: "k", serviceId: "s" });
    let resolveFetch: (r: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((res) => { resolveFetch = res; }));
    vi.stubGlobal("fetch", fetchMock);
    const p1 = mgr.getCredential();
    const p2 = mgr.getCredential();
    resolveFetch(new Response(JSON.stringify(COS_DATA)));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws TDAMError when refresh returns non-ok", async () => {
    const mgr = new StsCredentialManager({ endpoint: "http://mem.example.com", apiKey: "k", serviceId: "s" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 401 })));
    const err = await mgr.getCredential().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TDAMError);
    expect((err as TDAMError).code).toBe(401);
    expect((err as TDAMError).message).toContain("COS secret fetch failed");
  });

  it("throws TDAMError when refresh text() fails", async () => {
    const mgr = new StsCredentialManager({ endpoint: "http://mem.example.com", apiKey: "k", serviceId: "s" });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => { throw new Error("unreadable"); },
    })));
    const err = await mgr.getCredential().catch((e: unknown) => e);
    expect((err as TDAMError).code).toBe(500);
    expect((err as TDAMError).message).toContain("COS secret fetch failed");
  });

  it("propagates TDAMError when refresh data has invalid CosUrl", async () => {
    const mgr = new StsCredentialManager({ endpoint: "http://mem.example.com", apiKey: "k", serviceId: "s" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...COS_DATA, CosUrl: "bad url" }))));
    const err = await mgr.getCredential().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TDAMError);
    expect((err as TDAMError).message).toContain("Invalid CosUrl");
  });

  it("propagates network errors and abort on timeout", async () => {
    const mgr = new StsCredentialManager({ endpoint: "http://mem.example.com", apiKey: "k", serviceId: "s", timeout: 5 });
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const err = await mgr.getCredential().catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });
});

describe("cosV5Sign", () => {
  it("produces deterministic v5 signature with defaults", () => {
    const sig = cosV5Sign("sid", "skey", "GET", "/mem/abc/persona.md", "mybucket.cos.ap-guangzhou.myqcloud.com");
    expect(sig).toContain("q-sign-algorithm=sha1");
    expect(sig).toContain("q-ak=sid");
    expect(sig).toContain("q-header-list=host");
    expect(sig).toContain("q-signature=");
    // hmac + sha1 determinism: same inputs + explicit times → identical signature
    const again = cosV5Sign("sid", "skey", "GET", "/mem/abc/persona.md", "mybucket.cos.ap-guangzhou.myqcloud.com", 1000, 2000);
    const third = cosV5Sign("sid", "skey", "GET", "/mem/abc/persona.md", "mybucket.cos.ap-guangzhou.myqcloud.com", 1000, 2000);
    expect(sig.split("&q-signature=")[1]!.length).toBe(40);
    expect(again).toBe(third); // same q-sign-time/q-key-time -> same signature
  });

  it("honors explicit start/end times", () => {
    const sig = cosV5Sign("sid", "skey", "get", "/f", "h", 1000, 2000);
    expect(sig).toContain("q-sign-time=1000;2000");
    expect(sig).toContain("q-key-time=1000;2000");
  });
});

describe("MemoryFileReader", () => {
  afterEach(() => vi.unstubAllGlobals());

  function cred(overrides: Partial<typeof COS_DATA> = {}) {
    return new StsCredential({ ...COS_DATA, ...overrides });
  }

  it("reads file content on 200 with security token header", async () => {
    const sts = { getCredential: vi.fn(async () => cred()), invalidate: vi.fn() };
    const reader = new MemoryFileReader(sts as unknown as StsCredentialManager);
    const fetchMock = vi.fn(async () => new Response("# persona", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const content = await reader.read("persona.md");
    expect(content).toBe("# persona");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://mybucket.cos.ap-guangzhou.myqcloud.com/mem/abc/persona.md");
    expect((init.headers as Record<string, string>)["x-cos-security-token"]).toBe("tok-1");
    expect((init.headers as Record<string, string>).Authorization).toContain("q-sign-algorithm=sha1");
    expect((init.headers as Record<string, string>).Host).toBe("mybucket.cos.ap-guangzhou.myqcloud.com");
  });

  it("skips token header when credential has no token", async () => {
    const sts = { getCredential: vi.fn(async () => cred({ TmpToken: "" })), invalidate: vi.fn() };
    const reader = new MemoryFileReader(sts as unknown as StsCredentialManager);
    const fetchMock = vi.fn(async () => new Response("x", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await reader.read("f.md");
    expect((fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }).headers)
      .not.toHaveProperty("x-cos-security-token");
  });

  it("retries once on 403 after invalidating credentials", async () => {
    const sts = {
      getCredential: vi.fn(async () => cred()),
      invalidate: vi.fn(),
    };
    const reader = new MemoryFileReader(sts as unknown as StsCredentialManager);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("expired", { status: 403 }))
      .mockResolvedValueOnce(new Response("fresh", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const content = await reader.read("f.md");
    expect(content).toBe("fresh");
    expect(sts.invalidate).toHaveBeenCalledTimes(1);
    expect(sts.getCredential).toHaveBeenCalledTimes(2);
  });

  it("throws when 403 retry also fails", async () => {
    const sts = { getCredential: vi.fn(async () => cred()), invalidate: vi.fn() };
    const reader = new MemoryFileReader(sts as unknown as StsCredentialManager);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    const err = await reader.read("f.md").catch((e: unknown) => e);
    expect((err as TDAMError).code).toBe(403);
    expect((err as TDAMError).message).toContain("COS GET failed");
  });

  it("throws file-not-found on 404", async () => {
    const sts = { getCredential: vi.fn(async () => cred()), invalidate: vi.fn() };
    const reader = new MemoryFileReader(sts as unknown as StsCredentialManager);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const err = await reader.read("missing.md").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TDAMError);
    expect((err as TDAMError).code).toBe(404);
    expect((err as TDAMError).message).toContain("File not found: missing.md");
  });

  it("throws generic COS error with truncated body on other statuses", async () => {
    const sts = { getCredential: vi.fn(async () => cred()), invalidate: vi.fn() };
    const reader = new MemoryFileReader(sts as unknown as StsCredentialManager);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("server exploded", { status: 500 })));
    const err = await reader.read("f.md").catch((e: unknown) => e);
    expect((err as TDAMError).code).toBe(500);
    expect((err as TDAMError).message).toContain("server exploded");
  });

  it("aborts on timeout", async () => {
    const sts = { getCredential: vi.fn(async () => cred()), invalidate: vi.fn() };
    const reader = new MemoryFileReader(sts as unknown as StsCredentialManager, 5);
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const err = await reader.read("f.md").catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });
});

describe("createMemoryFileReader", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds reader and manager, honoring opts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(COS_DATA))));
    const reader = createMemoryFileReader(
      { endpoint: "http://mem.example.com/", apiKey: "k", serviceId: "s" },
      { timeout: 1000 },
    );
    expect(reader).toBeInstanceOf(MemoryFileReader);
    const stsManager = (reader as unknown as { stsManager: StsCredentialManager }).stsManager;
    await stsManager.getCredential();
    expect(stsManager).toBeInstanceOf(StsCredentialManager);
  });
});