import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { computeEmittedEdges } from "./emitted-edges.js";
import { findStronglyConnectedComponents } from "./tarjan.js";
import { CYCLE_EVENT_CASES, materialize, type CycleEventCase } from "../../src/check/cycle-events.cases.js";

/**
 * Checks every cycle event case's premises against a real tsc emit, before any
 * `rie check` code exists: that each snapshot has exactly the runtime groups the
 * case says, that each trap import really is erased or lazy (and would close a
 * loop if counted), and that the expected evidence is made of real runtime edges,
 * cites the right lines, is the shortest loop through its new edge, and covers
 * every new edge inside a group. The expected events themselves are asserted
 * against the check in src/check/cycle-events.test.ts.
 */

type Edge = { from: string; to: string };

/** "src/a.ts" for any absolute path inside a snapshot. */
const rel = (p: string) => p.replace(/\\/g, "/").replace(/^.*\/(src\/[^/]+)$/, "$1");
const sortGroups = (gs: string[][]) => gs.map((g) => [...g].sort()).sort((x, y) => x.join().localeCompare(y.join()));
const key = (e: Edge) => `${e.from} -> ${e.to}`;

function snapshotGraph(tsconfig: string) {
  const result = computeEmittedEdges(tsconfig);
  expect(result.unresolvedInternal).toEqual([]);
  const edges = result.edges.map((e) => ({ from: rel(e.from), to: rel(e.to) }));
  const source = result.sourceEdges.map((e) => ({ from: rel(e.from), to: rel(e.to) }));
  const groups = sortGroups(findStronglyConnectedComponents(edges).filter((c) => c.files.length > 1).map((c) => c.files));
  return { edges, source, groups, root: dirname(tsconfig) };
}

/** Fewest hops from `from` to `to`, or Infinity. */
function distance(edges: Edge[], from: string, to: string): number {
  const seen = new Map([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift()!;
    if (at === to) return seen.get(at)!;
    for (const e of edges) {
      if (e.from === at && !seen.has(e.to)) {
        seen.set(e.to, seen.get(at)! + 1);
        queue.push(e.to);
      }
    }
  }
  return Infinity;
}

/** Files on the shortest loop through `file` (0 = none). */
function shortestLoop(edges: Edge[], file: string): number {
  const lengths = edges.filter((e) => e.from === file).map((e) => 1 + distance(edges, e.to, file));
  const best = Math.min(...lengths);
  return Number.isFinite(best) ? best : 0;
}

function lineOf(root: string, at: string): string {
  const [path, line] = at.split(":");
  return readFileSync(join(root, path), "utf8").split("\n")[Number(line) - 1].replace(/\s+/g, " ").trim();
}

describe.each(CYCLE_EVENT_CASES.map((c) => [c.name, c] as [string, CycleEventCase]))("cycle event case: %s", (_name, c) => {
  const base = snapshotGraph(materialize(c.base, `${c.name}-base`));
  const pr = snapshotGraph(materialize(c.pr, `${c.name}-pr`));
  const renamed = (f: string) => c.renames?.[f] ?? f;
  const baseEdgeKeys = new Set(base.edges.map((e) => key({ from: renamed(e.from), to: renamed(e.to) })));

  it("has exactly the runtime cycle groups the case declares, in both snapshots", () => {
    expect(base.groups).toEqual(sortGroups(c.groups.base));
    expect(pr.groups).toEqual(sortGroups(c.groups.pr));
  });

  it.runIf(c.trap)("its trap import closes a loop only if it is counted", () => {
    const { from, to, kind } = c.trap!;
    expect(pr.edges.some((e) => e.from === from && e.to === to)).toBe(false);
    if (kind === "type") {
      // Written in source, erased at emit; counted, it would close a loop.
      expect(pr.source.some((e) => e.from === from && e.to === to)).toBe(true);
      expect(distance(pr.edges, to, from)).toBeLessThan(Infinity);
    } else {
      expect(readFileSync(join(pr.root, from), "utf8")).toContain("import(");
    }
  });

  const failing = c.expected.events.filter((e) => e.outcome !== "pass");

  it("gives evidence only for fail and warn events, and always for them", () => {
    for (const e of c.expected.events) expect(e.evidence !== undefined, e.type).toBe(e.outcome !== "pass");
  });

  it.runIf(failing.length > 0)("cites real runtime imports, on the right lines, as the shortest loop through each new edge", () => {
    for (const { loop, hops } of failing.flatMap((e) => e.evidence!)) {
      expect(loop[0]).toBe(loop.at(-1));
      expect(hops).toHaveLength(loop.length - 1);
      hops.forEach((hop, i) => {
        expect(pr.edges, `${loop[i]} -> ${loop[i + 1]}`).toContainEqual({ from: loop[i], to: loop[i + 1] });
        expect(hop.at.startsWith(`${loop[i]}:`)).toBe(true);
        expect(lineOf(pr.root, hop.at)).toBe(hop.statement);
      });
      expect(baseEdgeKeys.has(key({ from: loop[0], to: loop[1] })), "a loop starts on an edge the PR added").toBe(false);
      expect(loop.length - 1).toBe(1 + distance(pr.edges, loop[1], loop[0]));
    }
  });

  it("covers every new runtime edge inside a PR group with some evidence loop", () => {
    const inGroup = (e: Edge) => pr.groups.some((g) => g.includes(e.from) && g.includes(e.to));
    const added = pr.edges.filter((e) => !baseEdgeKeys.has(key(e)) && inGroup(e)).map(key);
    const cited = new Set(
      c.expected.events.flatMap((e) => e.evidence ?? []).flatMap(({ loop }) => loop.slice(1).map((to, i) => key({ from: loop[i], to })))
    );
    // A rename moves edges without adding any: matching through the map must leave nothing new.
    expect(added.filter((k) => !cited.has(k))).toEqual([]);
  });

  it("lists joined, left and shortened files consistent with the groups", () => {
    const inBase = new Set(base.groups.flat().map(renamed));
    const inPr = new Set(pr.groups.flat());
    for (const e of c.expected.events) {
      for (const f of e.joined ?? []) expect(inBase.has(f), `${f} joined`).toBe(false);
      for (const f of e.left ?? []) expect(inPr.has(renamed(f)), `${f} left`).toBe(false);
      if (e.joined) expect(e.joined).toEqual((e.pr_groups ?? []).flat().filter((f) => !inBase.has(f)).sort());
      if (e.left) expect(e.left).toEqual((e.base_groups ?? []).flat().filter((f) => !inPr.has(renamed(f))).sort());
      if (e.shortened) {
        const files = e.pr_groups!.flat();
        const actual = files
          .map((file) => ({ file, base_length: shortestLoop(base.edges, file), pr_length: shortestLoop(pr.edges, file) }))
          .filter((x) => x.pr_length < x.base_length);
        expect(actual).toEqual(e.shortened);
      }
    }
  });

  it("takes the strictest event's outcome", () => {
    const rank = { pass: 0, warn: 1, fail: 2 } as const;
    const strictest = c.expected.events.reduce((m, e) => (rank[e.outcome] > rank[m] ? e.outcome : m), "pass" as keyof typeof rank);
    expect(c.expected.outcome).toBe(strictest);
  });
});
