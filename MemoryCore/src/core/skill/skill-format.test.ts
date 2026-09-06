/**
 * skill-format.test.ts — guide section 3.5 contract: skill/create accepts
 * only SKILL.md text starting with frontmatter carrying name+description.
 * Pure unit test (no SkillCore/storage needed).
 */
import { describe, it, expect } from "vitest";
import { parseSkillFile, validateSkillFile } from "./skill-format.js";

const GOOD = "---\nname: lit-review\ndescription: How we do lit reviews.\n---\n\n# Lit review\n\n1. Search wiki first.\n";

describe("guide 3.5: skill frontmatter contract", () => {
  it("parses valid SKILL.md with name+description", () => {
    const f = parseSkillFile(GOOD);
    expect(f.frontmatter.name).toBe("lit-review");
    expect(f.frontmatter.description).toContain("lit reviews");
    expect(() => validateSkillFile(f)).not.toThrow();
  });

  it("rejects content without frontmatter (guide: 42203)", () => {
    expect(() => parseSkillFile("# No frontmatter\n\nBody.\n")).toThrow(/frontmatter/);
  });

  it("rejects missing name / missing description", () => {
    expect(() => parseSkillFile("---\ndescription: d\n---\n\nbody\n")).toThrow(/name/);
    expect(() => parseSkillFile("---\nname: x\n---\n\nbody\n")).toThrow(/description/);
  });

  it("rejects names outside ^[a-z0-9][a-z0-9-]*$ and >64 chars", () => {
    expect(() => validateSkillFile(parseSkillFile(GOOD.replace("lit-review", "Bad_Name")))).toThrow(/invalid name/);
    expect(() => validateSkillFile(parseSkillFile(GOOD.replace("lit-review", "a".repeat(65))))).toThrow(/exceeds max/);
  });
});
