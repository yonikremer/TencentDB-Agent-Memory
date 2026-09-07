/**
 * Org-hierarchy-sync P1 — GROUPY_* env parsing tests (TDD). DESIGN.md §4.3.
 */
import { describe, it, expect } from "vitest";
import { parseGroupyConfig } from "./sync-config.js";

describe("parseGroupyConfig", () => {
  it("defaults to disabled with empty roots", () => {
    const cfg = parseGroupyConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.roots).toEqual([]);
    expect(cfg.cron).toBe("0 2 * * *");
  });

  it("parses full env", () => {
    const cfg = parseGroupyConfig({
      GROUPY_ENABLED: "true",
      GROUPY_BASE_URL: "https://groupy.corp",
      GROUPY_TOKEN: "sekret",
      GROUPY_ROOTS: "product_x, 120data_branch,,",
      GROUPY_CRON: "0 3 * * *",
      GROUPY_MOCK_FILE: "/tmp/f.json",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.baseUrl).toBe("https://groupy.corp");
    expect(cfg.token).toBe("sekret");
    expect(cfg.roots).toEqual(["product_x", "120data_branch"]);
    expect(cfg.cron).toBe("0 3 * * *");
    expect(cfg.mockFile).toBe("/tmp/f.json");
  });

  it("only exact 'true' enables", () => {
    expect(parseGroupyConfig({ GROUPY_ENABLED: "1" }).enabled).toBe(false);
    expect(parseGroupyConfig({ GROUPY_ENABLED: "TRUE" }).enabled).toBe(false);
  });
});
