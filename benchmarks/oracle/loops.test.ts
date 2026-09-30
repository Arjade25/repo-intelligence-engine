import { describe, expect, it } from "vitest";
import { findStronglyConnectedComponents } from "./tarjan.js";
import { shortestLoopLengths, summarizeLoopLengths } from "./loops.js";

const loopsOf = (edges: { from: string; to: string }[]) =>
  Object.fromEntries(shortestLoopLengths(edges, findStronglyConnectedComponents(edges)));

const chain = (...files: string[]) => files.slice(1).map((to, i) => ({ from: files[i], to }));

describe("shortestLoopLengths", () => {
  it("gives every member of a plain ring the ring's length", () => {
    expect(loopsOf(chain("a", "b", "c", "d", "a"))).toEqual({ a: 4, b: 4, c: 4, d: 4 });
  });

  it("counts a self-import as a 1-file loop", () => {
    expect(loopsOf([{ from: "a", to: "a" }])).toEqual({ a: 1 });
  });

  it("finds the barrel shortcut: a big group where everyone loops back in 2", () => {
    // Every file imports the barrel and the barrel re-exports every file - the
    // TypeScript-compiler `_namespaces/ts` shape. One huge group, trivial loops.
    const files = ["a", "b", "c", "d", "e"];
    const edges = files.flatMap((f) => [
      { from: f, to: "barrel" },
      { from: "barrel", to: f },
    ]);
    const loops = loopsOf(edges);
    expect(Object.keys(loops)).toHaveLength(6);
    expect(Object.values(loops).every((l) => l === 2)).toBe(true);
  });

  it("takes the shortest loop per file, so members of one group can differ", () => {
    // a <-> b is a 2-loop; c and d only get back through the 4-ring a->c->d->b->a.
    const edges = [...chain("a", "c", "d", "b", "a"), { from: "a", to: "b" }];
    expect(loopsOf(edges)).toEqual({ a: 2, b: 2, c: 4, d: 4 });
  });

  it("ignores files outside any group, and reports only group members", () => {
    // `dead` is reachable from the loop but never returns, so it's in no group.
    expect(loopsOf([...chain("in", "a", "b", "a"), { from: "a", to: "dead" }])).toEqual({ a: 2, b: 2 });
  });
});

describe("summarizeLoopLengths", () => {
  it("builds a histogram, median, max and long-loop count", () => {
    const s = summarizeLoopLengths([2, 2, 3, 6, 8], 6);
    expect(s).toMatchObject({ members: 5, median: 3, max: 8, long: 2 });
    expect([...s.histogram]).toEqual([
      [2, 2],
      [3, 1],
      [6, 1],
      [8, 1],
    ]);
  });
});
