import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateTasks, type CycleTraceTask, type ImpactTask, type TrapTask } from "./generate.js";
import { ImpactOracle } from "./impact.js";
import { scoreImpact, validateCyclePath, validateTrapAnswer } from "./validators.js";
import { buildAdjacency, shortestCycleThrough } from "./graph.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "../../fixtures/taskgen-repo");
const TSCONFIG = join(FIXTURE, "tsconfig.json");

/**
 * fixtures/taskgen-repo is built so every category has a known answer:
 *   cycle/   a -> b -> c -> index (barrel) -> a      runtime cycle, length 4
 *   short/   x <-> y                                 runtime cycle, length 2 (must be filtered)
 *   trap/    e -> f -> g -> h, h -> e type-only      source cycle only (every pair is "no")
 *   lib/     makeWidget, reached by 1 direct importer + 4 via the barrel (one through @lib alias)
 *   solo/    soloFn with a single importer (must be filtered)
 */
describe("generateTasks (fixtures/taskgen-repo)", () => {
  const set = generateTasks({ tsconfigPath: TSCONFIG, repo: "fixture/taskgen-repo", idPrefix: "fx" });
  const cycles = set.tasks.filter((t): t is CycleTraceTask => t.category === "cycle_trace");
  const traps = set.tasks.filter((t): t is TrapTask => t.category === "runtime_type_trap");
  const impacts = set.tasks.filter((t): t is ImpactTask => t.category === "change_impact");

  it("finds the runtime and source SCCs the fixture was built with", () => {
    expect(set.stats.runtime_sccs).toEqual([4, 2]);
    expect(set.stats.source_sccs).toEqual([4, 4, 2]);
  });

  it("drops the 2-file cycle and keeps one cycle-trace task per start in the 4-file cycle", () => {
    expect(set.stats.cycle_trace).toEqual({ candidates: 6, passed_min_path: 4, emitted: 4 });
    expect(cycles.map((t) => t.expected.start).sort()).toEqual([
      "src/cycle/a.ts",
      "src/cycle/b.ts",
      "src/cycle/c.ts",
      "src/cycle/index.ts",
    ]);
    for (const t of cycles) {
      expect(t.difficulty).toMatchObject({ scc_size: 4, min_path: 4, barrels: true });
      expect(validateCyclePath(t, t.expected.example_cycle).valid).toBe(true);
    }
  });

  it("answers yes only for real runtime cycles and no only for cycles that close through an erased import", () => {
    expect(traps).toHaveLength(10);
    for (const t of traps) {
      const dir = t.expected.a.split("/")[1];
      expect(dir).toBe(t.expected.answer ? "cycle" : "trap");
      if (!t.expected.answer) expect(t.difficulty.type_distractors).toBeGreaterThanOrEqual(1);
    }
    expect(traps.filter((t) => t.expected.answer)).toHaveLength(5);
    expect(traps.some((t) => t.expected.a.startsWith("src/short/"))).toBe(false);
  });

  it("generates the makeWidget impact task and skips the single-importer soloFn", () => {
    expect(impacts).toHaveLength(1);
    const [t] = impacts;
    expect(t.expected.symbol).toBe("makeWidget");
    expect(t.expected.files).toEqual([
      "src/consumers/direct.ts",
      "src/consumers/use1.ts",
      "src/consumers/use2.ts",
      "src/consumers/use3.ts",
      "src/consumers/use4.ts",
    ]);
    expect(t.difficulty).toEqual({
      impacted_files: 5,
      direct_importers: 1,
      via_reexport: 4,
      reexport_hops: 1,
      barrels: true,
      aliases: true,
    });
  });

  it("records the tsconfig flags every task was generated under", () => {
    for (const t of set.tasks) expect(t.tsconfig_flags).toEqual(set.tsconfig_flags);
    expect(set.tsconfig_flags).toMatchObject({ emitDecoratorMetadata: false, verbatimModuleSyntax: false });
  });

  it("is deterministic for a given seed", () => {
    const again = generateTasks({ tsconfigPath: TSCONFIG, repo: "fixture/taskgen-repo", idPrefix: "fx" });
    expect(again.tasks).toEqual(set.tasks);
  });
});

describe("validators", () => {
  const set = generateTasks({ tsconfigPath: TSCONFIG, repo: "fixture/taskgen-repo", idPrefix: "fx", maxPerCategory: 1 });
  const cycle = set.tasks.find((t): t is CycleTraceTask => t.category === "cycle_trace")!;
  const trap = set.tasks.find((t): t is TrapTask => t.category === "runtime_type_trap")!;
  const impact = set.tasks.find((t): t is ImpactTask => t.category === "change_impact")!;

  it("rejects a cycle path that doesn't close, skips a hop, or starts elsewhere", () => {
    const ok = cycle.expected.example_cycle;
    expect(validateCyclePath(cycle, ok.slice(0, -1)).valid).toBe(false);
    expect(validateCyclePath(cycle, [ok[0], ok[2], ...ok.slice(3)]).valid).toBe(false);
    expect(validateCyclePath(cycle, ok.slice(1).concat(ok[1])).valid).toBe(false);
  });

  it("normalizes ./ prefixes and backslashes in answers", () => {
    const messy = cycle.expected.example_cycle.map((f) => `./${f.replace(/\//g, "\\")}`);
    expect(validateCyclePath(cycle, messy).valid).toBe(true);
  });

  it("grades yes/no against the oracle's answer", () => {
    expect(validateTrapAnswer(trap, trap.expected.answer)).toBe(true);
    expect(validateTrapAnswer(trap, !trap.expected.answer)).toBe(false);
  });

  it("scores a partial impact answer by precision and recall", () => {
    const score = scoreImpact(impact, ["src/consumers/direct.ts", "src/consumers/use1.ts", "src/lib/index.ts"]);
    expect(score.precision).toBeCloseTo(2 / 3);
    expect(score.recall).toBeCloseTo(2 / 5);
    expect(score.extra).toEqual(["src/lib/index.ts"]);
    expect(score.missed).toHaveLength(3);
  });
});

describe("ImpactOracle", () => {
  const oracle = new ImpactOracle(TSCONFIG);

  it("finds exactly the one file that breaks when soloFn loses its export", () => {
    const impacted = oracle.impactOfRemovingExport(join(FIXTURE, "src/solo/solo.ts"), "soloFn");
    expect(impacted.map((f) => f.slice(f.indexOf("src/")))).toEqual(["src/solo/solo-user.ts"]);
  });

  it("does not count the barrel itself: `export *` silently drops a name instead of erroring", () => {
    const impacted = oracle.impactOfRemovingExport(join(FIXTURE, "src/lib/widget.ts"), "makeWidget");
    expect(impacted.some((f) => f.endsWith("src/lib/index.ts"))).toBe(false);
  });
});

describe("shortestCycleThrough", () => {
  it("prefers the shorter of two cycles through the same node", () => {
    const adj = buildAdjacency([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
      { from: "a", to: "d" },
      { from: "d", to: "a" },
    ]);
    expect(shortestCycleThrough(adj, "a")).toEqual(["a", "d", "a"]);
  });

  it("returns null when the node is on no cycle", () => {
    expect(shortestCycleThrough(buildAdjacency([{ from: "a", to: "b" }]), "a")).toBeNull();
  });
});
