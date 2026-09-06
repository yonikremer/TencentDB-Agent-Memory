/**
 * tools.test.ts — Structural tests for the 12 MCP tool definitions.
 */
import { describe, it, expect } from "vitest";
import { MCP_TOOLS } from "./tools.js";

describe("MCP_TOOLS", () => {
  it("defines exactly 12 tools (8 code-graph + 4 wiki)", () => {
    expect(MCP_TOOLS).toHaveLength(12);
  });

  it("every tool has name/description/schema/endpoint", () => {
    for (const t of MCP_TOOLS) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.properties).toBeTypeOf("object");
      expect(Array.isArray(t.inputSchema.required)).toBe(true);
      expect(t.endpoint.startsWith("/")).toBe(true);
    }
  });

  it("code-graph tools target /code-graph endpoints and require code_graph_id", () => {
    const codeTools = MCP_TOOLS.filter((t) => t.name.startsWith("code_"));
    expect(codeTools).toHaveLength(8);
    for (const t of codeTools) {
      expect(t.endpoint).toMatch(/^\/code-graph\//);
      expect(t.inputSchema.required).toContain("code_graph_id");
    }
    expect(MCP_TOOLS.map((t) => t.name)).toContain("code_search");
    expect(MCP_TOOLS.map((t) => t.name)).toContain("code_files");
  });

  it("wiki tools target /wiki endpoints and require wiki_id", () => {
    const wikiTools = MCP_TOOLS.filter((t) => t.name.startsWith("wiki_"));
    expect(wikiTools).toHaveLength(4);
    for (const t of wikiTools) {
      expect(t.endpoint).toMatch(/^\/wiki\//);
      expect(t.inputSchema.required).toContain("wiki_id");
    }
    expect(MCP_TOOLS.map((t) => t.name)).toEqual(
      expect.arrayContaining(["wiki_search", "wiki_read", "wiki_list", "wiki_graph"]),
    );
  });

  it("wiki_read requires refs array", () => {
    const read = MCP_TOOLS.find((t) => t.name === "wiki_read")!;
    expect(read.inputSchema.required).toContain("refs");
  });
});
