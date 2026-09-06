import { describe, expect, it, vi, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  expandLeadingTilde,
  isPathInside,
  isWindowsAbsolutePath,
  normalizeStorageKey,
  resolveHomeDir,
} from "../platform-paths.js";
import { FsStorage } from "../../storage/fs-storage.js";
import { resolveDbPath } from "../../db/index.js";

afterEach(() => { vi.unstubAllEnvs(); });

describe("platform-paths (proxy)", () => {
  it("resolveHomeDir never returns empty", () => {
    expect(resolveHomeDir().trim().length).toBeGreaterThan(0);
  });

  it("expandLeadingTilde handles ~, ~/, ~\\ and passthrough", () => {
    const home = path.join(os.tmpdir(), "home-test");
    expect(expandLeadingTilde("~", home)).toBe(home);
    expect(expandLeadingTilde("~/a/b", home)).toBe(path.join(home, "a/b"));
    expect(expandLeadingTilde("~\\a", home)).toBe(path.join(home, "a"));
    expect(expandLeadingTilde("rel", home)).toBe("rel");
    expect(expandLeadingTilde("", home)).toBe("");
  });

  it("isWindowsAbsolutePath detects drive + UNC", () => {
    expect(isWindowsAbsolutePath("D:/x")).toBe(true);
    expect(isWindowsAbsolutePath("D:\\x")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\s\\s")).toBe(true);
    expect(isWindowsAbsolutePath("rel")).toBe(false);
  });

  it("normalizeStorageKey keeps kv keys POSIX", () => {
    expect(normalizeStorageKey("ttl\\\\a//b")).toBe("ttl/a/b");
    expect(normalizeStorageKey("/ttl/a")).toBe("ttl/a");
  });

  it("isPathInside blocks sibling-prefix bypass", () => {
    const parent = path.join(os.tmpdir(), "proxy-inside-test");
    expect(isPathInside(parent, path.join(parent, "x"))).toBe(true);
    expect(isPathInside(parent, parent + "-evil")).toBe(false);
    expect(isPathInside(parent, path.join(parent, "..", "evil"))).toBe(false);
  });
});

describe("resolveDbPath (platform-generic)", () => {
  it("expands leading ~/ via home dir", () => {
    vi.stubEnv("PROXY_DB_PATH", "~/custom/proxy.db");
    const got = resolveDbPath();
    expect(path.isAbsolute(got)).toBe(true);
    expect(got.endsWith(path.join("custom", "proxy.db"))).toBe(true);
    expect(got.startsWith("~")).toBe(false);
  });

  it("expands leading ~\\ on windows-style input", () => {
    vi.stubEnv("PROXY_DB_PATH", "~\\custom\\proxy.db");
    const got = resolveDbPath();
    expect(got.startsWith("~")).toBe(false);
    expect(got.includes("custom")).toBe(true);
  });
});

describe("FsStorage traversal (platform-generic)", () => {
  it("rejects absolute + traversal keys, round-trips nested keys", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mp-fs-win-"));
    try {
      const s = new FsStorage(root);
      await expect(s.putText("/abs.txt", "x")).rejects.toThrow();
      await expect(s.putText("../evil.txt", "x")).rejects.toThrow();
      await expect(s.putText("a/../../evil.txt", "x")).rejects.toThrow();
      const key = ["ttl", "space", "user", "inj-sess.json"].join("/");
      await s.putText(key, "hello");
      expect(await s.getText(key)).toBe("hello");
      expect(await s.listNames("ttl/")).toContain("space/user/inj-sess.json");
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* win lock */ }
    }
  });
});
