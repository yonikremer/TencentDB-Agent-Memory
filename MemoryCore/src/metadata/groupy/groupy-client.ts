/**
 * Org-hierarchy-sync — groupy client abstraction + recursive walker.
 *
 * DESIGN.md §5.1: walk from GROUPY_ROOTS recursively via fetchNode(id);
 * dedupe by id; guard cycles. The real HTTP adapter is a future swap
 * (needs company-net facts, §13); the mock JSON fixture covers dev/test.
 * groupy is the single authority for mirrored structure — fetch errors
 * propagate so the sync run fails closed (last-good state retained).
 *
 * ID rule: node/member ids become kernel team_ids verbatim and flow on to KS
 * as team segments (filesystem paths). Anything outside [A-Za-z0-9_-]{1,200}
 * fails the walk closed (fail-closed beats silently skewing identity data).
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

export const GROUPY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const GROUPY_ID_MAX = 200;
/** Fail-safe default: orgs far beyond this are a misconfigured root/cycle. */
export const DEFAULT_MAX_WALK_NODES = 5000;

export function isValidGroupyId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= GROUPY_ID_MAX &&
    GROUPY_ID_PATTERN.test(id)
  );
}

export interface WalkOptions {
  maxNodes?: number;
}

/**
 * Fetch the reachable graph from roots. Each node fetched at most once
 * (visited-before-fetch also breaks org↔org cycles). Throws on fetch error,
 * invalid ids, or beyond maxNodes.
 */
export async function walkGroupyGraph(
  client: GroupyClient,
  roots: string[],
  opts: WalkOptions = {},
): Promise<GroupyGraphSnapshot> {
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_WALK_NODES;
  const queue = [...roots];
  const seen = new Set<string>(roots);
  const graph: GroupyGraphSnapshot = new Map();
  for (const r of roots) assertGroupyId(r);
  while (queue.length > 0) {
    const id = queue.pop()!;
    const node = await client.fetchNode(id);
    assertGroupyId(node.id);
    if (graph.size >= maxNodes) {
      throw new Error(`groupy walk exceeds max nodes ${maxNodes} (root misconfiguration?)`);
    }
    const snapshot: GroupyNodeSnapshot = {
      id: node.id,
      name: node.name,
      display_name: node.display_name,
      members: node.members,
    };
    graph.set(node.id, snapshot);
    for (const m of node.members) {
      assertGroupyId(m.id);
      if (m.kind !== "user" && m.kind !== "org") {
        throw new Error(`groupy member malformed: ${node.id}: bad kind for ${m.id}`);
      }
      if (m.kind !== "org" || seen.has(m.id)) continue;
      seen.add(m.id);
      queue.push(m.id);
    }
  }
  return graph;
}

function assertGroupyId(id: unknown): asserts id is string {
  if (!isValidGroupyId(id)) {
    throw new Error(`groupy id invalid (expected [A-Za-z0-9_-]{1,200}): ${String(id)}`);
  }
}
