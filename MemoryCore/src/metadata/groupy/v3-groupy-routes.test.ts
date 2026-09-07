/**
 * Org-hierarchy-sync P1 — route registration (PLAN P1 acceptance 5).
 */
import { describe, it, expect } from "vitest";
import { V3_ROUTES } from "../router/v3-meta-router.js";
import { V3_SCHEMAS } from "../router/v3-meta-schemas.js";

describe("groupy routes", () => {
  it("registers /v3/meta/groupy/{sync,status,tree,summary}", () => {
    for (const p of ["sync", "status", "tree", "summary"]) {
      expect(V3_ROUTES).toContain(`/v3/meta/groupy/${p}`);
      expect(V3_SCHEMAS[`/v3/meta/groupy/${p}` as keyof typeof V3_SCHEMAS]).toBeDefined();
    }
  });
});
