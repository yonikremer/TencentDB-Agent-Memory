import { describe, it, expect } from "vitest";
import * as root from "../src/index.js";
import * as v3 from "../src/v3/index.js";

describe("package exports", () => {
  it("root index re-exports v3 runtime classes", () => {
    expect(root.MemoryClient).toBeTypeOf("function");
    expect(root.MemoryPromptClient).toBeTypeOf("function");
    expect(root.MemoryGenerationLogClient).toBeTypeOf("function");
    expect(root.SkillClient).toBeTypeOf("function");
    expect(root.MetadataClient).toBeTypeOf("function");
    expect(root.HttpTransport).toBeTypeOf("function");
    expect(root.ParamError).toBeTypeOf("function");
    expect(root.TDAMError).toBeTypeOf("function");
    expect(root.MemoryFileReader).toBeTypeOf("function");
    expect(root.StsCredentialManager).toBeTypeOf("function");
    expect(root.StsCredential).toBeTypeOf("function");
    expect(root.createMemoryFileReader).toBeTypeOf("function");
    expect(root.cosV5Sign).toBeTypeOf("function");
    expect(root.SkillErrorCode.NOT_FOUND).toBe(40401);
  });

  it("v3 subpath exports match root", () => {
    expect(v3.MemoryClient).toBe(root.MemoryClient);
    expect(v3.SkillClient).toBe(root.SkillClient);
  });
});