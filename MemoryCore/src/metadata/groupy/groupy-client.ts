/**
 * Org-hierarchy-sync — groupy client abstraction + recursive walker.
 *
 * DESIGN.md §5.1: walk from GROUPY_ROOTS recursively via fetchNode(id);
 * dedupe by id; guard cycles. The real HTTP adapter is a future swap
 * (needs company-net facts, §13); the mock JSON fixture covers dev/test.
 * groupy is the single authority for mirrored structure — fetch errors
 * propagate so the sync run fails closed (last-good state retained).
 */

import type { GroupyMemberRef, GroupyGraphSnapshot, GroupyNodeSnapshot } from "./closure.js";

export interface GroupyNodeData {
  id: string;
  name: string;
  display_name: string;
  members: GroupyMemberRef[];
}

export abstract class GroupyClient {
  abstract fetchNode(id: string): Promise<GroupyNodeData>;
}

/**
 * Fetch the reachable graph from roots. Each node fetched at most once
 * (visited-before-fetch also breaks org↔org cycles). Throws on fetch error.
 */
export async function walkGroupyGraph(
  client: GroupyClient,
  roots: string[],
): Promise<GroupyGraphSnapshot> {
  const graph: GroupyGraphSnapshot = new Map();
  const queue = [...roots];
  const seen = new Set<string>(roots);
  while (queue.length > 0) {
    const id = queue.pop()!;
    const node = await client.fetchNode(id);
    const snapshot: GroupyNodeSnapshot = {
      id: node.id,
      name: node.name,
      display_name: node.display_name,
      members: node.members,
    };
    graph.set(node.id, snapshot);
    for (const m of node.members) {
      if (m.kind !== "org" || seen.has(m.id)) continue;
      seen.add(m.id);
      queue.push(m.id);
    }
  }
  return graph;
}
