import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  convertSourceFile,
  extOf,
  getRawLimits,
  probeDocling,
  renderLocal,
  routeFor,
  saveSourceFile,
} from "./convert.js";
const here = dirname(fileURLToPath(import.meta.url));
const fix = (n: string) => readFileSync(join(here, "fixtures", n));
const magic = (b: Buffer) => b.subarray(0, 4).toString("hex");
describe("convert routing", () => {
  it("routes docling set", () => {
    for (const f of ["a.pdf", "a.docx", "a.pptx", "a.xlsx"])
      expect(routeFor(f)).toBe("docling");
    for (const f of ["a.doc", "a.xls", "a.msg"])
      expect(routeFor(f)).toBe("local");
  });
  it("passes md, locals render, defers vsdx", () => {
    expect(routeFor("a.md")).toBe("passthrough");
    expect(routeFor("a.txt")).toBe("local");
    expect(routeFor("a.csv")).toBe("local");
    expect(routeFor("a.html")).toBe("local");
    expect(routeFor("a.eml")).toBe("local");
    expect(routeFor("a.msg")).toBe("local");
    expect(routeFor("a.vsdx")).toBe("local");
    expect(routeFor("a.exe")).toBe("unsupported");
  });
  it("unsupported throws 415", async () => {
    for (const f of ["a.exe"]) {
      const err = await convertSourceFile(new Uint8Array([1]), f).catch(
        (e) => e,
      );
      expect(err?.statusCode).toBe(415);
    }
  });
  it("probe false on closed port", async () => {
    expect(await probeDocling("http://127.0.0.1:1", 300)).toBe(false);
  });
  it("eml strips headers, html strips tags", () => {
    expect(renderLocal(".eml", "From: x\n\nhello")).toContain("hello");
    expect(renderLocal(".html", "<p>hi</p>")).toContain("hi");
  });
  it("raw limits default 100MB/50GB", () => {
    expect(getRawLimits({} as any)).toEqual({
      perFile: 104857600,
      total: 53687091200,
    });
    expect(extOf("A.PDF")).toBe(".pdf");
  });
});
describe("convert fixtures (no network)", () => {
  it("md passthrough identity, locals render", async () => {
    const md = fix("sample.md");
    expect(await convertSourceFile(md, "sample.md")).toBe(md.toString("utf-8"));
    const txt = await convertSourceFile(fix("sample.txt"), "sample.txt");
    expect(txt).toContain("hello txt");
    const csv = await convertSourceFile(fix("sample.csv"), "sample.csv");
    expect(csv).toContain("Alice");
    const html = await convertSourceFile(fix("sample.html"), "sample.html");
    expect(html).toContain("Title");
    expect(html).not.toContain("<p>");
    const eml = await convertSourceFile(fix("sample.eml"), "sample.eml");
    expect(eml).toContain("Body line one");
    expect(eml).not.toContain("Subject:");
  });
  it("binary fixtures are real (magic + routing + size)", async () => {
    const { perFile } = getRawLimits({} as any);
    const pdf = fix("hebrew-weapon.pdf");
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(routeFor("hebrew-weapon.pdf")).toBe("docling");
    for (const n of ["hebrew-weapon.docx", "sample.xlsx", "sample.pptx"]) {
      const b = fix(n);
      expect(magic(b)).toBe("504b0304");
      expect(b.length).toBeLessThan(perFile);
    }
    expect(routeFor("hebrew-weapon.docx")).toBe("docling");
    expect(routeFor("sample.xlsx")).toBe("docling");
    expect(routeFor("sample.pptx")).toBe("docling");
    const xls = fix("sample.xls");
    expect(magic(xls)).toBe("d0cf11e0");
    expect(routeFor("sample.xls")).toBe("local");
    expect(await convertSourceFile(xls, "sample.xls")).toContain("Alice");
    const doc = fix("sample-real.doc");
    expect(magic(doc)).toBe("d0cf11e0");
    expect(doc.length).toBeGreaterThan(50000);
    expect(routeFor("sample-real.doc")).toBe("local");
    expect(await convertSourceFile(doc, "sample-real.doc")).toContain(
      "Lorem ipsum",
    );
    const rxls = fix("sample-real.xls");
    expect(magic(rxls)).toBe("d0cf11e0");
    expect(routeFor("sample-real.xls")).toBe("local");
    expect(await convertSourceFile(rxls, "sample-real.xls")).toContain("##");
    const msg = fix("sample-real.msg");
    expect(magic(msg)).toBe("d0cf11e0");
    expect(routeFor("sample-real.msg")).toBe("local");
    const msgMd = await convertSourceFile(msg, "sample-real.msg");
    expect(msgMd).toContain("creating an outlook message file");
    expect(msgMd).toContain("from@domain.com");
    const vsdx = fix("sample.vsdx");
    expect(magic(vsdx)).toBe("504b0304");
    expect(routeFor("sample.vsdx")).toBe("local");
  });
});
describe("visio to markdown (port of fuadmefleh/visio_to_markdown)", () => {
  it("sanitizes mermaid ids like the lib", async () => {
    const { sanitizeMermaidId } = await import("./vsdx.js");
    expect(sanitizeMermaidId("Hello World")).toBe("Hello_World");
    expect(sanitizeMermaidId("Test-123!@#$%")).toBe("Test_123_____");
    expect(sanitizeMermaidId("A".repeat(100)).length).toBe(50);
    expect(sanitizeMermaidId("", "123")).toBe("shape_123");
    expect(sanitizeMermaidId("")).toBe("unknown");
  });
  it("tiny sample renders text plus edge", async () => {
    const md = await convertSourceFile(fix("sample.vsdx"), "sample.vsdx");
    expect(md).toContain("hello vsdx");
    expect(md).toContain("```mermaid");
    expect(md).toContain(`hello_vsdx["hello vsdx"]`);
    expect(md).toContain("%% Hierarchical structure (inferred)");
  });
  it("real ECommerce file renders shapes and connections", async () => {
    const md = await convertSourceFile(
      fix("ECommerceTestFile.vsdx"),
      "ECommerceTestFile.vsdx",
    );
    expect(md).toContain("```mermaid");
    expect(md).toContain("E-Commerce");
    expect(md).toContain("%% Hierarchical structure (inferred)");
  });
});
describe("renderer edge cases", () => {
  it("html drops scripts/styles, decodes entities", async () => {
    const md = await convertSourceFile(
      Buffer.from(
        "<html><head><style>p{x}</style><script>alert(1)</script></head><body><p>a&nbsp;&amp;&nbsp;b</p></body></html>",
      ),
      "x.html",
    );
    expect(md).not.toContain("<script");
    expect(md).not.toContain("alert");
    expect(md).not.toContain("<style");
    expect(md).toContain("a & b");
  });
  it("msg keeps subject/sender/body", async () => {
    const md = await convertSourceFile(
      fix("sample-real.msg"),
      "sample-real.msg",
    );
    expect(md.startsWith("# creating an outlook message file")).toBe(true);
    expect(md).toContain("Aspose");
  });
});
describe("saveSourceFile quota teeth (S3)", () => {
  it("saves bytes with sha, rejects over limits and bad exts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raw-"));
    const bytes = Buffer.from("hello raw");
    const saved = await saveSourceFile(dir, "a.pdf", bytes);
    expect(saved.size).toBe(bytes.length);
    expect(saved.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(saved.rawPath).toString()).toBe("hello raw");
    const big = await saveSourceFile(dir, "b.pdf", bytes, {
      perFile: 4,
      total: 1 << 20,
    }).catch((e) => e);
    expect(big?.statusCode).toBe(413);
    const dir2 = mkdtempSync(join(tmpdir(), "rawq-"));
    await saveSourceFile(dir2, "c.pdf", bytes, {
      perFile: 1 << 20,
      total: bytes.length,
    });
    const over = await saveSourceFile(dir2, "d.pdf", bytes, {
      perFile: 1 << 20,
      total: bytes.length,
    }).catch((e) => e);
    expect(over?.statusCode).toBe(413);
    const bad = await saveSourceFile(dir, "e.exe", bytes).catch((e) => e);
    expect(bad?.statusCode).toBe(415);
    const trav = await saveSourceFile(dir, "../evil.txt", bytes);
    expect(trav.rawPath.startsWith(dir)).toBe(true);
  });
});
describe.skip("convert live bench (moved to convert.docling.test.ts)", () => {
  it("hebrew pdf -> md with Hebrew chars", async () => {
    const url = getDoclingUrl();
    if (!(await probeDocling(url, 1500))) return;
    const md = await convertSourceFile(
      fix("hebrew-weapon.pdf"),
      "hebrew-weapon.pdf",
      { doclingUrl: url },
    );
    expect(md.length).toBeGreaterThan(100);
    expect(/[\u0590-\u05FF]/.test(md)).toBe(true);
  }, 320000);
  it("office binaries -> md", async () => {
    const url = getDoclingUrl();
    if (!(await probeDocling(url, 1500))) return;
    for (const n of [
      "hebrew-weapon.docx",
      "sample.xlsx",
      "sample.pptx",
      "sample.xls",
      "sample-real.doc",
      "sample-real.xls",
    ]) {
      const md = await convertSourceFile(fix(n), n, { doclingUrl: url });
      expect(md.length).toBeGreaterThan(0);
    }
  }, 320000);
});
