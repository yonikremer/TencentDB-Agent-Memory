import { describe, expect, it } from "vitest";
import { extractLastUserText } from "../user-text-extractor.js";

describe("extractLastUserText", () => {
  it("returns string content as-is", () => {
    expect(extractLastUserText("plain")).toBe("plain");
    expect(extractLastUserText("")).toBe("");
  });

  it("returns null for non-string non-array", () => {
    expect(extractLastUserText(null)).toBeNull();
    expect(extractLastUserText(42)).toBeNull();
    expect(extractLastUserText(undefined)).toBeNull();
  });

  it("scans back to front for the last text block", () => {
    const content = [
      { type: "text", text: "<system-reminder>meta</system-reminder>" },
      { type: "tool_result", content: "result" },
      { type: "text", text: "<local-command>cap</local-command>" },
      { type: "image", source: {} },
    ];
    expect(extractLastUserText(content)).toBe("<local-command>cap</local-command>");
  });

  it("skips non-object / wrong-type blocks", () => {
    expect(extractLastUserText(["str", null, { type: "tool_result" }])).toBeNull();
    expect(extractLastUserText([{ type: "text" }, { type: "text", text: 5 }])).toBeNull();
    expect(extractLastUserText([])).toBeNull();
  });
});