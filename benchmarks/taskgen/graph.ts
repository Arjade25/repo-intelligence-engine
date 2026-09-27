export type Adjacency = Map<string, string[]>;

export function buildAdjacency(edges: { from: string; to: string }[]): Adjacency {
  const adj: Adjacency = new Map();
  const seen = new Set<string>();
  for (const { from, to } of edges) {
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push(to);
  }
  for (const list of adj.values()) list.sort();
  return adj;
}

/** BFS parents from `source`, never leaving `allowed` (when given). Neighbor lists
 *  are sorted, so ties break the same way every run. */
export function bfsParents(adj: Adjacency, source: string, allowed?: Set<string>): Map<string, string | null> {
  const parents = new Map<string, string | null>([[source, null]]);
  const queue = [source];
  for (let i = 0; i < queue.length; i++) {
    for (const next of adj.get(queue[i]) ?? []) {
      if (parents.has(next) || (allowed && !allowed.has(next))) continue;
      parents.set(next, queue[i]);
      queue.push(next);
    }
  }
  return parents;
}

/** Node path source..target from a bfsParents result, or null if unreachable. */
export function pathTo(parents: Map<string, string | null>, target: string): string[] | null {
  if (!parents.has(target)) return null;
  const path: string[] = [];
  for (let at: string | null = target; at !== null; at = parents.get(at)!) path.push(at);
  return path.reverse();
}

/** Shortest cycle through `start` as a node list beginning and ending with it. */
export function shortestCycleThrough(adj: Adjacency, start: string, allowed?: Set<string>): string[] | null {
  if ((adj.get(start) ?? []).includes(start)) return [start, start];
  const parents = bfsParents(adj, start, allowed);
  const queue = [...parents.keys()]; // insertion order is BFS order
  for (const node of queue) {
    if (node !== start && (adj.get(node) ?? []).includes(start)) return [...pathTo(parents, node)!, start];
  }
  return null;
}
