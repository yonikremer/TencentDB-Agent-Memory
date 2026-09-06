import { describe, it, expect } from "vitest";
import { slugify, dirForType, pageRelPath } from "./slug.js";

describe("slugify", () => {
  it("returns empty for empty/whitespace/null input", () => {
    expect(slugify("")).toBe("");
    expect(slugify("   ")).toBe("");
    expect(slugify(null as unknown as string)).toBe("");
  });

  it("lowercases english and converts separators to hyphens", () => {
    expect(slugify("Redis Cluster")).toBe("redis-cluster");
    expect(slugify("Cache- Eviction  Policy")).toBe("cache-eviction-policy");
  });

  it("trims leading/trailing/duplicate hyphens", () => {
    expect(slugify("--a--b---")).toBe("a-b");
  });

  it("preserves CJK segments as-is, separated from latin by hyphen", () => {
    expect(slugify("Redis 主从")).toBe("redis-主从");
    expect(slugify("缓存管理")).toBe("缓存管理");
    expect(slugify("A缓存B")).toBe("a-缓存-b");
  });

  it("handles mixed punctuation boundaries", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });
});

describe("dirForType", () => {
  it("maps known types to plural dirs", () => {
    expect(dirForType("source")).toBe("sources");
    expect(dirForType("entity")).toBe("entities");
    expect(dirForType("concept")).toBe("concepts");
    expect(dirForType("comparison")).toBe("comparisons");
    expect(dirForType("synthesis")).toBe("synthesis");
    expect(dirForType("thesis")).toBe("synthesis");
    expect(dirForType("methodology")).toBe("concepts");
    expect(dirForType("finding")).toBe("synthesis");
  });

  it("falls back to lowercased type for unknown types", () => {
    expect(dirForType("misc")).toBe("misc");
    expect(dirForType("")).toBe("other");
    expect(dirForType(null as unknown as string)).toBe("other");
    expect(dirForType("  ")).toBe("other");
  });

  it("is case-insensitive and trims", () => {
    expect(dirForType("  Entity ")).toBe("entities");
  });
});

describe("pageRelPath", () => {
  it("builds wiki relative path with slug", () => {
    expect(pageRelPath("entity", "Redis Cluster")).toBe("wiki/entities/redis-cluster.md");
    expect(pageRelPath("source", "设计文档")).toBe("wiki/sources/设计文档.md");
  });
});