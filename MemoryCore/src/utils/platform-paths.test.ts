import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  expandLeadingTilde,
  isPathInside,
  isResolvedInside,
  isWindowsAbsolutePath,
  normalizeStorageKey,
  resolveHomeDir,
} from "./platform-paths.js";
import { sanitizeTmpSegment } from "./clean-context-runner.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";

describe("platform-paths (core)", () => {
  it("resolveHomeDir never returns empty", () => {
    expect(resolveHomeDir().trim().length).toBeGreaterThan(0);
  });

  it("expandLeadingTilde handles ~, ~/, ~\\ and passthrough", () => {
    const home = path.join(os.tmpdir(), "home-test");
    expect(expandLeadingTilde("~", home)).toBe(home);
    expect(expandLeadingTilde("~/a/b", home)).toBe(path.join(home, "a/b"));
    expect(expandLeadingTilde("~\\a\\b", home)).toBe(path.join(home, "a\\b"));
    expect(expandLeadingTilde("/abs/path", home)).toBe("/abs/path");
    expect(expandLeadingTilde("rel/path", home)).toBe("rel/path");
    expect(expandLeadingTilde("", home)).toBe("");
    // bare ~user is NOT expanded (only bare ~)
    expect(expandLeadingTilde("~other/x", home)).toBe("~other/x");
  });

  it("isWindowsAbsolutePath detects drive + UNC", () => {
    expect(isWindowsAbsolutePath("C:\\evil")).toBe(true);
    expect(isWindowsAbsolutePath("C:/evil")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isWindowsAbsolutePath("/posix/abs")).toBe(false);
    expect(isWindowsAbsolutePath("rel/path")).toBe(false);
    expect(isWindowsAbsolutePath("C:relative")).toBe(false);
  });

  it("isPathInside blocks sibling-prefix bypass", () => {
    const parent = path.join(os.tmpdir(), "tdai-inside-test");
    expect(isPathInside(parent, path.join(parent, "a", "b"))).toBe(true);
    expect(isPathInside(parent, parent)).toBe(true);
    expect(isPathInside(parent, path.join(parent, "..", "evil"))).toBe(false);
    // "base-evil" starts with base string but is NOT inside
    expect(isPathInside(parent, parent + "-evil")).toBe(false);
  });

  it("isResolvedInside matches isPathInside semantics", () => {
    const root = path.resolve(os.tmpdir(), "tdai-res-test");
    expect(isResolvedInside(root, root)).toBe(true);
    expect(isResolvedInside(root, root + path.sep + "a")).toBe(true);
    expect(isResolvedInside(root, root + "-evil")).toBe(false);
  });

  it("normalizeStorageKey keeps object keys POSIX", () => {
    expect(normalizeStorageKey("a\\\\b//c")).toBe("a/b/c");
    expect(normalizeStorageKey("//a/b")).toBe("a/b");
    expect(normalizeStorageKey("a/b")).toBe("a/b");
  });

  it("sanitizeTmpSegment strips separators (Windows-safe mkdtemp prefix)", () => {
    expect(sanitizeTmpSegment("a:b/c\\d?e")).toBe("a_b_c_d_e");
    expect(sanitizeTmpSegment("")).toBe("task");
    expect(sanitizeTmpSegment("ok-1_2.3")).toBe("ok-1_2.3");
  });
});

describe("LocalStorageBackend traversal (platform-generic)", () => {
  it("rejects .., absolute, drive-letter and backslash traversal keys", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tdai-local-"));
    try {
      const be = new LocalStorageBackend(root);
      await expect(be.putObject("../evil.txt", "x")).rejects.toThrow();
      await expect(be.putObject("/abs/evil.txt", "x")).rejects.toThrow();
      await expect(be.putObject("C:/evil.txt", "x")).rejects.toThrow();
      await expect(be.putObject("C:\\evil.txt", "x")).rejects.toThrow();
      await expect(be.putObject("a/../../evil.txt", "x")).rejects.toThrow();
      await expect(be.putObject("a\\..\\..\\evil.txt", "x")).rejects.toThrow();
      // valid nested key round-trips
      await be.putObject("a/b/c.txt", "hello");
      const obj = await be.getObject("a/b/c.txt");
      expect(obj?.content.toString("utf-8")).toBe("hello");
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* win lock */ }
    }
  });
});
