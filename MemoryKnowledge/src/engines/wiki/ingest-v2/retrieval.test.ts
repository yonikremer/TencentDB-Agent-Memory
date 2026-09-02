/**
 * retrieval.test.ts — 检索增强摄取纯函数单测。
 *
 * 只测纯函数（buildSearchQuery / formatRetrievedPages），不碰 SQLite / LLM：
 * import 链为 retrieval.ts → tokenize.ts + frontmatter.ts，均为 leaf 模块。
 */
import { describe, it, expect } from "vitest";
import { buildSearchQuery, formatRetrievedPages } from "./retrieval.js";

describe("buildSearchQuery", () => {
  it("过滤 stop words，按词频降序取前 queryTerms 个词", () => {
    // "the" 是 stop word；eviction 出现 3 次 > cache 2 次 > policy 1 次
    const q = buildSearchQuery("the cache cache eviction eviction eviction policy", 3);
    expect(q).toBe("eviction cache policy");
  });

  it("queryTerms 限制返回词数", () => {
    const q = buildSearchQuery("cache eviction policy", 2);
    // 词频并列时按首次出现顺序（sort 稳定）
    expect(q).toBe("cache eviction");
  });

  it("queryTerms 至少为 1", () => {
    const q = buildSearchQuery("cache eviction", 0);
    expect(q).toBe("cache");
  });

  it("中文 bigram + 整词，词频排序正确", () => {
    // "缓存 缓存 管理"：缓存 2 次（bigram+整词 → token 流 4 个）、管理 1 次（2 个）
    const q = buildSearchQuery("缓存 缓存 管理", 2);
    expect(q).toBe("缓存 管理");
  });

  it("全 stop words 时返回空串", () => {
    expect(buildSearchQuery("the a an of", 10)).toBe("");
  });
});

describe("formatRetrievedPages", () => {
  it("空输入返回空串", () => {
    expect(formatRetrievedPages([], 12000)).toBe("");
  });

  it("剥离 frontmatter，输出块头 + 页头 + 正文", () => {
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
    expect(out).not.toContain("type: concept"); // frontmatter 已剥离
  });

  it("多页依次输出", () => {
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

  it("无 frontmatter 的页按原文处理", () => {
    const out = formatRetrievedPages([{ relPath: "wiki/x.md", title: "X", content: "raw body" }], 12000);
    expect(out).toContain("raw body");
  });

  it("超过 maxChars 预算时截断（含块头），输出明显短于全文", () => {
    const longBody = "word ".repeat(600).trim(); // ~3000 chars
    const full = formatRetrievedPages([{ relPath: "wiki/x.md", title: "X", content: longBody }], 1500);
    expect(full.length).toBeGreaterThan(0);
    expect(full.length).toBeLessThan(longBody.length);
    expect(full.endsWith("…")).toBe(true);
  });
});
