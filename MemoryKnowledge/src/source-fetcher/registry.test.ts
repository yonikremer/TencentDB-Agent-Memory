/**
 * registry.test.ts — Unit tests for SourceFetcherRegistry routing.
 */
import { describe, it, expect, vi } from "vitest";
import { SourceFetcherRegistry } from "./registry.js";

describe("SourceFetcherRegistry", () => {
  it("defaults to a git fetcher", () => {
    const reg = new SourceFetcherRegistry();
    expect(reg.resolve("https://github.com/a/b.git").supportedType).toBe("git");
    expect(reg.resolve("git@github.com:a/b.git").supportedType).toBe("git");
    expect(reg.resolve("ssh://git@h:22/x/y.git").supportedType).toBe("git");
    expect(reg.resolve("http://h/x/y.git").supportedType).toBe("git");
  });

  it("detects local paths", () => {
    const reg = new SourceFetcherRegistry();
    // local not registered -> throws unsupported, but detection still routes to local
    expect(() => reg.resolve("/abs/path")).toThrow("unsupported source type: local");
    expect(() => reg.resolve("./rel")).toThrow("unsupported source type: local");
    expect(() => reg.resolve("file:///x/y")).toThrow("unsupported source type: local");
  });

  it("detects ftp", () => {
    const reg = new SourceFetcherRegistry();
    expect(() => reg.resolve("ftp://h/x")).toThrow("unsupported source type: ftp");
  });

  it("register() overrides and enables resolution", () => {
    const reg = new SourceFetcherRegistry();
    const local = { supportedType: "local" as const, fetch: vi.fn(), sync: vi.fn(), validate: vi.fn() };
    reg.register(local);
    expect(reg.resolve("/tmp/x")).toBe(local);
    // git still works after registering local
    expect(reg.resolve("https://h/x.git").supportedType).toBe("git");
  });

  it("unknown-looking urls fall back to git", () => {
    const reg = new SourceFetcherRegistry();
    expect(reg.resolve("not-a-url").supportedType).toBe("git");
  });
});
