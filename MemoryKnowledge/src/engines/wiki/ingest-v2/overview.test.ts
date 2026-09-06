import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateOverview } from "./overview.js";
import type { LlmClient } from "./llm.js";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function project(): string {
  dir = mkdtempSync(join(tmpdir(), "mk-ov-"));
  mkdirSync(join(dir, "wiki"), { recursive: true });
  return dir;
}

function page(type: string, title: string, description: string): string {
  return `---\ntype: ${type}\ntitle: ${title}\ndescription: ${description}\n---\n\nbody`;
}

function fakeLlm(body: string): LlmClient {
  return {
    config: { protocol: "openai", baseUrl: "", apiKey: "", model: "m", maxTokens: 100, timeoutMs: 1000, stream: false },
    chat: async () => body,
  };
}

describe("generateOverview", () => {
  it("skips when fewer than 2 pages", async () => {
    const p = project();
    mkdirSync(join(p, "wiki", "entities"), { recursive: true });
    writeFileSync(join(p, "wiki", "entities", "a.md"), page("entity", "A", "d"), "utf-8");
    expect(await generateOverview(p, fakeLlm(""))).toBe(false);
  });

  it("writes overview.md from llm body", async () => {
    const p = project();
    mkdirSync(join(p, "wiki", "entities"), { recursive: true });
    mkdirSync(join(p, "wiki", "concepts"), { recursive: true });
    writeFileSync(join(p, "wiki", "entities", "a.md"), page("entity", "Redis", "cache"), "utf-8");
    writeFileSync(join(p, "wiki", "concepts", "b.md"), page("concept", "Hashing", "hash"), "utf-8");
    // structural files are excluded from briefs
    writeFileSync(join(p, "wiki", "index.md"), page("index", "Index", "idx"), "utf-8");
    writeFileSync(join(p, "wiki", "schema.md"), page("schema", "Schema", "sch"), "utf-8");
    writeFileSync(join(p, "wiki", "purpose.md"), page("purpose", "Purpose", "pur"), "utf-8");
    writeFileSync(join(p, "wiki", "log.md"), page("log", "Log", "logf"), "utf-8");
    writeFileSync(join(p, "wiki", "overview.md"), page("overview", "Overview", "old"), "utf-8");
    writeFileSync(join(p, "wiki", "notes.txt"), "not md", "utf-8");
    expect(await generateOverview(p, fakeLlm("  # Overview Body\n\nnarrative  "))).toBe(true);
    const content = require("node:fs").readFileSync(join(p, "wiki", "overview.md"), "utf-8");
    expect(content).toContain("narrative");
    expect(content).toContain("type: overview");
  });

  it("skips writing when llm returns empty body", async () => {
    const p = project();
    mkdirSync(join(p, "wiki", "entities"), { recursive: true });
    mkdirSync(join(p, "wiki", "concepts"), { recursive: true });
    writeFileSync(join(p, "wiki", "entities", "a.md"), page("entity", "A", "d1"), "utf-8");
    writeFileSync(join(p, "wiki", "concepts", "b.md"), page("concept", "B", "d2"), "utf-8");
    expect(await generateOverview(p, fakeLlm("   "))).toBe(false);
  });

  it("does not fail when wiki dir missing", async () => {
    const p = project();
    expect(await generateOverview(p, fakeLlm("x"))).toBe(false);
  });
});