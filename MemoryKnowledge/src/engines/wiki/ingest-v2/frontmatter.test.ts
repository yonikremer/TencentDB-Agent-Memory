import { describe, it, expect } from "vitest";
import { parseFrontmatter, buildPage, isLocked, readSources } from "./frontmatter.js";

const SAMPLE = `---
type: entity
title: Redis
description: A cache
sources: ["redis.md"]
tags: [cache]
timestamp: "2024-01-01"
custom: keepme
---

# Body
content here
`;

describe("parseFrontmatter", () => {
  it("parses valid frontmatter and body", () => {
    const r = parseFrontmatter(SAMPLE);
    expect(r.hasFrontmatter).toBe(true);
    expect(r.frontmatter.type).toBe("entity");
    expect(r.frontmatter.title).toBe("Redis");
    expect(r.frontmatter.custom).toBe("keepme");
    expect(r.body).toContain("# Body");
  });

  it("handles missing frontmatter", () => {
    const r = parseFrontmatter("just body");
    expect(r.hasFrontmatter).toBe(false);
    expect(r.frontmatter.type).toBe("other");
  });

  it("handles malformed yaml without throwing", () => {
    const r = parseFrontmatter("---\n{{{{bad\n---\nbody");
    expect(r.hasFrontmatter).toBe(false);
    expect(r.frontmatter.type).toBe("other");
  });

  it("handles non-object yaml (list) as frontmatter with type other", () => {
    const r = parseFrontmatter("---\n- list\n- items\n---\nbody");
    expect(r.hasFrontmatter).toBe(true);
    expect(r.frontmatter.type).toBe("other");
  });

  it("fills type other when type missing or empty", () => {
    const r = parseFrontmatter("---\ntitle: X\n---\nbody");
    expect(r.frontmatter.type).toBe("other");
  });

  it("handles CRLF and null input", () => {
    const r = parseFrontmatter("---\r\ntype: entity\r\n---\r\nbody");
    expect(r.hasFrontmatter).toBe(true);
    expect(parseFrontmatter(null as unknown as string).hasFrontmatter).toBe(false);
  });
});

describe("buildPage", () => {
  it("round-trips fields in stable order", () => {
    const out = buildPage(
      { type: "entity", title: "T", description: "D", sources: ["a.md"], tags: ["x"], timestamp: "t", locked: true, extra: 1 },
      "  body  ",
    );
    expect(out).toContain("---\ntype: entity");
    expect(out).toContain("title: T");
    expect(out).not.toContain("locked");
    expect(out).toContain("extra: 1");
    expect(out).toContain("body");
  });

  it("defaults type to other and omits null fields", () => {
    const out = buildPage({ title: undefined, description: null as unknown as string }, "b");
    expect(out).toContain("type: other");
    expect(out).not.toContain("title:");
  });
});

describe("isLocked / readSources", () => {
  it("detects locked frontmatter", () => {
    expect(isLocked("---\nlocked: true\n---\nbody")).toBe(true);
    expect(isLocked(SAMPLE)).toBe(false);
  });

  it("reads string sources only", () => {
    expect(readSources(SAMPLE)).toEqual(["redis.md"]);
    expect(readSources("---\nsources: [1, \"x\"]\n---\nb")).toEqual(["x"]);
    expect(readSources("no fm")).toEqual([]);
  });
});