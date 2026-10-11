import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { loadTsconfig } from "../../src/indexer/index.js";
import type { CycleGraph } from "../../src/check/index.js";

/**
 * Seeded cases for the replay (plan, evaluation step 3): one commit's snapshot plus
 * one injected import line, so the "PR" is known to touch exactly one import.
 * - "runtime": file A imports file B, where B already reaches A at runtime - a new
 *   loop, unless A and B already share a group.
 * - "type-only": the same pair, imported with `import type`.
 * - "type-by-usage": a plain namespace import used only in a type position, which
 *   the compiler erases even without the `type` keyword (nest writes most of its
 *   type imports this way).
 * Pairs are picked from the emit oracle's graph, never RIE's, and the oracle still
 * labels each seeded snapshot: the label is measured, not assumed.
 */

export type SeedKind = "runtime" | "type-only" | "type-by-usage";

export interface Seed {
  kind: SeedKind;
  /** The importing file, relative to the tsconfig directory. */
  from: string;
  to: string;
  line: string;
}

/** Deterministic PRNG (mulberry32), so a seed list is reproducible from its number. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Files that reach `target` at runtime (excluding itself), by reverse BFS. */
function reachersOf(graph: CycleGraph, target: string): Set<string> {
  const prev = new Map<string, string[]>();
  for (const e of graph.edges) prev.set(e.to, [...(prev.get(e.to) ?? []), e.from]);
  const seen = new Set<string>();
  const queue = [target];
  while (queue.length > 0) {
    for (const p of prev.get(queue.shift()!) ?? []) {
      if (!seen.has(p) && p !== target) seen.add(p), queue.push(p);
    }
  }
  return seen;
}

/** How a file in this tsconfig spells an import of another: extensionless for bundler resolution, ".js" for node16/nodenext. */
export function specifier(tsconfigPath: string, from: string, to: string): string {
  const resolution = String(loadTsconfig(tsconfigPath).options.moduleResolution ?? "");
  const nodeStyle = resolution === "3" || resolution === "99" || /node16|nodenext/i.test(resolution);
  let spec = posix.relative(posix.dirname(from), to).replace(/\.(tsx?|mts|cts)$/, nodeStyle ? ".js" : "");
  if (!spec.startsWith(".")) spec = `./${spec}`;
  return spec;
}

/**
 * Up to `count` seeds of each kind. A runtime seed's target reaches its importer, so
 * the line closes a loop; pairs already inside one group are avoided, since a new
 * edge there changes nothing a reviewer cares about. Type seeds reuse the same pairs.
 */
export function pickSeeds(graph: CycleGraph, files: string[], tsconfigPath: string, count: number, seed: number): Seed[] {
  const random = rng(seed);
  const groupOf = new Map<string, number>();
  graph.groups.forEach((g, i) => g.forEach((f) => groupOf.set(f, i)));
  const imports = new Set(graph.edges.map((e) => `${e.from}\u0000${e.to}`));
  const pairs: [string, string][] = [];
  const pool = files.filter((f) => !/\.d\.ts$/.test(f));
  for (let tries = 0; pairs.length < count && tries < count * 50; tries++) {
    const from = pool[Math.floor(random() * pool.length)];
    const reachers = [...reachersOf(graph, from)].filter(
      (to) => !imports.has(`${from}\u0000${to}`) && (groupOf.get(to) === undefined || groupOf.get(to) !== groupOf.get(from))
    );
    if (reachers.length === 0 || pairs.some(([f]) => f === from)) continue;
    pairs.push([from, reachers.sort()[Math.floor(random() * reachers.length)]]);
  }
  return pairs.flatMap(([from, to]) => {
    const spec = specifier(tsconfigPath, from, to);
    return [
      { kind: "runtime" as const, from, to, line: `import * as __rieSeed from "${spec}";\nvoid __rieSeed;` },
      { kind: "type-only" as const, from, to, line: `import type * as __rieSeed from "${spec}";\nexport type __RieSeed = typeof __rieSeed;` },
      { kind: "type-by-usage" as const, from, to, line: `import * as __rieSeed from "${spec}";\nexport type __RieSeed = typeof __rieSeed;` },
    ];
  });
}

/** Write the seed's lines at the top of its file; returns a function that restores it. */
export function applySeed(tsconfigPath: string, seed: Seed): () => void {
  const path = join(dirname(tsconfigPath), seed.from);
  const original = readFileSync(path, "utf8");
  writeFileSync(path, `${seed.line}\n${original}`);
  return () => writeFileSync(path, original);
}
