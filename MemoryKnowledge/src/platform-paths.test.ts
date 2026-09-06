import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  expandLeadingTilde,
  isPathInside,
  isWindowsAbsolutePath,
  normalizeStorageKey,
  resolveHomeDir,
  isEscapingRelativeKey,
  isResolvedInside,
} from "./platform-paths.js";
import { expandHome } from "./config.js";
import { normalizeWikiPath } from "./engines/wiki/ingest-v2/file-protocol.js";
import { canonicalizePagePath } from "./engines/wiki/ingest-v2/index.js";

describe("platform-paths (knowledge)", () => {
  it("resolveHomeDir never returns empty", () => {
    expect(resolveHomeDir().trim().length).toBeGreaterThan(0);
  });

  it("expandLeadingTilde handles ~, ~/, ~\\ and passthrough", () => {
    const home = path.join(os.tmpdir(), "home-test");
    expect(expandLeadingTilde("~", home)).toBe(home);
    expect(expandLeadingTilde("~/a", home)).toBe(path.join(home, "a"));
    expect(expandLeadingTilde("~\\a", home)).toBe(path.join(home, "a"));
    expect(expandLeadingTilde("rel", home)).toBe("rel");
    expect(expandLeadingTilde("", home)).toBe("");
  });

  it("isWindowsAbsolutePath detects drive + UNC", () => {
    expect(isWindowsAbsolutePath("C:/x")).toBe(true);
    expect(isWindowsAbsolutePath("C:\\x")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\s\\s")).toBe(true);
    expect(isWindowsAbsolutePath("/x")).toBe(false);
    expect(isWindowsAbsolutePath("x")).toBe(false);
    expect(isWindowsAbsolutePath("C:rel")).toBe(false);
  });

  it("isPathInside blocks sibling-prefix bypass", () => {
    const parent = path.join(os.tmpdir(), "know-inside-test");
    expect(isPathInside(parent, path.join(parent, "wiki"))).toBe(true);
    expect(isPathInside(parent, parent)).toBe(true);
    expect(isPathInside(parent, parent + "-evil")).toBe(false);
    expect(isPathInside(parent, path.join(parent, "..", "evil"))).toBe(false);
  });

  it("isEscapingRelativeKey rejects escapes", () => {
    expect(isEscapingRelativeKey("")).toBe(true);
    expect(isEscapingRelativeKey("../x")).toBe(true);
    expect(isEscapingRelativeKey("a/../../x")).toBe(true);
    expect(isEscapingRelativeKey("/abs")).toBe(true);
    expect(isEscapingRelativeKey("C:/abs")).toBe(true);
    expect(isEscapingRelativeKey("C:\\abs")).toBe(true);
    expect(isEscapingRelativeKey("a/b/c.md")).toBe(false);
  });

  it("isResolvedInside handles equality + nesting", () => {
    const root = path.resolve(os.tmpdir(), "know-res-test");
    expect(isResolvedInside(root, root)).toBe(true);
    expect(isResolvedInside(root, root + path.sep + "a")).toBe(true);
    expect(isResolvedInside(root, root + "-evil")).toBe(false);
  });

  it("normalizeStorageKey keeps keys POSIX", () => {
    expect(normalizeStorageKey("a\\\\b//c")).toBe("a/b/c");
    expect(normalizeStorageKey("/a")).toBe("a");
  });
});

describe("expandHome (platform-generic)", () => {
  it("expands ~/ and ~\\ to an absolute path", () => {
    for (const p of [expandHome("~/custom"), expandHome("~\\custom")]) {
      expect(path.isAbsolute(p)).toBe(true);
      expect(p.startsWith("~")).toBe(false);
    }
    expect(expandHome("~/db.sqlite")).toContain("db.sqlite");
  });

  it("leaves non-tilde paths unchanged", () => {
    expect(expandHome("/abs/x")).toBe("/abs/x");
    expect(expandHome("rel/x")).toBe("rel/x");
    expect(expandHome("")).toBe("");
  });
});

describe("wiki paths accept Windows separators", () => {
  it("normalizeWikiPath treats \\ like /", () => {
    expect(normalizeWikiPath("wiki\\\\entities\\\\a.md")).toBe("wiki/entities/a.md");
    expect(normalizeWikiPath("wiki/entities/a.md")).toBe("wiki/entities/a.md");
  });

  it("normalizeWikiPath still rejects traversal + drive paths", () => {
    expect(normalizeWikiPath("wiki/../../evil.md")).toBeNull();
    expect(normalizeWikiPath("wiki\\\\..\\\\evil.md")).toBeNull();
    expect(normalizeWikiPath("C:/wiki/a.md")).toBeNull();
    expect(normalizeWikiPath("/wiki/a.md")).toBeNull();
  });

  it("canonicalizePagePath normalizes backslashes", () => {
    const content = "---\ntype: entity\ntitle: T\n---\nbody\n";
    const fromSlash = canonicalizePagePath("wiki/entities/sub/a.md", content);
    const fromBack = canonicalizePagePath("wiki\\\\entities\\\\sub\\\\a.md", content);
    expect(fromBack).toBe(fromSlash);
    expect(fromBack.includes("\\")).toBe(false);
  });
});
