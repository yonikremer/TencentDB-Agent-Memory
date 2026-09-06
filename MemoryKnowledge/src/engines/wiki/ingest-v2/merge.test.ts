import { describe, it, expect } from "vitest";
import { unionSources, isCandidateRedundant, mergePage, DEFAULT_FULL_REWRITE_MAX_CHARS } from "./merge.js";
import type { LlmClient } from "./llm.js";

const OLD = `---
type: entity
title: Redis
sources: ["a.md"]
---

old body text here
`;

const CAND = `---
type: entity
title: Redis
sources: ["b.md"]
---

new candidate body
`;

function fakeLlm(results: string[]): LlmClient {
  let i = 0;
  return {
    config: { protocol: "openai", baseUrl: "", apiKey: "", model: "m", maxTokens: 100, timeoutMs: 1000, stream: false },
    chat: async () => results[i++ % results.length],
  };
}

describe("unionSources", () => {
  it("dedupes and trims non-empty strings", () => {
    expect(unionSources(["a.md", " "], ["a.md", "b.md"])).toEqual(["a.md", "b.md"]);
    expect(unionSources([], [])).toEqual([]);
  });
});

describe("isCandidateRedundant", () => {
  it("true when candidate covered by old (whitespace-insensitive)", () => {
    expect(isCandidateRedundant("hello   world", "hello world")).toBe(true);
  });
  it("true for empty candidate", () => {
    expect(isCandidateRedundant("anything", "   ")).toBe(true);
  });
  it("false when candidate adds content", () => {
    expect(isCandidateRedundant("hello", "hello world")).toBe(false);
  });
});

describe("mergePage", () => {
  it("writes directly when page does not exist", async () => {
    const d = await mergePage(null, CAND, fakeLlm([]));
    expect(d).toEqual({ action: "write", content: CAND });
  });

  it("skips locked pages", async () => {
    const locked = "---\nlocked: true\ntype: entity\n---\nbody";
    const d = await mergePage(locked, CAND, fakeLlm([]));
    expect(d).toEqual({ action: "skip", reason: "Target page locked, skipping merge" });
  });

  it("rule-based dedup: rewrites with sources union without calling LLM", async () => {
    const oldDup = `---
type: entity
sources: ["a.md"]
---

same body
`;
    const candDup = `---
type: entity
sources: ["b.md"]
---

same body
`;
    const d = await mergePage(oldDup, candDup, fakeLlm([]));
    expect(d.action).toBe("write");
    expect(d.content).toContain("b.md");
    expect(d.content).toContain("a.md");
    expect(d.content).toContain("same body");
  });

  it("small page: full rewrite with reconciled sources", async () => {
    const merged = `---
type: entity
title: Redis
sources: ["c.md"]
---

merged body
`;
    const d = await mergePage(OLD, CAND, fakeLlm([merged]));
    expect(d.action).toBe("write");
    expect(d.content).toContain("merged body");
    // sources are reconciled to old ∪ new union (c.md replaced)
    expect(d.content).not.toContain("c.md");
    expect(d.content).toContain("a.md");
    expect(d.content).toContain("b.md");
  });

  it("rewrite falls back to candidate when LLM output lacks frontmatter", async () => {
    const d = await mergePage(OLD, CAND, fakeLlm(["no frontmatter here"]));
    expect(d.action).toBe("write");
    expect(d.content).toContain("new candidate body");
    // sources union preserved
    expect(d.content).toContain("a.md");
    expect(d.content).toContain("b.md");
  });

  it("rewrite falls back to candidate when LLM returns empty", async () => {
    const d = await mergePage(OLD, CAND, fakeLlm([""]));
    expect(d.action).toBe("write");
    expect(d.content).toContain("new candidate body");
  });

  it("large page append mode: empty fragment keeps old body, updates sources", async () => {
    const bigOld = `---
type: entity
sources: ["a.md"]
---

${"x".repeat(DEFAULT_FULL_REWRITE_MAX_CHARS + 100)}
`;
    const d = await mergePage(bigOld, CAND, fakeLlm([""]));
    expect(d.action).toBe("write");
    expect(d.content).not.toContain("new candidate body");
    expect(d.content).toContain("a.md");
    expect(d.content).toContain("b.md");
    expect(d.content).toContain("x".repeat(100));
  });

  it("large page append mode: appends fragment when LLM returns additions", async () => {
    const bigOld = `---
type: entity
sources: ["a.md"]
---

${"x".repeat(DEFAULT_FULL_REWRITE_MAX_CHARS + 100)}
`;
    const d = await mergePage(bigOld, CAND, fakeLlm(["  **new info**  "]));
    expect(d.action).toBe("write");
    expect(d.content).toContain("**new info**");
    expect(d.content).toContain("b.md");
  });
});