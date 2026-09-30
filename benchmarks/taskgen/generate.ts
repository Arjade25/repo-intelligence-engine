import ts from "typescript";
import { relative } from "node:path";
import { computeEmittedEdges } from "../oracle/emitted-edges.js";
import { findStronglyConnectedComponents } from "../oracle/tarjan.js";
import { bfsDepths, bfsParents, buildAdjacency, pathTo, shortestCycleThrough, type Adjacency } from "./graph.js";
import { ImpactOracle } from "./impact.js";
import { describeUnresolved, findUnresolvedInternalImports } from "../../src/indexer/resolution.js";

/**
 * Task generator (plan step 3) for four categories: 1 cycle tracing, 2 dependency
 * paths, 3 runtime-vs-type traps, 4 change impact. All ground truth comes from the oracle
 * package (real emitted JS) and ImpactOracle (a real re-type-check), never from
 * RIE's index. Every task also records the tsconfig flags that decided which edges
 * are runtime edges, since changing those flags changes the answers.
 *
 * `minPath` is the plan's "must force traversal" filter: a task is dropped if the
 * files it hinges on number fewer than minPath (the cycle length, the round-trip
 * length for a trap pair, or the impacted file count). Dependency paths use their
 * own `minHops`, since a repo whose cycles are short can still have long chains.
 * Selection among the survivors is a seeded shuffle, so the same repo, commit and
 * seed always produce the same task set.
 */

export interface GenerateOptions {
  tsconfigPath: string;
  /** Repo label written into every task, e.g. "nestjs/nest@40d07dc6...". */
  repo: string;
  /** Task id prefix, e.g. "nest" -> "nest-cycle-trace-001". */
  idPrefix: string;
  seed?: number;
  minPath?: number;
  maxPerCategory?: number;
  /** How many top-ranked (file, export) pairs get a full re-type-check. Each costs one whole-program check. */
  maxImpactCandidates?: number;
  /** Shortest import chain a reachable dependency-path task must have (default 5). */
  minHops?: number;
  /** Files an unreachable dependency-path task's start must transitively import (default 25). */
  minClosure?: number;
  /** Generate even if some internal imports don't resolve. Off by default: those answers would be wrong. */
  allowUnresolved?: boolean;
}

export interface GraphDifficulty {
  scc_size: number;
  min_path: number;
  barrels: boolean;
  aliases: boolean;
  type_distractors: number;
}

export interface ImpactDifficulty {
  impacted_files: number;
  direct_importers: number;
  via_reexport: number;
  reexport_hops: number;
  barrels: boolean;
  aliases: boolean;
}

export interface PathDifficulty {
  /** Shortest chain length in hops; null when the target is unreachable. */
  min_hops: number | null;
  /** Files the start transitively imports - what an agent must rule out to answer "no". */
  closure_size: number;
  barrels: boolean;
  aliases: boolean;
  /** Hops on the example chain that are type-only imports (still valid: the question is about imports). */
  type_only_hops: number;
  /** Unreachable only: the target DOES reach the start, so a direction mix-up gives the wrong answer. */
  reverse_path: boolean;
}

export type TsconfigFlags = Record<string, boolean | string | null>;

interface TaskBase {
  id: string;
  repo: string;
  prompt: string;
  tsconfig_flags: TsconfigFlags;
}

export interface CycleTraceTask extends TaskBase {
  category: "cycle_trace";
  validator: "runtime_cycle_path";
  difficulty: GraphDifficulty;
  expected: {
    start: string;
    example_cycle: string[];
    scc_members: string[];
    scc_runtime_edges: [string, string][];
  };
}

export interface TrapTask extends TaskBase {
  category: "runtime_type_trap";
  validator: "runtime_cycle_yes_no";
  difficulty: GraphDifficulty;
  expected: {
    answer: boolean;
    a: string;
    b: string;
    /** Shortest paths each way - over runtime edges for "yes", over source edges (incl. erased) for "no". */
    graph: "runtime" | "source";
    a_to_b: string[];
    b_to_a: string[];
    /**
     * Whether each direction has a runtime import path (both true for "yes"). A "no"
     * answer must name the direction(s) that fail: yes/no alone let an agent that
     * always answers "no" score 100% on a repo with no runtime cycles (TypeORM,
     * Babylon.js). Absent from task files generated before this was added.
     */
    runtime_a_to_b?: boolean;
    runtime_b_to_a?: boolean;
  };
}

export interface ImpactTask extends TaskBase {
  category: "change_impact";
  validator: "compile_impact_set";
  difficulty: ImpactDifficulty;
  expected: { file: string; symbol: string; files: string[] };
}

export interface DependencyPathTask extends TaskBase {
  category: "dependency_path";
  validator: "import_path";
  difficulty: PathDifficulty;
  expected: {
    from: string;
    to: string;
    reachable: boolean;
    /** One shortest chain, or null when unreachable. */
    example_path: string[] | null;
    /** Every source edge on SOME from->to chain, so any valid chain can be checked, not just the example. */
    path_edges: [string, string][];
  };
}

export type Task = CycleTraceTask | DependencyPathTask | TrapTask | ImpactTask;

interface CategoryStats {
  candidates: number;
  passed_min_path: number;
  emitted: number;
}

export interface GeneratedTaskSet {
  generated_by: string;
  repo: string;
  tsconfig_flags: TsconfigFlags;
  params: {
    seed: number;
    min_path: number;
    min_hops: number;
    min_closure: number;
    max_per_category: number;
    max_impact_candidates: number;
  };
  stats: {
    files: number;
    runtime_edges: number;
    source_edges: number;
    runtime_sccs: number[];
    source_sccs: number[];
    cycle_trace: CategoryStats;
    dependency_path: CategoryStats & { reachable_candidates: number; unreachable_candidates: number; max_hops: number };
    runtime_type_trap: CategoryStats & { true_candidates: number; false_candidates: number };
    change_impact: CategoryStats & { dropped_broken_reexport: number };
  };
  tasks: Task[];
}

const pairKey = (from: string, to: string) => `${from}\u0000${to}`;

export function generateTasks(opts: GenerateOptions): GeneratedTaskSet {
  const seed = opts.seed ?? 1;
  const minPath = opts.minPath ?? 4;
  const maxPerCategory = opts.maxPerCategory ?? 10;
  const maxImpactCandidates = opts.maxImpactCandidates ?? 15;
  const minHops = opts.minHops ?? 5;
  const minClosure = opts.minClosure ?? 25;

  // Checked first, before any ground truth is computed: an internal import the
  // compiler can't resolve is a baseline type error, so the impact oracle can't see
  // anything break through it and the emitted-edge graph silently loses it. This is
  // how nest's change-impact answers once lost every cross-package importer.
  const impact = new ImpactOracle(opts.tsconfigPath);
  const unresolved = findUnresolvedInternalImports(impact.program);
  if (unresolved.length > 0 && !opts.allowUnresolved) {
    throw new Error(`${describeUnresolved(unresolved)}\n(pass --allow-unresolved to generate anyway)`);
  }

  const oracle = computeEmittedEdges(opts.tsconfigPath);
  const root = oracle.rootDir;
  const rel = (p: string) => (p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
  const abs = (p: string) => `${root}/${p}`;

  const runtimeEdges = oracle.edges.map((e) => ({ from: rel(e.from), to: rel(e.to) }));
  const sourceEdges = oracle.sourceEdges.map((e) => ({ ...e, from: rel(e.from), to: rel(e.to) }));
  const runtimeAdj = buildAdjacency(runtimeEdges);
  const sourceAdj = buildAdjacency(sourceEdges);
  const runtimePairs = new Set(runtimeEdges.map((e) => pairKey(e.from, e.to)));

  const typeOnlyOut = new Map<string, number>();
  for (const [from, tos] of sourceAdj) {
    typeOnlyOut.set(from, tos.filter((to) => !runtimePairs.has(pairKey(from, to))).length);
  }
  const barrels = new Set(sourceEdges.filter((e) => e.kind === "reexport").map((e) => e.from));
  // A non-relative specifier that still resolved inside the repo is a path alias.
  const aliasPairs = new Set(sourceEdges.filter((e) => !e.specifier.startsWith(".")).map((e) => pairKey(e.from, e.to)));

  const pathTags = (paths: string[][]) => {
    const files = new Set(paths.flat());
    const hops = paths.flatMap((p) => p.slice(1).map((to, i) => [p[i], to] as const));
    return {
      barrels: [...files].some((f) => barrels.has(f)),
      aliases: hops.some(([a, b]) => aliasPairs.has(pairKey(a, b))),
      type_distractors: [...files].reduce((n, f) => n + (typeOnlyOut.get(f) ?? 0), 0),
    };
  };

  const flags = pickFlags(oracle.compilerOptions);
  const scope = scopeSentence(opts.tsconfigPath, root);
  const base = (id: string, prompt: string): TaskBase => ({ id, repo: opts.repo, prompt: `${prompt} ${scope}`, tsconfig_flags: flags });
  const taskId = (category: string, i: number) => `${opts.idPrefix}-${category}-${String(i + 1).padStart(3, "0")}`;

  const runtimeSccs = findStronglyConnectedComponents(runtimeEdges);
  const sourceSccs = findStronglyConnectedComponents(sourceEdges);

  // --- Category 1: cycle tracing -------------------------------------------------
  const cycleCandidates: { start: string; cycle: string[]; members: string[]; edges: [string, string][] }[] = [];
  let cycleTotal = 0;
  for (const scc of runtimeSccs) {
    const members = new Set(scc.files);
    const edges = runtimeEdges
      .filter((e) => members.has(e.from) && members.has(e.to))
      .map((e) => [e.from, e.to] as [string, string]);
    const sccEdges = [...new Map(edges.map((e) => [pairKey(...e), e])).values()].sort();
    for (const start of scc.files) {
      cycleTotal++;
      const cycle = shortestCycleThrough(runtimeAdj, start, members)!;
      if (cycle.length - 1 >= minPath) cycleCandidates.push({ start, cycle, members: scc.files, edges: sccEdges });
    }
  }
  const cycleTasks: CycleTraceTask[] = shuffle(cycleCandidates, mulberry32(seed))
    .slice(0, maxPerCategory)
    .map((c, i) => ({
      ...base(
        taskId("cycle-trace", i),
        `Starting from ${c.start}, give a chain of runtime imports that leads back to ${c.start}. ` +
          `Only count imports that survive compilation to JavaScript - an import TypeScript erases because ` +
          `it is only used as a type does not count. List the files in order, starting and ending with ${c.start}.`
      ),
      category: "cycle_trace",
      validator: "runtime_cycle_path",
      difficulty: { scc_size: c.members.length, min_path: c.cycle.length - 1, ...pathTags([c.cycle]) },
      expected: { start: c.start, example_cycle: c.cycle, scc_members: c.members, scc_runtime_edges: c.edges },
    }));

  // --- Category 2: dependency paths ----------------------------------------------
  // "Does A import B, directly or through other files?" over SOURCE edges - every
  // static import and re-export, type-only included, because the question is about
  // imports, not runtime (the traps cover that). A reachable pair needs a shortest
  // chain of at least minHops. An unreachable pair needs a start that transitively
  // imports at least minClosure files, since answering "no" means ruling out every
  // one of them - the prove-a-negative shape reading files can't do cheaply.
  const reverseAdj = buildAdjacency(sourceEdges.map((e) => ({ from: e.to, to: e.from })));
  const nodes = [...new Set(sourceEdges.flatMap((e) => [e.from, e.to]))].sort();
  const depthsFrom = new Map(nodes.map((f) => [f, bfsDepths(sourceAdj, f)]));
  const dirOf = (f: string) => f.slice(0, f.lastIndexOf("/"));
  const reachCands: { from: string; to: string; hops: number }[] = [];
  const unreachCands: { from: string; to: string; closure: number; reverse: boolean }[] = [];
  let reachablePairs = 0;
  let maxHops = 0;
  for (const from of nodes) {
    const depths = depthsFrom.get(from)!;
    for (const [to, hops] of depths) {
      if (hops === 0) continue;
      reachablePairs++;
      maxHops = Math.max(maxHops, hops);
      if (hops >= minHops) reachCands.push({ from, to, hops });
    }
    const closure = depths.size - 1;
    if (closure < minClosure) continue;
    // Near misses only: the target sits in a directory the start's imports reach
    // into and has several importers of its own, so no single grep settles it.
    const reachedDirs = new Set([...depths.keys()].map(dirOf));
    for (const to of nodes) {
      if (depths.has(to) || !reachedDirs.has(dirOf(to)) || (reverseAdj.get(to)?.length ?? 0) < 3) continue;
      unreachCands.push({ from, to, closure, reverse: depthsFrom.get(to)!.has(from) });
    }
  }

  // One task per start and per target, so the set doesn't collapse onto one chain.
  const pickDistinct = <T extends { from: string; to: string }>(xs: T[], n: number): T[] => {
    const usedFrom = new Set<string>();
    const usedTo = new Set<string>();
    const out: T[] = [];
    for (const x of xs) {
      if (out.length >= n) break;
      if (usedFrom.has(x.from) || usedTo.has(x.to)) continue;
      usedFrom.add(x.from);
      usedTo.add(x.to);
      out.push(x);
    }
    return out;
  };
  const pathRng = mulberry32(seed + 2);
  const nReach = Math.min(reachCands.length, Math.ceil(maxPerCategory / 2));
  const nUnreach = Math.min(unreachCands.length, maxPerCategory - nReach);
  // Longest chains first; for "no", pairs where the REVERSE path exists first (a
  // direction mix-up then gives the wrong answer), then the biggest closure.
  const reachPick = pickDistinct(
    shuffle(reachCands, pathRng).sort((x, y) => y.hops - x.hops),
    nReach
  );
  const unreachPick = pickDistinct(
    shuffle(unreachCands, pathRng).sort((x, y) => Number(y.reverse) - Number(x.reverse) || y.closure - x.closure),
    nUnreach
  );

  // Every edge on SOME from->to chain: a -> b with a reachable from `from` and `to`
  // reachable from b. Enough to validate any chain an agent gives, not just ours.
  const pathEdgesBetween = (from: string, to: string): [string, string][] => {
    const fwd = depthsFrom.get(from)!;
    const bwd = bfsDepths(reverseAdj, to);
    const out: [string, string][] = [];
    for (const [a, tos] of sourceAdj) {
      if (!fwd.has(a)) continue;
      for (const b of tos) if (bwd.has(b)) out.push([a, b]);
    }
    return out.sort();
  };

  const pathTasks: DependencyPathTask[] = shuffle(
    [...reachPick.map((c) => ({ c, reachable: true })), ...unreachPick.map((c) => ({ c, reachable: false }))],
    pathRng
  ).map(({ c, reachable }, i) => {
    const example = reachable ? pathTo(bfsParents(sourceAdj, c.from), c.to) : null;
    const tags = example ? pathTags([example]) : undefined;
    return {
      ...base(
        taskId("dependency-path", i),
        `Does ${c.from} depend on ${c.to} through imports? That is, can you get from ${c.from} to ${c.to} by ` +
          `following import statements, \`import x = require()\` and \`export ... from\` re-exports, one file at a time? ` +
          `Type-only imports count; dynamic import() calls do not. If yes, give one such chain of files, starting ` +
          `with ${c.from} and ending with ${c.to}.`
      ),
      category: "dependency_path",
      validator: "import_path",
      difficulty: {
        min_hops: example ? example.length - 1 : null,
        closure_size: depthsFrom.get(c.from)!.size - 1,
        barrels: tags?.barrels ?? false,
        aliases: tags?.aliases ?? false,
        type_only_hops: example ? example.slice(1).filter((to, k) => !runtimePairs.has(pairKey(example[k], to))).length : 0,
        reverse_path: !reachable && depthsFrom.get(c.to)!.has(c.from),
      },
      expected: {
        from: c.from,
        to: c.to,
        reachable,
        example_path: example,
        path_edges: reachable ? pathEdgesBetween(c.from, c.to) : [],
      },
    };
  });

  // --- Category 3: runtime-vs-type traps -----------------------------------------
  interface PairCandidate {
    a: string;
    b: string;
    ab: string[];
    ba: string[];
    sccSize: number;
    oneWay: boolean;
  }
  const runtimeSccOf = new Map<string, number>();
  runtimeSccs.forEach((scc, i) => scc.files.forEach((f) => runtimeSccOf.set(f, i)));

  const roundTrips = (files: string[], adj: Adjacency) => {
    const members = new Set(files);
    const parents = new Map(files.map((f) => [f, bfsParents(adj, f, members)]));
    const out: { a: string; b: string; ab: string[]; ba: string[] }[] = [];
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const [a, b] = [files[i], files[j]];
        out.push({ a, b, ab: pathTo(parents.get(a)!, b)!, ba: pathTo(parents.get(b)!, a)! });
      }
    }
    return out;
  };
  const tripLength = (p: { ab: string[]; ba: string[] }) => p.ab.length - 1 + (p.ba.length - 1);

  const runtimeReach = new Map<string, Map<string, string | null>>();
  const reaches = (from: string, to: string) => {
    if (!runtimeReach.has(from)) runtimeReach.set(from, bfsParents(runtimeAdj, from));
    return runtimeReach.get(from)!.has(to);
  };

  let trapTotal = 0;
  const trueCands: PairCandidate[] = [];
  for (const scc of runtimeSccs) {
    for (const p of roundTrips(scc.files, runtimeAdj)) {
      trapTotal++;
      if (tripLength(p) >= minPath) trueCands.push({ ...p, sccSize: scc.files.length, oneWay: false });
    }
  }
  const falseCands: PairCandidate[] = [];
  for (const scc of sourceSccs) {
    for (const p of roundTrips(scc.files, sourceAdj)) {
      const ra = runtimeSccOf.get(p.a);
      if (ra !== undefined && ra === runtimeSccOf.get(p.b)) continue; // a genuine "yes", counted above
      trapTotal++;
      if (tripLength(p) >= minPath) {
        falseCands.push({ ...p, sccSize: scc.files.length, oneWay: reaches(p.a, p.b) || reaches(p.b, p.a) });
      }
    }
  }

  const trapRng = mulberry32(seed + 1);
  const nTrue = Math.min(trueCands.length, Math.ceil(maxPerCategory / 2));
  const nFalse = Math.min(falseCands.length, maxPerCategory - nTrue);
  // A pair where one direction really is a runtime path is the convincing trap:
  // the agent can find half a cycle and has to notice the other half is erased.
  const falsePick = shuffle(falseCands, trapRng)
    .sort((x, y) => Number(y.oneWay) - Number(x.oneWay))
    .slice(0, nFalse)
    .map((c) => ({ c, answer: false }));
  const truePick = shuffle(trueCands, trapRng)
    .slice(0, nTrue)
    .map((c) => ({ c, answer: true }));
  const trapTasks: TrapTask[] = shuffle([...truePick, ...falsePick], trapRng).map(({ c, answer }, i) => ({
    ...base(
      taskId("type-trap", i),
      `Is there a runtime circular dependency between ${c.a} and ${c.b}? That is, can each file reach ` +
        `the other through imports that survive compilation to JavaScript, ignoring imports TypeScript ` +
        `erases because they are only used as types? Answer yes or no. If yes, give the import chain in each direction. ` +
        `If no, say which direction has no such runtime path: from ${c.a} to ${c.b}, from ${c.b} to ${c.a}, or both.`
    ),
    category: "runtime_type_trap",
    validator: "runtime_cycle_yes_no",
    difficulty: { scc_size: c.sccSize, min_path: tripLength(c), ...pathTags([c.ab, c.ba]) },
    expected: {
      answer,
      a: c.a,
      b: c.b,
      graph: answer ? "runtime" : "source",
      a_to_b: c.ab,
      b_to_a: c.ba,
      runtime_a_to_b: answer || reaches(c.a, c.b),
      runtime_b_to_a: answer || reaches(c.b, c.a),
    },
  }));

  // --- Category 4: change impact -------------------------------------------------
  const importersOf = new Map<string, Set<string>>();
  const reexportersOf = new Map<string, Set<string>>();
  for (const e of sourceEdges) {
    if (!importersOf.has(e.to)) importersOf.set(e.to, new Set());
    importersOf.get(e.to)!.add(e.from);
    if (e.kind === "reexport") {
      if (!reexportersOf.has(e.to)) reexportersOf.set(e.to, new Set());
      reexportersOf.get(e.to)!.add(e.from);
    }
  }
  const barrelsOf = (file: string) => {
    const seen = new Set<string>();
    const queue = [file];
    for (let i = 0; i < queue.length; i++) {
      for (const r of reexportersOf.get(queue[i]) ?? []) {
        if (!seen.has(r) && r !== file) {
          seen.add(r);
          queue.push(r);
        }
      }
    }
    return seen;
  };

  const mentions = (file: string, name: string) =>
    new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`).test(impact.program.getSourceFile(abs(file))?.text ?? "");

  // Cheap ranking first, since each real check re-type-checks the whole program:
  // count files that can see the export (import the file, or a barrel re-exporting
  // it) and whose text names the symbol at all.
  const ranked: { file: string; name: string; score: number }[] = [];
  for (const sf of impact.sourceFiles()) {
    const file = rel(sf.fileName.replace(/\\/g, "/"));
    const visible = new Set(importersOf.get(file) ?? []);
    for (const barrel of barrelsOf(file)) for (const f of importersOf.get(barrel) ?? []) visible.add(f);
    visible.delete(file);
    for (const decl of impact.exportedDeclarations(sf.fileName)) {
      let score = 0;
      for (const f of visible) if (mentions(f, decl.name)) score++;
      if (score >= minPath) ranked.push({ file, name: decl.name, score });
    }
  }
  ranked.sort((x, y) => y.score - x.score || x.file.localeCompare(y.file) || x.name.localeCompare(y.name));

  const impactTasks: ImpactTask[] = [];
  let impactEvaluated = 0;
  let impactBrokenReexport = 0;
  for (const cand of ranked.slice(0, maxImpactCandidates)) {
    if (impactTasks.length >= maxPerCategory) break;
    impactEvaluated++;
    const files = impact.impactOfRemovingExport(abs(cand.file), cand.name).map(rel);
    if (files.length < minPath) continue;
    // A star re-export never errors when a name goes missing, so an impacted file
    // that re-exports from the chain is a NAMED re-export (`export { X } from`)
    // that broke. TypeScript's error recovery still resolves X through it, so its
    // importers compile - on nest's `Type` that shielded 73 files an agent reading
    // the imports would (reasonably) list. The answer is compiler-true but hinges
    // on recovery behaviour no one can predict from source, so drop the task - but
    // only if something is actually shielded: a broken re-export whose importers
    // never use X leaves an ordinary, fair answer.
    const chainFiles = new Set([cand.file, ...barrelsOf(cand.file)]);
    const brokenReexports = files.filter((f) => [...chainFiles].some((t) => reexportersOf.get(t)?.has(f)));
    const shielded = brokenReexports.some((r) =>
      [...(importersOf.get(r) ?? [])].some((f) => !files.includes(f) && !chainFiles.has(f) && mentions(f, cand.name))
    );
    if (shielded) {
      impactBrokenReexport++;
      continue;
    }

    const direct = files.filter((f) => importersOf.get(cand.file)?.has(f));
    const viaBarrel = files.filter((f) => f !== cand.file && !direct.includes(f));
    const hops = viaBarrel.map((f) => (pathTo(bfsParents(sourceAdj, f), cand.file)?.length ?? 2) - 2);
    impactTasks.push({
      ...base(
        taskId("change-impact", impactTasks.length),
        `If ${cand.name} stopped being exported from ${cand.file} (the declaration stays, only the export ` +
          `is removed), which files would fail to type-check? List every such file.`
      ),
      category: "change_impact",
      validator: "compile_impact_set",
      difficulty: {
        impacted_files: files.length,
        direct_importers: direct.length,
        via_reexport: viaBarrel.length,
        reexport_hops: Math.max(0, ...hops),
        barrels: viaBarrel.length > 0,
        aliases: files.some((f) => [...chainFiles].some((t) => aliasPairs.has(pairKey(f, t)))),
      },
      expected: { file: cand.file, symbol: cand.name, files },
    });
  }

  return {
    generated_by: "benchmarks/taskgen",
    repo: opts.repo,
    tsconfig_flags: flags,
    params: {
      seed,
      min_path: minPath,
      min_hops: minHops,
      min_closure: minClosure,
      max_per_category: maxPerCategory,
      max_impact_candidates: maxImpactCandidates,
    },
    stats: {
      files: oracle.fileCount,
      runtime_edges: runtimePairs.size,
      source_edges: new Set(sourceEdges.map((e) => pairKey(e.from, e.to))).size,
      runtime_sccs: runtimeSccs.map((s) => s.files.length),
      source_sccs: sourceSccs.map((s) => s.files.length),
      cycle_trace: { candidates: cycleTotal, passed_min_path: cycleCandidates.length, emitted: cycleTasks.length },
      dependency_path: {
        candidates: reachablePairs,
        passed_min_path: reachCands.length + unreachCands.length,
        reachable_candidates: reachCands.length,
        unreachable_candidates: unreachCands.length,
        max_hops: maxHops,
        emitted: pathTasks.length,
      },
      runtime_type_trap: {
        candidates: trapTotal,
        passed_min_path: trueCands.length + falseCands.length,
        true_candidates: trueCands.length,
        false_candidates: falseCands.length,
        emitted: trapTasks.length,
      },
      change_impact: {
        candidates: impactEvaluated,
        passed_min_path: impactTasks.length + impactBrokenReexport,
        dropped_broken_reexport: impactBrokenReexport,
        emitted: impactTasks.length,
      },
    },
    tasks: [...cycleTasks, ...pathTasks, ...trapTasks, ...impactTasks],
  };
}

/**
 * Every prompt names its scope. Ground truth only covers the files the tsconfig
 * includes, and an agent told "this repository" will reasonably also count spec
 * files and sibling projects - on nest that alone made correct answers grade wrong.
 */
function scopeSentence(tsconfigPath: string, repoRoot: string): string {
  const raw = ts.readConfigFile(tsconfigPath, ts.sys.readFile).config ?? {};
  const list = (xs: unknown) => (Array.isArray(xs) && xs.length > 0 ? xs.map((x) => `\`${x}\``).join(", ") : undefined);
  const name = relative(repoRoot, tsconfigPath).replace(/\\/g, "/");
  const include = list(raw.include) ?? list(raw.files) ?? "`**/*`";
  const exclude = list(raw.exclude);
  return (
    `Scope: only the files ${name} includes count (include ${include}${exclude ? `; exclude ${exclude}` : ""}); ` +
    `ignore every other file in the repository.`
  );
}

function pickFlags(o: ts.CompilerOptions): TsconfigFlags {
  return {
    module: o.module !== undefined ? ts.ModuleKind[o.module] : null,
    moduleResolution: o.moduleResolution !== undefined ? ts.ModuleResolutionKind[o.moduleResolution] : null,
    emitDecoratorMetadata: o.emitDecoratorMetadata === true,
    verbatimModuleSyntax: o.verbatimModuleSyntax === true,
    preserveValueImports: o.preserveValueImports === true,
    importsNotUsedAsValues:
      o.importsNotUsedAsValues !== undefined ? ts.ImportsNotUsedAsValues[o.importsNotUsedAsValues] : null,
    isolatedModules: o.isolatedModules === true,
    preserveConstEnums: o.preserveConstEnums === true,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rng: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
