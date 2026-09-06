/**
 * ids.test.ts — Unit tests for knowledge asset ID generation.
 */
import { describe, it, expect } from "vitest";
import {
  WIKI_ID_PREFIX,
  CODE_GRAPH_ID_PREFIX,
  genWikiId,
  genCodeGraphId,
  isWikiId,
  isCodeGraphId,
} from "./ids.js";

const ID_RE = /^[0-9a-z]{8}$/;

describe("genWikiId / genCodeGraphId", () => {
  it("prefixed + 8 random base36 chars", () => {
    for (let i = 0; i < 50; i++) {
      const w = genWikiId();
      const c = genCodeGraphId();
      expect(w.startsWith(WIKI_ID_PREFIX)).toBe(true);
      expect(c.startsWith(CODE_GRAPH_ID_PREFIX)).toBe(true);
      expect(w.slice(WIKI_ID_PREFIX.length)).toMatch(ID_RE);
      expect(c.slice(CODE_GRAPH_ID_PREFIX.length)).toMatch(ID_RE);
    }
  });

  it("is globally-unique-ish across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = genWikiId();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

describe("isWikiId / isCodeGraphId", () => {
  it("accepts well-formed ids", () => {
    expect(isWikiId("wiki-abcdef12")).toBe(true);
    expect(isCodeGraphId("cg-abcdef12")).toBe(true);
    expect(isWikiId("wiki-00000000")).toBe(true);
    expect(isCodeGraphId("cg-zzzzzzzz")).toBe(true);
  });

  it("rejects wrong prefix", () => {
    expect(isWikiId("cg-abcdef12")).toBe(false);
    expect(isCodeGraphId("wiki-abcdef12")).toBe(false);
    expect(isWikiId("abcdef12")).toBe(false);
    expect(isCodeGraphId("cgx-abcdef12")).toBe(false);
  });

  it("rejects wrong length / bad charset / uppercase", () => {
    expect(isWikiId("wiki-abc")).toBe(false);
    expect(isWikiId("wiki-abcdef123")).toBe(false);
    expect(isWikiId("wiki-ABCDEF12")).toBe(false);
    expect(isWikiId("wiki-abcde f2")).toBe(false);
    expect(isCodeGraphId("cg-abc")).toBe(false);
    expect(isCodeGraphId("cg-abcdef123")).toBe(false);
    expect(isCodeGraphId("cg-ABCDEF12")).toBe(false);
  });
});
