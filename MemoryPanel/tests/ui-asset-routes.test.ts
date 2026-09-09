/**
 * ui-asset-routes.test.ts — deep-link URL scheme for the wiki UI.
 *
 * Covers the pure helpers behind BrowserRouter navigation:
 * list/detail/tab builders, param validators, and the push-dedupe guard
 * that keeps re-clicks from stacking duplicate history entries.
 */
import { describe, it, expect, vi } from "vitest";
import {
  isWikiTab,
  isMemoryLayer,
  wikiPath,
  codePath,
  skillPath,
  memoryPath,
  navigateIfDiff,
} from "../web/src/lib/asset-routes.js";

describe("asset deep links", () => {
  it("builds wiki list/detail/tab URLs", () => {
    expect(wikiPath()).toBe("/wiki");
    expect(wikiPath("w1")).toBe("/wiki/w1/overview");
    expect(wikiPath("w1", "graph")).toBe("/wiki/w1/graph");
    expect(wikiPath("w1", "bogus")).toBe("/wiki/w1/overview");
    expect(wikiPath("a/b")).toBe("/wiki/a%2Fb/overview");
  });

  it("builds code/skill/memory URLs", () => {
    expect(codePath()).toBe("/code");
    expect(codePath("c1")).toBe("/code/c1");
    expect(skillPath()).toBe("/skills");
    expect(skillPath("s1")).toBe("/skills/s1");
    expect(memoryPath()).toBe("/memory");
    expect(memoryPath("b1")).toBe("/memory/b1/L1");
    expect(memoryPath("b1", "L2")).toBe("/memory/b1/L2");
    expect(memoryPath("b1", "bogus")).toBe("/memory/b1/L1");
  });

  it("validates tab/layer params (unknown -> 404 page)", () => {
    expect(isWikiTab("overview")).toBe(true);
    expect(isWikiTab("search")).toBe(true);
    expect(isWikiTab("nope")).toBe(false);
    expect(isWikiTab(undefined)).toBe(false);
    expect(isMemoryLayer("L0")).toBe(true);
    expect(isMemoryLayer("L3")).toBe(true);
    expect(isMemoryLayer("L9")).toBe(false);
  });

  it("skips navigate when already on the target path", () => {
    const nav = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/wiki" } });
    try {
      navigateIfDiff(nav, "/wiki");
      expect(nav).not.toHaveBeenCalled();
      navigateIfDiff(nav, "/wiki/w1/overview");
      expect(nav).toHaveBeenCalledWith("/wiki/w1/overview");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
