/**
 * Org-hierarchy-sync — HTTP adapter guard tests (security review).
 */
import { describe, it, expect } from "vitest";
import { HttpGroupyClient, normalizeGroupyNode, MAX_NODE_MEMBERS } from "./http-groupy-client.js";

describe("HttpGroupyClient", () => {
  it("rejects non-http(s) base urls (SSRF guard)", () => {
    expect(() => new HttpGroupyClient("file:///etc", "t")).toThrow("must start with http");
    expect(() => new HttpGroupyClient("http://groupy.corp", "t")).not.toThrow();
  });

  it("normalize caps members per node", () => {
    const members = Array.from({ length: MAX_NODE_MEMBERS + 1 }, (_, i) => ({ id: `u${i}`, kind: "user" }));
    expect(() => normalizeGroupyNode({ id: "n", members })).toThrow("exceed");
    const ok = normalizeGroupyNode({ id: "n", displayName: "D", members: [{ id: "u1", kind: "user" }] });
    expect(ok.display_name).toBe("D");
  });
});
