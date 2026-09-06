import { describe, it, expect } from "vitest";
import { tokenize } from "./tokenize.js";

describe("tokenize", () => {
  it("returns empty for empty input", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("splits latin words and preserves them", () => {
    expect(tokenize("Redis Cluster")).toEqual(["redis", "cluster"]);
  });

  it("filters english stop words", () => {
    expect(tokenize("the is a an of with")).toEqual([]);
    expect(tokenize("how to use redis")).not.toContain("how");
  });

  it("splits on punctuation and whitespace", () => {
    // note: 'a' is an english stop word, filtered out
    expect(tokenize("a,b。c！d？e；f：g（）")).toEqual(["b", "c", "d", "e", "f", "g"]);
    expect(tokenize("hello-world_test/slash\\back")).toContain("hello");
  });

  it("tokenizes pure chinese into bigrams plus the whole word", () => {
    const t = tokenize("缓存管理");
    expect(t).toContain("缓存");
    expect(t).toContain("存管");
    expect(t).toContain("缓存管理");
  });

  it("keeps whole CJK multi-char token even when stop-word char appears", () => {
    expect(tokenize("的是什么")).toContain("的是什么");
  });

  it("handles mixed CJK+latin tokens by splitting", () => {
    const t = tokenize("l0ingest");
    expect(t.length).toBeGreaterThan(0);
  });

  it("handles single chinese chars between latin words", () => {
    expect(tokenize("x的y")).toEqual(["x", "y"]);
  });
});