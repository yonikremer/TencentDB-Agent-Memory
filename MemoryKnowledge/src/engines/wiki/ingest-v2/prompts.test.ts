import { describe, it, expect } from "vitest";
import {
  buildAnalysisSystemPrompt,
  buildAnalysisPrompt,
  buildSystemPrompt,
  buildGeneratePrompt,
  buildGenerateFromAnalysisPrompt,
} from "./prompts.js";
import { DEFAULT_PURPOSE, DEFAULT_SCHEMA } from "./template.js";

const template = { purpose: DEFAULT_PURPOSE, schema: DEFAULT_SCHEMA, customized: false };
const existing = [
  { relPath: "wiki/entities/redis.md", title: "Redis", type: "entity", description: "a cache" },
  { relPath: "wiki/concepts/kv.md", title: "KV", type: "concept" },
];

describe("prompts", () => {
  it("buildAnalysisSystemPrompt embeds template", () => {
    const s = buildAnalysisSystemPrompt(template);
    expect(s).toContain("knowledge base analyst");
    expect(s).toContain("## Wiki Purpose");
    expect(s).toContain(DEFAULT_PURPOSE.slice(0, 40));
  });

  it("buildAnalysisPrompt lists pages and includes retrieval context", () => {
    const s = buildAnalysisPrompt({ sourceName: "r.md", sourceText: "text", existingPages: existing, retrievalContext: "ctx" });
    expect(s).toContain("r.md");
    expect(s).toContain("[entity] wiki/entities/redis.md");
    expect(s).toContain("(a cache)");
    expect(s).toContain("ctx");
  });

  it("buildAnalysisPrompt handles empty pages and no retrieval", () => {
    const s = buildAnalysisPrompt({ sourceName: "r.md", sourceText: "t", existingPages: [] });
    expect(s).toContain("wiki is empty");
    expect(s).not.toContain("ctx");
  });

  it("buildSystemPrompt includes protocol rules", () => {
    const s = buildSystemPrompt(template);
    expect(s).toContain("<<<FILE");
    expect(s).toContain("wiki/entities/");
    expect(s).toContain("Do NOT output a `locked` field");
  });

  it("buildGeneratePrompt includes update section and retrieval rule anchor", () => {
    const s = buildGeneratePrompt({
      sourceName: "src.md",
      sourceText: "body",
      existingPages: existing,
      pagesToUpdate: [{ relPath: "wiki/entities/redis.md", content: "--\ntype: entity\n--\nold" }],
      retrievalContext: "RETRIEVAL",
    });
    expect(s).toContain("src.md");
    expect(s).toContain("## Pages to Update");
    expect(s).toContain("RETRIEVAL");
    expect(s).toContain("${RETRIEVAL_CONTEXT_RULE}");
  });

  it("buildGeneratePrompt omits update section when empty", () => {
    const s = buildGeneratePrompt({ sourceName: "s", sourceText: "t", existingPages: [] });
    expect(s).not.toContain("## Pages to Update");
    expect(s).toContain("wiki is empty");
  });

  it("buildGenerateFromAnalysisPrompt includes analysis plan", () => {
    const s = buildGenerateFromAnalysisPrompt({
      sourceName: "s.md",
      sourceText: "t",
      analysis: "PLAN: create pages",
      existingPages: existing,
      retrievalContext: "R",
    });
    expect(s).toContain("PLAN: create pages");
    expect(s).toContain("R");
    expect(s).toContain("Extraction Plan");
  });
});