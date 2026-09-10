import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../config.js";
import { createStoreBundle } from "./factory.js";
import { resolveSkillConfig } from "../skill/skill-config.js";
import { buildStoreInfo, diffStoreBinding } from "../../utils/manifest.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("tcvdb removed — sqlite only", () => {
  it("parseConfig forces sqlite even with legacy tcvdb input", () => {
    const cfg = parseConfig({
      storeBackend: "tcvdb",
      tcvdb: { database: "x" },
    });
    expect(cfg.storeBackend).toBe("sqlite");
  });

  it("createStoreBundle degrades legacy tcvdb to sqlite with warn", () => {
    const cfg = parseConfig({});
    (cfg as unknown as { storeBackend: string }).storeBackend = "tcvdb";
    const dir = mkdtempSync(join(tmpdir(), "tdai-sqlite-only-"));
    const bundle = createStoreBundle(cfg, { dataDir: dir, logger });
    expect(bundle.storeSnapshot.type).toBe("sqlite");
    expect(logger.warn).toHaveBeenCalled();
    void bundle.store.close?.();
  });

  it("resolveSkillConfig degrades legacy tcvdb to sqlite", () => {
    const resolved = resolveSkillConfig(
      { enabled: true, storeBackend: "tcvdb" as unknown as "sqlite" },
      {
        outerStoreBackend: "sqlite",
        hasCosCredentials: false,
        embeddingAvailable: false,
        llmRunnerAvailable: false,
      },
      logger,
    );
    expect(resolved?.storeBackend).toBe("sqlite");
    expect(resolved?.degradations.some((d) => d.field === "storeBackend")).toBe(
      true,
    );
  });

  it("manifest is sqlite-only", () => {
    const info = buildStoreInfo({ type: "sqlite", sqlitePath: "vectors.db" });
    expect(info.type).toBe("sqlite");
    expect(diffStoreBinding(info, info)).toEqual([]);
  });
});
