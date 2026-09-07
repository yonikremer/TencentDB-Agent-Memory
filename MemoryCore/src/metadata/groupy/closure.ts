/**
 * Org-hierarchy-sync — ancestor-closure + subtree computation (pure, no I/O).
 *
 * DESIGN.md §5 step 2: the org is a DAG (matrix), not a tree. Every person maps
 * to the union of all org nodes on every parent chain above them. Branch heads
 * are persons too — direct membership covers them, nothing special needed.
 *
 * Runtime read paths never traverse the graph; the nightly sync precomputes
 * this closure into team-member rows, and share flows use subtreeNodeIds.
 */

export interface GroupyMemberRef {
  id: string;
  kind: "user" | "org";
}

export interface GroupyNodeSnapshot {
  id: string;
  name: string;
  display_name: string;
  members: GroupyMemberRef[];
}

/** Fetched graph: node id → node snapshot (walker output). */
export type GroupyGraphSnapshot = Map<string, GroupyNodeSnapshot>;

/**
 * personId → every ancestor org node id (direct parents + transitive, union
 * over all parent chains). Iterative BFS with a visited set: cycles terminate.
 * Dangling refs (member id with no snapshot) are ignored.
 */
export function computeMembershipClosure(graph: GroupyGraphSnapshot): Map<string, Set<string>> {
  const parents = new Map<string, Set<string>>();
  for (const node of graph.values()) {
    for (const m of node.members) {
      if (m.kind !== "user" && !graph.has(m.id)) continue;
      let set = parents.get(m.id);
      if (!set) {
        set = new Set();
        parents.set(m.id, set);
      }
      set.add(node.id);
    }
  }

  const closure = new Map<string, Set<string>>();
  for (const [childId, directParents] of parents) {
    // Only persons get closure rows; org→org edges feed the BFS below.
    const ancestors = new Set<string>();
    const queue = [...directParents];
    for (const p of directParents) ancestors.add(p);
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const up of parents.get(cur) ?? []) {
        if (!ancestors.has(up)) {
          ancestors.add(up);
          queue.push(up);
        }
      }
    }
    // A person is a member id of kind "user"; org nodes never appear as users.
    if (isPerson(graph, childId)) closure.set(childId, ancestors);
  }
  return closure;
}

/**
 * nodeId → itself + all descendant org node ids (downward walk over kind=org
 * member edges). Used by share flows: grants expand to every subtree team so
 * agents querying with a single leaf team_id match without graph traversal.
 */
export function subtreeNodeIds(graph: GroupyGraphSnapshot, nodeId: string): Set<string> {
  const out = new Set<string>();
  if (!graph.has(nodeId)) return out;
  const queue = [nodeId];
  out.add(nodeId);
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const m of graph.get(cur)?.members ?? []) {
      if (m.kind !== "org" || !graph.has(m.id) || out.has(m.id)) continue;
      out.add(m.id);
      queue.push(m.id);
    }
  }
  return out;
}

/** A member id is a person unless it has a node snapshot (org nodes have snapshots). */
function isPerson(graph: GroupyGraphSnapshot, memberId: string): boolean {
  return !graph.has(memberId);
}
