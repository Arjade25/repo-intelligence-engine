import type { StronglyConnectedComponent } from "./tarjan.js";

/**
 * Shortest loop through each file of a cycle group, in files (a -> b -> a is 2).
 *
 * This, not the group's size, is what makes a cycle-tracing task hard: the
 * validator accepts ANY runtime cycle through the start file, so an agent only
 * ever has to find the shortest one. A 200-file group whose members all loop back
 * through one barrel in 2 hops is as easy for grep as nest's 4-file groups were.
 * The same number is taskgen's `min_path` for a cycle task.
 *
 * One BFS per member, restricted to the member's own component (a loop can't leave
 * it). Independent of src/, like the rest of this package.
 */
export function shortestLoopLengths(
  edges: { from: string; to: string }[],
  components: StronglyConnectedComponent[]
): Map<string, number> {
  const adjacency = new Map<string, Set<string>>();
  for (const { from, to } of edges) {
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from)!.add(to);
  }

  const result = new Map<string, number>();
  for (const { files } of components) {
    const members = new Set(files);
    for (const start of files) {
      result.set(start, shortestLoopFrom(start, members, adjacency));
    }
  }
  return result;
}

/** BFS from `start` inside `members`; the first edge back to `start` closes the shortest loop. */
function shortestLoopFrom(start: string, members: Set<string>, adjacency: Map<string, Set<string>>): number {
  const depth = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    const d = depth.get(current)!;
    for (const next of adjacency.get(current) ?? []) {
      if (next === start) return d + 1;
      if (!members.has(next) || depth.has(next)) continue;
      depth.set(next, d + 1);
      queue.push(next);
    }
  }
  // Unreachable for a real component member (every member lies on a cycle).
  throw new Error(`${start} is in a cycle group but has no loop back to itself`);
}

export interface LoopLengthSummary {
  members: number;
  /** Loop length (in files) -> how many members have exactly that shortest loop. */
  histogram: Map<number, number>;
  median: number;
  max: number;
  /** Members whose shortest loop is at least `longThreshold` files. */
  long: number;
}

export function summarizeLoopLengths(lengths: number[], longThreshold: number): LoopLengthSummary {
  const sorted = [...lengths].sort((a, b) => a - b);
  const histogram = new Map<number, number>();
  for (const l of sorted) histogram.set(l, (histogram.get(l) ?? 0) + 1);
  return {
    members: sorted.length,
    histogram,
    median: sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)],
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
    long: sorted.filter((l) => l >= longThreshold).length,
  };
}
