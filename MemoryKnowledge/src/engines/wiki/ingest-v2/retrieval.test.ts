/**
 * retrieval.test.ts — Unit tests for retrieval-augmented ingestion pure functions.
 *
 * Tests pure functions only (buildSearchQuery / formatRetrievedPages), without touching SQLite / LLM:
 * import chain is retrieval.ts -> tokenize.ts + frontmatter.ts, both leaf modules.
 */
import { describe, it, expect } from "vitest";
import { buildSearchQuery, formatRetrievedPages } from "./retrieval.js";

describe("buildSearchQuery", () => {
  it("filters stop words, takes top queryTerms words sorted by frequency", () => {
    // "the" is a stop word; eviction appears 3 times > cache 2 times > policy 1 time
    const q = buildSearchQuery("the cache cache eviction eviction eviction policy", 3);
    expect(q).toBe("eviction cache policy");
  });

  it("limits returned word count by queryTerms", () => {
    const q = buildSearchQuery("cache eviction policy", 2);
    // When frequencies are tied, preserve first appearance order (stable sort)
    expect(q).toBe("cache eviction");
  });

  it("ensures queryTerms is at least 1", () => {
    const q = buildSearchQuery("cache eviction", 0);
    expect(q).toBe("cache");
  });

  it("sorts frequency correctly for Chinese bigram + full words", () => {
    // "缓存 缓存 管理": 缓存 2 times (bigram+word -> token stream 4 items), 管理 1 time (2 items)
    const q = buildSearchQuery("缓存 缓存 管理", 2);
    expect(q).toBe("缓存 管理");
  });

  it("returns empty string when all input are stop words", () => {
    expect(buildSearchQuery("the a an of", 10)).toBe("");
  });
});

describe("formatRetrievedPages", () => {
  it("returns empty string for empty input", () => {
    expect(formatRetrievedPages([], 12000)).toBe("");
  });

  it("strips frontmatter and outputs block header + page header + body", () => {
    const out = formatRetrievedPages(
      [
        {
          relPath: "wiki/concepts/kv-cache.md",
          title: "KV Cache",
          content: [
            "---",
            "title: KV Cache",
            "type: concept",
            "---",
            "",
            "Key/value tensors cached across tokens.",
          ].join("\n"),
        },
      ],
      12000,
    );
    expect(out).toContain("## Relevant Existing Knowledge");
    expect(out).toContain("### KV Cache (wiki/concepts/kv-cache.md)");
    expect(out).toContain("Key/value tensors cached across tokens.");
    expect(out).not.toContain("type: concept"); // frontmatter stripped
  });

  it("outputs multiple pages sequentially", () => {
    const out = formatRetrievedPages(
      [
        { relPath: "wiki/entities/a.md", title: "A", content: "body of a" },
        { relPath: "wiki/entities/b.md", title: "B", content: "body of b" },
      ],
      12000,
    );
    expect(out.indexOf("### A (wiki/entities/a.md)")).toBeLessThan(
      out.indexOf("### B (wiki/entities/b.md)"),
    );
  });

  it("handles pages without frontmatter as raw body", () => {
    const out = formatRetrievedPages([{ relPath: "wiki/x.md", title: "X", content: "raw body" }], 12000);
    expect(out).toContain("raw body");
  });

  it("truncates when exceeding maxChars budget (including block header), output is significantly shorter than full text", () => {
    const longBody = "word ".repeat(600).trim(); // ~3000 chars
    const full = formatRetrievedPages([{ relPath: "wiki/x.md", title: "X", content: longBody }], 1500);
    expect(full.length).toBeGreaterThan(0);
    expect(full.length).toBeLessThan(longBody.length);
    expect(full.endsWith("…")).toBe(true);
  });
});
