/**
 * Org-hierarchy-sync — mock groupy adapter from a JSON fixture file.
 *
 * Active only when GROUPY_MOCK_FILE is set (explicit opt-in; never prod
 * default). Fixture shape: { nodes: [{ id, name, display_name?, members }] }.
 */

import { readFileSync } from "node:fs";
import { GroupyClient, type GroupyNodeData } from "./groupy-client.js";

interface FixtureMember {
  id: unknown;
  kind: unknown;
}

interface FixtureNode {
  id: unknown;
  name: unknown;
  display_name?: unknown;
  members: unknown;
}

export class MockGroupyClient extends GroupyClient {
  private readonly nodes = new Map<string, GroupyNodeData>();

  constructor(fixturePath: string) {
    super();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(fixturePath, "utf-8"));
    } catch (err) {
      throw new Error(`groupy mock fixture unreadable: ${fixturePath}: ${(err as Error).message}`);
    }
    const rawNodes = (parsed as { nodes?: unknown }).nodes;
    if (!Array.isArray(rawNodes)) {
      throw new Error(`groupy mock fixture malformed: ${fixturePath}: expected { nodes: [...] }`);
    }
    for (const raw of rawNodes as FixtureNode[]) {
      const node = normalizeNode(raw, fixturePath);
      this.nodes.set(node.id, node);
    }
  }

  async fetchNode(id: string): Promise<GroupyNodeData> {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`node_not_found: ${id}`);
    return node;
  }
}

function normalizeNode(raw: FixtureNode, fixturePath: string): GroupyNodeData {
  if (typeof raw?.id !== "string" || !raw.id) {
    throw new Error(`groupy mock fixture malformed: ${fixturePath}: node missing string id`);
  }
  if (!Array.isArray(raw.members)) {
    throw new Error(`groupy mock fixture malformed: ${fixturePath}: node ${raw.id} missing members[]`);
  }
  const members = (raw.members as FixtureMember[]).map((m): { id: string; kind: "user" | "org" } => {
    if (typeof m?.id !== "string" || (m.kind !== "user" && m.kind !== "org")) {
      throw new Error(
        `groupy mock fixture malformed: ${fixturePath}: bad member in node ${raw.id}`,
      );
    }
    return { id: m.id, kind: m.kind };
  });
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : raw.id,
    display_name: typeof raw.display_name === "string" ? raw.display_name : raw.id,
    members,
  };
}
