import { describe, it, expect } from "vitest";
import { normalizeWikiPath, parseFileBlocks } from "./file-protocol.js";

describe("normalizeWikiPath", () => {
  it("accepts valid wiki paths", () => {
    expect(normalizeWikiPath("wiki/entities/redis.md")).toBe("wiki/entities/redis.md");
    expect(normalizeWikiPath("./wiki/a/b.md")).toBe("wiki/a/b.md");
    expect(normalizeWikiPath("wiki\\entities\\redis.md")).toBe("wiki/entities/redis.md");
  });

  it("rejects empty / invalid", () => {
    expect(normalizeWikiPath("")).toBeNull();
    expect(normalizeWikiPath("   ")).toBeNull();
    expect(normalizeWikiPath(null as unknown as string)).toBeNull();
    expect(normalizeWikiPath("/abs/wiki/x.md")).toBeNull();
    expect(normalizeWikiPath("C:/wiki/x.md")).toBeNull();
    expect(normalizeWikiPath("wiki/../x.md")).toBeNull();
    expect(normalizeWikiPath("wiki/./x.md")).toBeNull();
    expect(normalizeWikiPath("wiki")).toBeNull();
    expect(normalizeWikiPath("other/x.md")).toBeNull();
    expect(normalizeWikiPath("wikix/a.md")).toBeNull();
  });
});

describe("parseFileBlocks", () => {
  it("returns empty for null/empty text", () => {
    expect(parseFileBlocks("")).toEqual({ files: [], warnings: [] });
    expect(parseFileBlocks(null as unknown as string)).toEqual({ files: [], warnings: [] });
  });

  it("parses a single valid block", () => {
    const { files, warnings } = parseFileBlocks(
      `Intro text\n<<<FILE path="wiki/entities/redis.md">>>\n---\ntype: entity\n---\nbody\n<<<END>>>`,
    );
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("wiki/entities/redis.md");
    expect(files[0].content).toContain("type: entity");
    expect(files[0].content).toContain("body");
    expect(warnings).toEqual([]);
  });

  it("parses multiple blocks", () => {
    const { files, warnings } = parseFileBlocks(
      `<<<FILE path="wiki/a.md">>>\nA\n<<<END>>>\n<<<FILE path="wiki/b.md">>>\nB\n<<<END>>>`,
    );
    expect(files.map((f) => f.path)).toEqual(["wiki/a.md", "wiki/b.md"]);
    expect(warnings).toEqual([]);
  });

  it("discards unclosed block with warning", () => {
    const { files, warnings } = parseFileBlocks(`<<<FILE path="wiki/a.md">>>\nunclosed`);
    expect(files).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Unclosed");
  });

  it("skips invalid path with warning but keeps following blocks", () => {
    const { files, warnings } = parseFileBlocks(
      `<<<FILE path="/etc/passwd">>>\nx\n<<<END>>>\n<<<FILE path="wiki/ok.md">>>\ny\n<<<END>>>`,
    );
    expect(files.map((f) => f.path)).toEqual(["wiki/ok.md"]);
    expect(warnings[0]).toContain("Invalid path");
  });

  it("skips empty blocks with warning", () => {
    const { files, warnings } = parseFileBlocks(`<<<FILE path="wiki/empty.md">>>\n\n<<<END>>>`);
    expect(files).toEqual([]);
    expect(warnings[0]).toContain("Empty FILE block");
  });

  it("accepts 2-plus > closing variants and END with whitespace", () => {
    const { files } = parseFileBlocks(`<<<FILE path="wiki/a.md">>\ncontent\n<<< \nEND\n >>>`);
    expect(files).toHaveLength(1);
    expect(files[0].content).toContain("content");
  });

  it("normalizes backslash paths from LLM", () => {
    const { files } = parseFileBlocks(`<<<FILE path="wiki\\entities\\x.md">>>\n---\n---\ntext\n<<<END>>>`);
    expect(files[0].path).toBe("wiki/entities/x.md");
  });
});