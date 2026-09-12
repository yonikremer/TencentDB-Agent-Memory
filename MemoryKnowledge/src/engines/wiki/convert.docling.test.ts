import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertSourceFile, getDoclingUrl, probeDocling } from "./convert.js";
// Integration: starts docling-serve in docker when not already up.
// No docker/daemon -> tests skip with a clear message (unit file still covers routing).
const here = dirname(fileURLToPath(import.meta.url));
const fix = (n: string) => readFileSync(join(here, "fixtures", n));
const IMAGE =
  process.env.DOCLING_TEST_IMAGE ??
  "quay.io/docling-project/docling-serve:latest";
const NAME = "ks-docling-test";
let started = false;
let state: "up" | "unavailable" = "unavailable";
function sh(args: string[], timeout = 120000): string {
  return execFileSync("docker", args, {
    encoding: "utf-8",
    timeout,
  }).toString();
}
async function ensureDocling(url: string): Promise<"up" | "unavailable"> {
  if (await probeDocling(url, 1500)) return "up";
  try {
    sh(["info"]);
  } catch {
    console.warn("[docling-it] docker daemon unavailable, skipping");
    return "unavailable";
  }
  try {
    sh(["pull", IMAGE], 1800000);
    sh([
      "run",
      "-d",
      "--rm",
      "--name",
      NAME,
      "-p",
      "127.0.0.1:5001:5001",
      IMAGE,
    ]);
    started = true;
  } catch (e) {
    console.warn(
      "[docling-it] docker run failed, skipping: " + String(e).slice(0, 200),
    );
    return "unavailable";
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 8 * 60 * 1000) {
    if (await probeDocling(url, 2000)) return "up";
    await new Promise((r) => setTimeout(r, 5000));
  }
  return "unavailable";
}
beforeAll(async () => {
  state = await ensureDocling(getDoclingUrl());
}, 1800000);
afterAll(() => {
  if (started) {
    try {
      sh(["stop", NAME]);
    } catch {
      /* already gone */
    }
    started = false;
  }
}, 60000);
describe("docling integration", () => {
  it("hebrew pdf -> md with Hebrew chars", async () => {
    if (state !== "up") return;
    const md = await convertSourceFile(
      fix("hebrew-weapon.pdf"),
      "hebrew-weapon.pdf",
      { doclingUrl: getDoclingUrl() },
    );
    expect(md.length).toBeGreaterThan(100);
    expect(/[\u0590-\u05FF]/.test(md)).toBe(true);
  }, 320000);
  it("office binaries -> md", async () => {
    if (state !== "up") return;
    for (const n of ["hebrew-weapon.docx", "sample.xlsx", "sample.pptx"]) {
      const md = await convertSourceFile(fix(n), n, {
        doclingUrl: getDoclingUrl(),
      });
      expect(md.length).toBeGreaterThan(0);
    }
  }, 320000);
});
