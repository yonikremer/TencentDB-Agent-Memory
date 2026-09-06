import { describe, it, expect } from "vitest";
import { chunkText, estimateTokens } from "./chunker.js";

describe("chunkText", () => {
  it("returns [] for empty/whitespace/null", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   ")).toEqual([]);
    expect(chunkText(null as unknown as string)).toEqual([]);
  });

  it("returns single chunk when below target", () => {
    expect(chunkText("hello world")).toEqual(["hello world"]);
  });

  it("splits large text into sections across chunks with overlap", () => {
    const big = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n${"x".repeat(80)}`).join("\n\n");
    const chunks = chunkText(big, { targetChars: 1000, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThan(2);
    // Each chunk carries some content; whole text reconstructable-ish (overlap allowed)
    expect(chunks.join("").length).toBeGreaterThan(big.length);
  });

  it("hard-splits oversized paragraphs", () => {
    const big = "a".repeat(3000);
    const chunks = chunkText(big, { targetChars: 1000, overlapChars: 100 });
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(1000);
  });

  it("clamps target and overlap", () => {
    const big = "b".repeat(5000);
    const chunks = chunkText(big, { targetChars: 10, overlapChars: 99999 });
    // target clamped up to 1000, overlap up to floor(target/2)=500
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(1505);
  });
});

describe("estimateTokens", () => {
  it("estimates len/3 rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens(null as unknown as string)).toBe(0);
  });
});