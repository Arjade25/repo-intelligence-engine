import { describe, expect, it } from "vitest";
import { successors, type CycleEvent, type CycleGraph, type RuntimeEdge } from "../../src/check/index.js";
import type { Finding } from "../../src/agent/finding.js";
import { citesTrap, stem, summarize, unsupportedHops, usefulness, type SessionRecord } from "./score.js";

const graph = (pairs: [string, string][]): CycleGraph => {
  const edges: RuntimeEdge[] = pairs.map(([from, to]) => ({ from, to, line: 0 }));
  return { groups: [], edges, next: successors(edges) };
};
const hop = (from: string, to: string, added_in_pr: boolean) => ({ from, to, line: 1, statement: "import x", runtime: true, added_in_pr });
const finding = (hops: ReturnType<typeof hop>[], why = ""): Finding => ({
  version: 1,
  event: "cycle_grown",
  facts: { loops: [{ hops }] },
  why_it_matters: why,
  suggestions: [],
});

// Base: a -> b -> a. PR adds b -> d -> a.
const oracle = { base: graph([["src/a.ts", "src/b.ts"], ["src/b.ts", "src/a.ts"]]), pr: graph([["src/a.ts", "src/b.ts"], ["src/b.ts", "src/a.ts"], ["src/b.ts", "src/d.ts"], ["src/d.ts", "src/a.ts"]]) };
const real = [hop("src/b.ts", "src/d.ts", true), hop("src/d.ts", "src/a.ts", true), hop("src/a.ts", "src/b.ts", false)];

describe("agent eval scoring", () => {
  it("finds no unsupported hop in a true finding", () => {
    expect(unsupportedHops(finding(real), oracle)).toEqual([]);
  });

  it("flags a hop the compiled output doesn't have, and a wrong added-in-PR claim", () => {
    const f = finding([hop("src/b.ts", "src/c.ts", true), hop("src/c.ts", "src/b.ts", true)]);
    expect(unsupportedHops(f, oracle)).toEqual([
      "loop 0 hop 0 (src/b.ts -> src/c.ts): not a runtime import in the compiled PR",
      "loop 0 hop 1 (src/c.ts -> src/b.ts): not a runtime import in the compiled PR",
    ]);
    const wrongAdded = finding([hop("src/a.ts", "src/b.ts", true), hop("src/b.ts", "src/a.ts", false)]);
    expect(unsupportedHops(wrongAdded, oracle)).toEqual(["loop 0 hop 0 (src/a.ts -> src/b.ts): added_in_pr is true, the compiled base says otherwise"]);
  });

  it("maps base paths through renames", () => {
    const renamed = { base: graph([["src/old.ts", "src/b.ts"]]), pr: graph([["src/new.ts", "src/b.ts"]]) };
    expect(unsupportedHops(finding([hop("src/new.ts", "src/b.ts", false)]), renamed, { "src/old.ts": "src/new.ts" })).toEqual([]);
  });

  it("scores usefulness by file stem", () => {
    expect(stem("apps/web/src/stores/RoomListStore.tsx")).toBe("roomliststore");
    const event = { type: "cycle_grown", outcome: "fail", joined: ["src/d.ts"] } as CycleEvent;
    expect(usefulness(finding(real, "B.ts now imports d, which imports a."), event)).toEqual({ names_added_import: true, names_joined_file: true });
    expect(usefulness(finding(real, "The cycle grew."), event)).toEqual({ names_added_import: false, names_joined_file: false });
    expect(usefulness(finding(real, "b imports d"), { ...event, joined: [] }).names_joined_file).toBeNull();
  });

  it("spots a draft citing the trap, parsed or not", () => {
    const trap = { file: "src/b.ts", target: "src/a.ts", line: 1 };
    expect(citesTrap(finding([hop("src/a.ts", "src/b.ts", false), hop("src/b.ts", "src/a.ts", true)]), trap)).toBe(true);
    expect(citesTrap(finding(real), trap)).toBe(false);
    expect(citesTrap("not json", trap)).toBe(false);
  });

  it("summarizes posted, fallback, retries and unsupported findings", () => {
    const base = { task_id: "t", repo: "r", sha: "s", kind: "real", run: 1, event_index: 0, event_type: "cycle_grown", loops_in_event: 1, wall_ms: 1000 } as const;
    const attempt = (status: "verified" | "rejected" | "no_draft", cost: number) => ({ status, errors: [], tool_calls: 1, refused: [], cost_usd: cost, num_turns: 2, wall_ms: 1000 });
    const records: SessionRecord[] = [
      { ...base, source: "agent", attempts: [attempt("verified", 0.02)], posted: finding(real, "b d"), unsupported: [], usefulness: { names_added_import: true, names_joined_file: null }, cost_usd: 0.02 },
      { ...base, source: "agent", attempts: [attempt("rejected", 0.02), attempt("verified", 0.05)], posted: finding(real), unsupported: ["x"], cost_usd: 0.05 },
      { ...base, source: "deterministic", attempts: [attempt("rejected", 0.02), attempt("rejected", 0.06)], unsupported: [], cost_usd: 0.06 },
    ];
    expect(summarize("x", records)).toMatchObject({
      sessions: 3,
      posted: 2,
      fallback: 1,
      first_draft_rejected: 2,
      rescued_by_retry: 1,
      unsupported_posted: 1,
      names_added_import: 1,
      cost_total: 0.13,
      cost_median: 0.05,
    });
  });
});
