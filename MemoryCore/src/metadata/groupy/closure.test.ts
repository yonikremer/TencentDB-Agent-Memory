/**
 * Org-hierarchy-sync P1 — closure unit tests (TDD).
 * DESIGN.md §5 step 2: every person → full ancestor set (union over all parent chains).
 * Matrix fixture: 2 roots, nested groups, a person under two chains, a head person.
 */
import { describe, it, expect } from "vitest";
import { computeMembershipClosure, subtreeNodeIds } from "./closure.js";
import type { GroupyGraphSnapshot } from "./closure.js";

function fixture(): GroupyGraphSnapshot {
  return new Map([
    ["product_x", { id: "product_x", name: "Product X", display_name: "Product X", members: [
      { id: "123teamA", kind: "org" },
      { id: "123teamB", kind: "org" },
    ] }],
    ["120data_branch", { id: "120data_branch", name: "Data Branch", display_name: "Data Branch", members: [
      { id: "123teamA", kind: "org" },
      { id: "999head", kind: "user" },
    ] }],
    ["123teamA", { id: "123teamA", name: "Team A", display_name: "Team A", members: [
      { id: "123yonik", kind: "user" },
      { id: "124alice", kind: "user" },
    ] }],
    ["123teamB", { id: "123teamB", name: "Team B", display_name: "Team B", members: [
      { id: "124alice", kind: "user" },
    ] }],
  ]);
}

describe("computeMembershipClosure", () => {
  it("unions ancestors over all parent chains (matrix person in two chains)", () => {
    const closure = computeMembershipClosure(fixture());
    // alice sits in teamA (under product_x + data_branch) and teamB (under product_x)
    expect([...closure.get("124alice")!].sort()).toEqual(
      ["120data_branch", "123teamA", "123teamB", "product_x"].sort(),
    );
  });

  it("single-chain person gets direct node + all ancestors", () => {
    const closure = computeMembershipClosure(fixture());
    expect([...closure.get("123yonik")!].sort()).toEqual(
      ["120data_branch", "123teamA", "product_x"].sort(),
    );
  });

  it("branch head person is member of their branch node team", () => {
    const closure = computeMembershipClosure(fixture());
    expect(closure.get("999head")!.has("120data_branch")).toBe(true);
  });

  it("empty graph yields empty closure", () => {
    expect(computeMembershipClosure(new Map()).size).toBe(0);
  });

  it("org↔org cycle terminates and still reports both nodes", () => {
    const g: GroupyGraphSnapshot = new Map([
      ["n1", { id: "n1", name: "N1", display_name: "N1", members: [{ id: "n2", kind: "org" }] }],
      ["n2", { id: "n2", name: "N2", display_name: "N2", members: [
        { id: "n1", kind: "org" },
        { id: "u1", kind: "user" },
      ] }],
    ]);
    const closure = computeMembershipClosure(g);
    expect([...closure.get("u1")!].sort()).toEqual(["n1", "n2"]);
  });

  it("dangling member refs (unknown node) are ignored", () => {
    const g: GroupyGraphSnapshot = new Map([
      ["n1", { id: "n1", name: "N1", display_name: "N1", members: [{ id: "ghost", kind: "org" }] }],
    ]);
    expect(computeMembershipClosure(g).size).toBe(0);
  });
});

describe("subtreeNodeIds", () => {
  it("returns self + all descendant org nodes", () => {
    expect([...subtreeNodeIds(fixture(), "product_x")].sort()).toEqual(
      ["123teamA", "123teamB", "product_x"].sort(),
    );
  });

  it("leaf node returns only itself", () => {
    expect([...subtreeNodeIds(fixture(), "123teamB")]).toEqual(["123teamB"]);
  });

  it("unknown node returns empty set", () => {
    expect(subtreeNodeIds(fixture(), "nope").size).toBe(0);
  });

  it("cycle-safe", () => {
    const g: GroupyGraphSnapshot = new Map([
      ["n1", { id: "n1", name: "N1", display_name: "N1", members: [{ id: "n2", kind: "org" }] }],
      ["n2", { id: "n2", name: "N2", display_name: "N2", members: [{ id: "n1", kind: "org" }] }],
    ]);
    expect([...subtreeNodeIds(g, "n1")].sort()).toEqual(["n1", "n2"]);
  });
});
