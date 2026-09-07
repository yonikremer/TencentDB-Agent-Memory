/**
 * Org-hierarchy-sync P1 — client/walker/mock tests (TDD). DESIGN.md §5.1:
 * walk from roots recursively, dedupe by id, guard cycles.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GroupyClient, walkGroupyGraph, type GroupyNodeData } from "./groupy-client.js";
import { MockGroupyClient } from "./mock-groupy-client.js";

class StubClient extends GroupyClient {
  calls: string[] = [];
  constructor(private readonly nodes: Map<string, GroupyNodeData>) { super(); }
  async fetchNode(id: string): Promise<GroupyNodeData> {
    this.calls.push(id);
    const n = this.nodes.get(id);
    if (!n) throw new Error(`node_not_found: ${id}`);
    return n;
  }
}

function matrixNodes(): Map<string, GroupyNodeData> {
  const m = new Map<string, GroupyNodeData>();
  m.set("product_x", { id: "product_x", name: "Product X", display_name: "Product X",
    members: [{ id: "123teamA", kind: "org" }] });
  m.set("120data_branch", { id: "120data_branch", name: "Data Branch", display_name: "D",
    members: [{ id: "123teamA", kind: "org" }] });
  m.set("123teamA", { id: "123teamA", name: "Team A", display_name: "A",
    members: [{ id: "123yonik", kind: "user" }] });
  return m;
}

describe("walkGroupyGraph", () => {
  it("walks from roots, merges shared subtrees, fetches each node once", async () => {
    const client = new StubClient(matrixNodes());
    const graph = await walkGroupyGraph(client, ["product_x", "120data_branch"]);
    expect([...graph.keys()].sort()).toEqual(["120data_branch", "123teamA", "product_x"]);
    expect(client.calls.filter((c) => c === "123teamA")).toHaveLength(1);
  });

  it("cycle terminates", async () => {
    const nodes = new Map<string, GroupyNodeData>();
    nodes.set("a", { id: "a", name: "A", display_name: "A", members: [{ id: "b", kind: "org" }] });
    nodes.set("b", { id: "b", name: "B", display_name: "B", members: [{ id: "a", kind: "org" }] });
    const graph = await walkGroupyGraph(new StubClient(nodes), ["a"]);
    expect([...graph.keys()].sort()).toEqual(["a", "b"]);
  });

  it("propagates fetch errors", async () => {
    const client = new StubClient(new Map());
    await expect(walkGroupyGraph(client, ["missing"])).rejects.toThrow("node_not_found");
  });
});

describe("MockGroupyClient", () => {
  it("loads fixture JSON and serves fetchNode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "groupy-"));
    const file = join(dir, "fixture.json");
    const fixture = { nodes: [
      { id: "r", name: "R", display_name: "R", members: [{ id: "u1", kind: "user" }] },
    ] };
    writeFileSync(file, JSON.stringify(fixture));
    const client = new MockGroupyClient(file);
    const node = await client.fetchNode("r");
    expect(node.members).toEqual([{ id: "u1", kind: "user" }]);
    await expect(client.fetchNode("nope")).rejects.toThrow("node_not_found");
  });

  it("rejects malformed fixture", () => {
    const dir = mkdtempSync(join(tmpdir(), "groupy-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ nodes: "nope" }));
    expect(() => new MockGroupyClient(file)).toThrow();
  });
});
