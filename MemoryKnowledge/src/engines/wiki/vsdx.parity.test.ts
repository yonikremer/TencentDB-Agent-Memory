import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderVsdx } from "./vsdx.js";
const here = dirname(fileURLToPath(import.meta.url));
describe("vsdx byte parity with python lib", () => {
  it("ECommerce output matches lib exactly", async () => {
    const bytes = readFileSync(
      join(here, "fixtures", "ECommerceTestFile.vsdx"),
    );
    const golden = JSON.parse(
      readFileSync(
        join(here, "fixtures", "expected", "ECommerceTestFile.json"),
        "utf-8",
      ),
    ).markdown as string;
    expect(await renderVsdx(bytes, "ECommerceTestFile.vsdx")).toBe(golden);
  });
});
