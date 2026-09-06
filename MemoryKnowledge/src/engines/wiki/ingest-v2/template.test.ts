import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTemplate, DEFAULT_PURPOSE, DEFAULT_SCHEMA } from "./template.js";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function project(): string {
  dir = mkdtempSync(join(tmpdir(), "mk-tpl-"));
  mkdirSync(join(dir, "wiki"), { recursive: true });
  return dir;
}

describe("loadTemplate", () => {
  it("uses defaults when template files missing", () => {
    const t = loadTemplate(project());
    expect(t.purpose).toBe(DEFAULT_PURPOSE);
    expect(t.schema).toBe(DEFAULT_SCHEMA);
    expect(t.customized).toBe(false);
  });

  it("uses meaningful user content with frontmatter stripped", () => {
    const p = project();
    writeFileSync(join(p, "wiki", "purpose.md"), "---\ntitle: P\n---\n# Purpose\nWe track distributed systems knowledge here.", "utf-8");
    const t = loadTemplate(p);
    expect(t.purpose).toContain("distributed systems");
    expect(t.purpose).not.toContain("---");
    expect(t.customized).toBe(true);
  });

  it("falls back to default for shell-only content", () => {
    const p = project();
    writeFileSync(join(p, "wiki", "schema.md"), "# Wiki Schema\n\nDefine your schema here.", "utf-8");
    const t = loadTemplate(p);
    expect(t.schema).toBe(DEFAULT_SCHEMA);
    expect(t.customized).toBe(false);
  });

  it("falls back when file unreadable (directory as file)", () => {
    const p = project();
    mkdirSync(join(p, "wiki", "purpose.md"), { recursive: true });
    const t = loadTemplate(p);
    expect(t.purpose).toBe(DEFAULT_PURPOSE);
  });

  it("uses schema custom with purpose default", () => {
    const p = project();
    writeFileSync(join(p, "wiki", "schema.md"), "---\n---\n# Schema\nReal schema content here with detail.", "utf-8");
    const t = loadTemplate(p);
    expect(t.schema).toContain("Real schema content");
    expect(t.purpose).toBe(DEFAULT_PURPOSE);
    expect(t.customized).toBe(true);
  });
});