import { describe, expect, it } from "vitest";
import { buildWorkbuddyInjectionBlock, type WorkbuddyInjectionInput } from "../workbuddy-injection.js";

describe("buildWorkbuddyInjectionBlock", () => {
  it("raw mode embeds text verbatim", () => {
    const block = buildWorkbuddyInjectionBlock({ raw: "<user_memory>x</user_memory>" });
    expect(block.type).toBe("input_text");
    expect(block.text).toBe("<tdai_injections>\n<user_memory>x</user_memory>\n</tdai_injections>");
  });

  it("raw mode with empty string produces empty wrapper", () => {
    expect(buildWorkbuddyInjectionBlock({ raw: "" }).text).toBe("<tdai_injections>\n</tdai_injections>");
    expect(buildWorkbuddyInjectionBlock({ raw: undefined as unknown as string }).text).toBe("<tdai_injections>\n</tdai_injections>");
  });

  it("structured mode renders segments with XML escaping, in order", () => {
    const block = buildWorkbuddyInjectionBlock({
      skills: "<b>",
      memory: "m",
      agents: "ag",
      tasks: "t",
      knowledge: "k",
    });
    expect(block.text).toContain("<available_skills>\n&lt;b&gt;\n</available_skills>");
    const pos = (s: string) => block.text.indexOf(s);
    expect(pos("<available_skills>")).toBeLessThan(pos("<user_memory>"));
    expect(pos("<user_memory>")).toBeLessThan(pos("<agents>"));
    expect(pos("<agents>")).toBeLessThan(pos("<tasks>"));
    expect(pos("<tasks>")).toBeLessThan(pos("<knowledge>"));
  });

  it("structured mode omits empty/undefined segments", () => {
    const block = buildWorkbuddyInjectionBlock({ knowledge: "only k" } as WorkbuddyInjectionInput);
    expect(block.text).toContain("<knowledge>");
    expect(block.text).not.toContain("<agents>");
  });

  it("structured mode with no content produces empty wrapper", () => {
    expect(buildWorkbuddyInjectionBlock({}).text).toBe("<tdai_injections>\n</tdai_injections>");
  });
});