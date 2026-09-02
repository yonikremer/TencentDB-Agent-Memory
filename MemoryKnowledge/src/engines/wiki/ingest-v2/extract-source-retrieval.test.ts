/**
 * extract-source-retrieval.test.ts — 逐块检索增强（per-chunk retrieval）回归测试。
 *
 * 验证 extractSource 对每个源分块分别调用注入的 retrieveContext（而非整文件一次、
 * 所有块共用同一上下文）。用 mock LLM 返回固定 FILE 块，不发起真实 LLM 调用。
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { extractSource, SOURCE_CHAR_BUDGET } from "./index.js";
import { chunkText } from "./chunker.js";
import type { LlmClient } from "./llm.js";

/** 固定的合法 FILE 块，供 mock LLM 返回（type+title → 规范化路径）。 */
const FILE_BLOCK = `<<<FILE path="wiki/concepts/cache.md">>>
---
type: concept
title: Cache
---
mock body
<<<END>>>
`;

/** 记录 chat 调用（prompt 用于断言上下文是否注入）。 */
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
  it("短源（单块）：retrieveContext 只调用一次，参数为整份文本", async () => {
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
    // 上下文已注入每个（此处唯一的）chunk 的生成 prompt
    expect(chatCalls.length).toBeGreaterThan(0);
    expect(chatCalls[0].prompt).toContain("MARKER_RELEVANT_CONTEXT");
  });

  it("长源（多块）：retrieveContext 按块各调用一次，参数依次为各分块", async () => {
    // ~42k 字符的无标题长文 → chunkText 按 SOURCE_CHAR_BUDGET 硬切成 2 块
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

    // 关键回归断言：每个分块各检索一次，且参数与 extractSource 内部切分一致
    expect(retrieved.length).toBe(expectedChunks.length);
    expect(retrieved).toEqual(expectedChunks);
    // 每个 chunk 的 prompt 都带上了它自己的检索上下文标记
    expect(chatCalls.length).toBe(expectedChunks.length);
    chatCalls.forEach((c, i) => {
      expect(c.prompt).toContain(`MARKER_${i + 1}`);
    });
  });
});
