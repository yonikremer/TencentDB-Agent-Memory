import { describe, expect, it } from "vitest";
import { buildCodexInjectionBlock, type CodexInjectionInput } from "../codex-injection.js";

describe("buildCodexInjectionBlock", () => {
  it("raw mode embeds text verbatim", () => {
    const block = buildCodexInjectionBlock({ raw: "<available_skills>a</available_skills>" });
    expect(block.type).toBe("input_text");
    expect(block.text).toBe("<tdai_injections>\n<available_skills>a</available_skills>\n</tdai_injections>");
  });

  it("raw mode with empty string produces empty wrapper", () => {
    expect(buildCodexInjectionBlock({ raw: "" }).text).toBe("<tdai_injections>\n</tdai_injections>");
    expect(buildCodexInjectionBlock({ raw: undefined as unknown as string }).text).toBe("<tdai_injections>\n</tdai_injections>");
  });

  it("structured mode renders segments in order with XML escaping", () => {
    const block = buildCodexInjectionBlock({
      skills: "<a> & \"'",
      memory: "m",
      agents: "ag",
      tasks: "t",
      knowledge: "k",
    });
    expect(block.text).toContain("<available_skills>\n&lt;a&gt; &amp; &quot;&apos;\n</available_skills>");
    expect(block.text.indexOf("<available_skills>")).toBeLessThan(block.text.indexOf("<user_memory>"));
    expect(block.text.indexOf("<user_memory>")).toBeLessThan(block.text.indexOf("<agents>"));
    expect(block.text.indexOf("<agents>")).toBeLessThan(block.text.indexOf("<tasks>"));
    expect(block.text.indexOf("<tasks>")).toBeLessThan(block.text.indexOf("<knowledge>"));
  });

  it("structured mode omits empty/undefined segments", () => {
    const block = buildCodexInjectionBlock({ memory: "only m" } as CodexInjectionInput);
    expect(block.text).toContain("<user_memory>");
    expect(block.text).not.toContain("<available_skills>");
    expect(block.text).not.toContain("<tasks>");
  });

  it("structured mode with no content produces empty wrapper", () => {
    expect(buildCodexInjectionBlock({}).text).toBe("<tdai_injections>\n</tdai_injections>");
  });
});