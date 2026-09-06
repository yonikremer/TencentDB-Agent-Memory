import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countHumanTurns } from "../turnSeq.js";

describe("countHumanTurns", () => {
  it("counts anthropic human turns (string content not starting with system-reminder)", () => {
    expect(countHumanTurns([
      { role: "user", content: "hello" },
      { role: "user", content: "<system-reminder>meta</system-reminder>" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ], "anthropic")).toBe(2);
  });

  it("counts array content blocks with any real text block", () => {
    expect(countHumanTurns([
      { role: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }, { type: "text", text: "real" }] },
      { role: "user", content: [{ type: "tool_result", content: "r" }] },
    ], "anthropic")).toBe(1);
  });

  it("handles empty / non-object messages", () => {
    expect(countHumanTurns([], "openai")).toBe(0);
    expect(countHumanTurns([null, { role: "system" }, 42], "openai")).toBe(0);
  });

  it("treats pure tool_result / image-only content as tool loop", () => {
    expect(countHumanTurns([
      { role: "user", content: [{ type: "tool_result", content: "r" }] },
      { role: "user", content: 42 },
    ], "anthropic")).toBe(0);
  });

  it("openai protocol same counting", () => {
    expect(countHumanTurns([
      { role: "user", content: "q1" },
      { role: "tool", content: "t" },
      { role: "user", content: "<system-reminder>x</system-reminder>" },
    ], "openai")).toBe(1);
  });
});