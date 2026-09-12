import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getSourceForMd,
  initIndexDb,
  recordSourceLink,
  withWriteDb,
} from "./index-db.js";
describe("source_link md->raw (S4)", () => {
  it("records and resolves ties, upserts on re-render", () => {
    const dir = mkdtempSync(join(tmpdir(), "idx-"));
    initIndexDb(dir);
    withWriteDb(dir, (db) =>
      recordSourceLink(db, "wiki/a.md", "a.pdf", "sha1"),
    );
    withWriteDb(dir, (db) => {
      expect(getSourceForMd(db, "wiki/a.md")).toEqual({
        filename: "a.pdf",
        sha256: "sha1",
      });
      expect(getSourceForMd(db, "wiki/missing.md")).toBeUndefined();
      recordSourceLink(db, "wiki/a.md", "a-v2.pdf", "sha2");
    });
    withWriteDb(dir, (db) => {
      expect(getSourceForMd(db, "wiki/a.md")).toEqual({
        filename: "a-v2.pdf",
        sha256: "sha2",
      });
    });
  });
});
