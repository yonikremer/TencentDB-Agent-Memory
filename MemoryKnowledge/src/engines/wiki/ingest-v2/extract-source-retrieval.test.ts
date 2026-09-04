/**
 * extract-source-retrieval.test.ts — Regression tests for per-chunk retrieval augmentation.
 *
 * Verifies that extractSource calls the injected retrieveContext separately for each source chunk (rather than once
 * for the entire file with all chunks sharing identical context). Uses mock LLM returning fixed FILE block without making real LLM calls.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { extractSource, SOURCE_CHAR_BUDGET } from "./index.js";
import { chunkText } from "./chunker.js";
import type { LlmClient } from "./llm.js";

/** Fixed valid FILE block returned by mock LLM (type+title → normalized path). */
const FILE_BLOCK = `<<<FILE path="wiki/concepts/cache.md">>>
---
type: concept
title: Cache
---
mock body
<<<END>>>
`;

/** Records chat invocations (prompt used to assert whether context is injected). */
type ChatCall = { prompt: string };
function makeMockLlm(calls: ChatCall[]): LlmClient {
  return {
    config: {} as never,
    chat: async (p) => {
      calls.push({ prompt: p.prompt });
      return FILE_BLOCK;
    },
  } as unknown as LlmClient;
}

const tmpDirs: string[] = [];
function makeProjectAndSource(sourceText: string): { projectPath: string; sourcePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "extract-retrieval-"));
  tmpDirs.push(dir);
  const projectPath = join(dir, "project");
  const sourcePath = join(dir, "src.md");
  writeFileSync(sourcePath, sourceText, "utf-8");
  return { projectPath, sourcePath };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("extractSource per-chunk retrieval", () => {
  it("Short source (single chunk): retrieveContext is called only once, with the full text as argument", async () => {
    const text = "This is a short single-chunk source about cache eviction.";
    const { projectPath, sourcePath } = makeProjectAndSource(text);

    const retrieved: string[] = [];
    const chatCalls: ChatCall[] = [];
    const llm = makeMockLlm(chatCalls);
    const retrieveContext = (chunkText: string) => {
      retrieved.push(chunkText);
      return "MARKER_RELEVANT_CONTEXT";
    };

    await extractSource(projectPath, sourcePath, {}, [], {
      mode: "single-stage",
      llm,
      retrieveContext,
    });

    expect(retrieved).toEqual([text]);
    // Context is injected into the generation prompt of each (here single) chunk
    expect(chatCalls.length).toBeGreaterThan(0);
    expect(chatCalls[0].prompt).toContain("MARKER_RELEVANT_CONTEXT");
  });

  it("Long source (multiple chunks): retrieveContext is called once per chunk, with chunk text sequentially as arguments", async () => {
    // ~42k character headingless long text → chunkText hard-splits into 2 chunks by SOURCE_CHAR_BUDGET
    const text = `# Long doc\n\n${"cache block eviction policy ".repeat(2100)}`;
    expect(text.length).toBeGreaterThan(SOURCE_CHAR_BUDGET);
    const expectedChunks = chunkText(text, { targetChars: SOURCE_CHAR_BUDGET });
    expect(expectedChunks.length).toBeGreaterThan(1);

    const { projectPath, sourcePath } = makeProjectAndSource(text);

    const retrieved: string[] = [];
    const chatCalls: ChatCall[] = [];
    const llm = makeMockLlm(chatCalls);
    const retrieveContext = (chunkText: string) => {
      retrieved.push(chunkText);
      return `MARKER_${retrieved.length}`;
    };

    await extractSource(projectPath, sourcePath, {}, [], {
      mode: "single-stage",
      llm,
      retrieveContext,
    });

    // Critical regression assertion: retrieved once per chunk, arguments matching internal splitting of extractSource
    expect(retrieved.length).toBe(expectedChunks.length);
    expect(retrieved).toEqual(expectedChunks);
    // Each chunk prompt carries its own retrieval context marker
    expect(chatCalls.length).toBe(expectedChunks.length);
    chatCalls.forEach((c, i) => {
      expect(c.prompt).toContain(`MARKER_${i + 1}`);
    });
  });
});
