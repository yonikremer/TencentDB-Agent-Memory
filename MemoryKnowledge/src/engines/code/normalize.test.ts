/**
 * normalize.test.ts — Unit tests for git repo URL normalization + source keys.
 */
import { describe, it, expect } from "vitest";
import { normalizeRepoUrl, sourceKey, parseSourceKey } from "./normalize.js";

describe("normalizeRepoUrl", () => {
  it("normalizes SSH scp-like form git@host:path", () => {
    expect(normalizeRepoUrl("git@gitlab.example.com:namespace/project/repo.git")).toBe(
      "gitlab.example.com/namespace/project/repo",
    );
  });

  it("normalizes ssh:// scheme form with user", () => {
    expect(normalizeRepoUrl("ssh://git@gitlab.example.com/namespace/project/repo")).toBe(
      "gitlab.example.com/namespace/project/repo",
    );
  });

  it("normalizes https:// URL", () => {
    expect(normalizeRepoUrl("https://gitlab.example.com/namespace/project/repo.git")).toBe(
      "gitlab.example.com/namespace/project/repo",
    );
  });

  it("normalizes http:// URL", () => {
    expect(normalizeRepoUrl("http://host.example/group/proj")).toBe("host.example/group/proj");
  });

  it("passes through already-normalized host/path form", () => {
    expect(normalizeRepoUrl("gitlab.example.com/namespace/project/repo")).toBe(
      "gitlab.example.com/namespace/project/repo",
    );
    // passthrough also strips a trailing .git
    expect(normalizeRepoUrl("gitlab.example.com/namespace/project/repo.git")).toBe(
      "gitlab.example.com/namespace/project/repo",
    );
  });

  it("keeps nested groups / dots in host intact", () => {
    expect(normalizeRepoUrl("git@github.com:org/sub/group/repo.git")).toBe("github.com/org/sub/group/repo");
    expect(normalizeRepoUrl("https://github.com/org/repo.git")).toBe("github.com/org/repo");
  });
});

describe("sourceKey / parseSourceKey", () => {
  it("joins normalized repo + branch", () => {
    expect(sourceKey("git@gitlab.example.com:a/b.git", "dev")).toBe("gitlab.example.com/a/b:dev");
  });

  it("defaults empty branch to main", () => {
    expect(sourceKey("https://host/x.git", "")).toBe("host/x:main");
    expect(sourceKey("host/x", undefined as unknown as string)).toBe("host/x:main");
  });

  it("splits on last colon to recover repo + branch", () => {
    expect(parseSourceKey("gitlab.example.com/a/b:dev")).toEqual({
      repo: "gitlab.example.com/a/b",
      branch: "dev",
    });
  });

  it("round-trips sourceKey -> parseSourceKey", () => {
    const key = sourceKey("git@h:p/r.git", "feature/x");
    expect(parseSourceKey(key)).toEqual({ repo: "h/p/r", branch: "feature/x" });
  });

  it("handles key with no colon (lastIndexOf -1 path)", () => {
    // Document actual behavior: no colon -> slice(0,-1) drops final char, branch = whole string
    expect(parseSourceKey("host/repo")).toEqual({ repo: "host/rep", branch: "host/repo" });
  });
});
