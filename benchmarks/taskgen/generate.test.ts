import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateTasks, type CycleTraceTask, type DependencyPathTask, type ImpactTask, type TrapTask } from "./generate.js";
import { ImpactOracle } from "./impact.js";
import { scoreImpact, validateCyclePath, validateImportPath, validateTrapAnswer } from "./validators.js";
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
 *   gadget/  makeGadget, reached through a NAMED re-export whose importer error
 *            recovery shields (must be dropped)
 *   paths/   start -> s1 -> ... -> s5 (5 hops); island, imported by i1-i3 and itself
 *            reaching start, is the one near miss start can't reach
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

  it("builds dependency-path tasks only from chains of at least --min-hops (default 5)", () => {
    const paths = set.tasks.filter((t): t is DependencyPathTask => t.category === "dependency_path");
    expect(paths.length).toBeGreaterThan(0);
    expect(set.stats.dependency_path.max_hops).toBe(7); // i1 -> island -> start -> s1 -> ... -> s5
    for (const t of paths) {
      expect(t.expected.reachable).toBe(true); // no start reaches the default 25-file closure
      expect(t.difficulty.min_hops).toBeGreaterThanOrEqual(5);
      expect(t.expected.example_path![0]).toBe(t.expected.from);
      expect(validateImportPath(t, t.expected.example_path).valid).toBe(true);
      expect(validateImportPath(t, null).valid).toBe(false);
    }
  });

  it("drops makeGadget: its answer hinges on error recovery through a broken named re-export", () => {
    expect(set.stats.change_impact.dropped_broken_reexport).toBe(1);
    expect(impacts.some((t) => t.expected.symbol === "makeGadget")).toBe(false);
  });

  it("states the tsconfig's scope in every prompt", () => {
    for (const t of set.tasks) {
      expect(t.prompt).toContain("Scope: only the files tsconfig.json includes count (include `src/**/*`)");
    }
  });

  it("refuses to generate when internal imports don't resolve, unless told to", () => {
    const esm = join(__dirname, "../../fixtures/esm-alias-repo/tsconfig.json");
    expect(() => generateTasks({ tsconfigPath: esm, repo: "fixture/esm", idPrefix: "esm" })).toThrow(
      /2 internal import\(s\) do not resolve[\s\S]*--allow-unresolved/
    );
  });

  it("records the tsconfig flags every task was generated under", () => {
    for (const t of set.tasks) expect(t.tsconfig_flags).toEqual(set.tsconfig_flags);
    expect(set.tsconfig_flags).toMatchObject({ emitDecoratorMetadata: false, verbatimModuleSyntax: false });
  });

  it("is deterministic for a given seed", () => {
    const again = generateTasks({ tsconfigPath: TSCONFIG, repo: "fixture/taskgen-repo", idPrefix: "fx" });
    expect(again.tasks).toEqual(set.tasks);
  }, 30_000); // a full regeneration: ~1-2s idle, measured at 6s under a loaded parallel run
});

describe("generateTasks: unreachable dependency paths", () => {
  const set = generateTasks({ tsconfigPath: TSCONFIG, repo: "fixture/taskgen-repo", idPrefix: "fx", minClosure: 5 });
  const noPath = set.tasks.filter((t): t is DependencyPathTask => t.category === "dependency_path" && !t.expected.reachable);

  it("picks the near miss: island is next door and reaches start, but start never reaches it", () => {
    expect(set.stats.dependency_path.unreachable_candidates).toBe(1);
    expect(noPath).toHaveLength(1);
    const [t] = noPath;
    expect([t.expected.from, t.expected.to]).toEqual(["src/paths/start.ts", "src/paths/island.ts"]);
    expect(t.difficulty).toMatchObject({ min_hops: null, closure_size: 5, reverse_path: true });
  });

  it("grades null or an empty list as the right answer, and any chain as wrong", () => {
    const [t] = noPath;
    expect(validateImportPath(t, null).valid).toBe(true);
    expect(validateImportPath(t, []).valid).toBe(true);
    expect(validateImportPath(t, ["src/paths/start.ts", "src/paths/island.ts"]).valid).toBe(false);
  });
});

describe("validateImportPath on a reachable task", () => {
  const ok = ["src/paths/start.ts", "src/paths/s1.ts", "src/paths/s2.ts", "src/paths/s3.ts"];
  const t = {
    category: "dependency_path",
    expected: {
      from: ok[0],
      to: ok[3],
      reachable: true,
      example_path: ok,
      path_edges: ok.slice(1).map((to, i) => [ok[i], to] as [string, string]),
    },
  } as DependencyPathTask;

  it("rejects skipped hops, wrong ends and non-edges, and normalizes path spellings", () => {
    expect(validateImportPath(t, ok).valid).toBe(true);
    expect(validateImportPath(t, ok.map((f) => `./${f.replace(/\//g, "\\")}`)).valid).toBe(true);
    expect(validateImportPath(t, [ok[0], ok[2], ok[3]]).reason).toBe("no import src/paths/start.ts -> src/paths/s2.ts");
    expect(validateImportPath(t, ok.slice(1)).valid).toBe(false);
    expect(validateImportPath(t, ok.slice(0, -1)).valid).toBe(false);
  });
});

describe("validators", () => {
  const set = generateTasks({ tsconfigPath: TSCONFIG, repo: "fixture/taskgen-repo", idPrefix: "fx", maxPerCategory: 1 });
  const cycle = set.tasks.find((t): t is CycleTraceTask => t.category === "cycle_trace")!;
  const impact = set.tasks.find((t): t is ImpactTask => t.category === "change_impact")!;
  const traps = generateTasks({ tsconfigPath: TSCONFIG, repo: "fixture/taskgen-repo", idPrefix: "fx" }).tasks.filter(
    (t): t is TrapTask => t.category === "runtime_type_trap"
  );

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

  it("grades a yes against the oracle's answer", () => {
    const yes = traps.find((t) => t.expected.answer)!;
    expect(validateTrapAnswer(yes, true).valid).toBe(true);
    expect(validateTrapAnswer(yes, false, "both").valid).toBe(false);
  });

  it("requires a no to name the direction with no runtime path, so a blanket 'no' can't score", () => {
    // trap/ is e -> f -> g -> h at runtime, with h -> e type-only: exactly one
    // direction of every pair is a runtime path.
    for (const no of traps.filter((t) => !t.expected.answer)) {
      const { runtime_a_to_b, runtime_b_to_a } = no.expected;
      expect(runtime_a_to_b !== runtime_b_to_a).toBe(true);
      const broken = runtime_a_to_b ? "b_to_a" : "a_to_b";
      const other = runtime_a_to_b ? "a_to_b" : "b_to_a";
      expect(validateTrapAnswer(no, false, broken).valid).toBe(true);
      expect(validateTrapAnswer(no, false, other).valid).toBe(false);
      expect(validateTrapAnswer(no, false, "both").valid).toBe(false);
      expect(validateTrapAnswer(no, false)).toMatchObject({ valid: false, reason: expect.stringContaining(broken) });
      expect(validateTrapAnswer(no, true).valid).toBe(false);
    }
  });

  it("grades task files that predate the direction fields on yes/no alone", () => {
    const no = traps.find((t) => !t.expected.answer)!;
    const legacy: TrapTask = {
      ...no,
      expected: { ...no.expected, runtime_a_to_b: undefined, runtime_b_to_a: undefined },
    };
    expect(validateTrapAnswer(legacy, false).valid).toBe(true);
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
