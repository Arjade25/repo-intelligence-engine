import type Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { openDb } from "../storage/db.js";
import { indexRepository, normalizePath } from "../indexer/index.js";
import { describeUnresolved } from "../indexer/resolution.js";
import { cycleHops, findCircularDependencies } from "../engine/index.js";

/**
 * rie check: does a PR make the runtime import-cycle structure worse than its base?
 *
 * Both snapshots are indexed in full (symbols and edges; references aren't
 * needed), and their runtime cycle groups - strongly connected components over
 * imports that survive compilation - are compared. Groups are matched by shared
 * files after mapping renamed files through git's rename detection. Each PR group
 * and each base group then gives at most one event (see CycleEventType). Old
 * cycles never fail a PR: only a change between base and PR does.
 *
 * Findings carry evidence: for each runtime import the PR added inside a cycle
 * group, the shortest loop that takes it, with the statement behind each hop.
 * The rules are pinned down as test cases in cycle-events.cases.ts.
 */

export type Outcome = "fail" | "warn" | "pass";

export type CycleEventType =
  /** A group appears whose files were in no cycle on base. */
  | "new_cycle"
  /** An existing group gains files. */
  | "cycle_grown"
  /** Two or more base groups become one. */
  | "cycles_merged"
  /** No file joins or leaves a group, but a new import makes a shorter loop through some file. */
  | "loop_shortened"
  /** One base group becomes two or more smaller groups, and no file joins. */
  | "cycle_split"
  /** Files leave a group that still exists. */
  | "cycle_shrunk"
  /** A base group no longer exists. */
  | "cycle_resolved"
  /** No other event fired. */
  | "no_regression";

export const DEFAULT_OUTCOMES: Record<CycleEventType, Outcome> = {
  new_cycle: "fail",
  cycle_grown: "fail",
  cycles_merged: "fail",
  loop_shortened: "warn",
  cycle_split: "pass",
  cycle_shrunk: "pass",
  cycle_resolved: "pass",
  no_regression: "pass",
};

export interface EvidenceHop {
  /** "file:line" of the import or re-export behind this hop. */
  at: string;
  /** That statement's text, whitespace-collapsed. */
  statement: string | null;
  /** The imported names that survive compilation, when the statement names any. */
  runtime_names?: string[];
  /** On a PR finding: whether the PR added this file pair's import (it isn't in the base graph). */
  added?: boolean;
}

export interface Evidence {
  /** Starts and ends with the same file. */
  loop: string[];
  /** hops[i] is loop[i] -> loop[i + 1]. */
  hops: EvidenceHop[];
}

export interface CycleEvent {
  type: CycleEventType;
  outcome: Outcome;
  /** The base groups this event is about, in base paths. */
  base_groups?: string[][];
  /** The PR groups this event is about. */
  pr_groups?: string[][];
  /** Files in a PR group that were in no base group. */
  joined?: string[];
  /** Files of a base group that are in no PR group, in base paths. */
  left?: string[];
  /** loop_shortened: every file whose shortest loop got shorter. */
  shortened?: { file: string; base_length: number; pr_length: number }[];
  /** Fail and warn events only. */
  evidence?: Evidence[];
}

export interface CycleCheckInput {
  /** tsconfig of the base snapshot. */
  base: string;
  /** tsconfig of the PR snapshot. */
  pr: string;
  /** Renamed files, base path -> PR path, relative to each snapshot's tsconfig directory. */
  renames?: Record<string, string>;
  /** Per-repo outcome overrides, e.g. { cycle_grown: "warn" }. */
  outcomes?: Partial<Record<CycleEventType, Outcome>>;
}

export interface CycleCheckResult {
  /** The strictest event's outcome: fail > warn > pass. */
  outcome: Outcome;
  events: CycleEvent[];
  /** Runtime cycle groups of each snapshot, largest first. */
  groups: { base: string[][]; pr: string[][] };
  /** Problems that make the result less trustworthy, such as imports that don't resolve. */
  warnings: string[];
}

export interface RuntimeEdge {
  from: string;
  to: string;
  /** The pair's first import line; 0 when the graph's source has no lines (the emit oracle, madge). */
  line: number;
}

/**
 * A runtime import graph, every path relative to the tsconfig directory. Events
 * can be computed from any source of one: RIE's index here, or the emit oracle and
 * madge in the history replay (benchmarks/replay).
 */
export interface CycleGraph {
  /** Runtime cycle groups, each sorted, largest first. */
  groups: string[][];
  /** Runtime imports, one per file pair, at the pair's first line. */
  edges: RuntimeEdge[];
  /** Runtime successors of each file, sorted, so loops are deterministic. */
  next: Map<string, string[]>;
}

/** Successor lists for a graph's edges, sorted. */
export function successors(edges: RuntimeEdge[]): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  for (const list of next.values()) list.sort();
  return next;
}

/** One snapshot indexed by RIE: a CycleGraph plus the index, which the evidence's import lines come from. */
export interface Snapshot extends CycleGraph {
  db: Database.Database;
  /** The snapshot's paths as the index stores them, by relative path. */
  stored: Map<string, string>;
  unresolved: number;
  unresolvedSummary: string;
}

export function indexSnapshot(tsconfigPath: string): Snapshot {
  const db = openDb(":memory:");
  const { unresolved } = indexRepository(db, tsconfigPath);
  const root = normalizePath(dirname(resolve(tsconfigPath))).replace(/\/+$/, "") + "/";
  const stored = new Map<string, string>();
  const rel = (p: string) => {
    const r = p.toLowerCase().startsWith(root.toLowerCase()) ? p.slice(root.length) : p;
    stored.set(r, p);
    return r;
  };

  const groups = findCircularDependencies(db).map((g) => g.files.map(rel).sort());
  const rows = db
    .prepare(
      `SELECT from_file, to_file, MIN(line) AS line FROM edges WHERE is_type_only = 0
        GROUP BY from_file, to_file`
    )
    .all() as { from_file: string; to_file: string; line: number | null }[];
  const edges = rows.map((r) => ({ from: rel(r.from_file), to: rel(r.to_file), line: r.line ?? 0 }));

  return {
    db,
    stored,
    groups,
    edges,
    next: successors(edges),
    unresolved: unresolved.length,
    unresolvedSummary: unresolved.length > 0 ? describeUnresolved(unresolved) : "",
  };
}

/** Shortest path from `from` to `to` (both included), or null. */
function shortestPath(next: Map<string, string[]>, from: string, to: string): string[] | null {
  const parent = new Map<string, string>();
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (at === to) {
      const path = [to];
      while (path[0] !== from) path.unshift(parent.get(path[0])!);
      return path;
    }
    for (const n of next.get(at) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      parent.set(n, at);
      queue.push(n);
    }
  }
  return null;
}

/** Files on the shortest loop through `file`; 0 when it is in none. */
export function shortestLoopLength(snapshot: Pick<CycleGraph, "next">, file: string): number {
  let best = Infinity;
  for (const n of snapshot.next.get(file) ?? []) {
    const back = n === file ? [file] : shortestPath(snapshot.next, n, file);
    if (back) best = Math.min(best, back.length);
  }
  return Number.isFinite(best) ? best : 0;
}

/** The loop through `from -> to` and the import behind each hop. */
export function loopEvidence(snapshot: Snapshot, from: string, to: string): Evidence | null {
  const back = to === from ? [from] : shortestPath(snapshot.next, to, from);
  if (!back) return null;
  const loop = [from, ...back];
  const relOf = new Map([...snapshot.stored].map(([r, abs]) => [abs, r]));
  const hops = cycleHops(
    snapshot.db,
    loop.map((f) => snapshot.stored.get(f)!),
    false,
    (p) => relOf.get(p) ?? p
  ).map(({ at, statement, runtime_names }) => ({ at, statement, ...(runtime_names && { runtime_names }) }));
  return { loop, hops };
}

const RANK: Record<Outcome, number> = { pass: 0, warn: 1, fail: 2 };
const key = (from: string, to: string) => `${from}\u0000${to}`;
const sortGroups = (groups: string[][]) => [...groups].sort((a, b) => a.join().localeCompare(b.join()));

/**
 * Compare two snapshots' runtime graphs. Evidence (the loop and the import line
 * behind each hop) needs the PR side's RIE index; for any other graph, such as the
 * emit oracle's, events come without it.
 */
export function compareSnapshots(
  base: CycleGraph,
  pr: CycleGraph | Snapshot,
  options: Pick<CycleCheckInput, "renames" | "outcomes"> = {}
): Omit<CycleCheckResult, "warnings"> {
  const renames = options.renames ?? {};
  const unrenames = Object.fromEntries(Object.entries(renames).map(([b, p]) => [p, b]));
  const toPr = (f: string) => renames[f] ?? f;
  const toBase = (f: string) => unrenames[f] ?? f;
  const outcomeOf = (type: CycleEventType) => options.outcomes?.[type] ?? DEFAULT_OUTCOMES[type];

  const baseSets = base.groups.map((g) => new Set(g.map(toPr)));
  const inBase = new Set(baseSets.flatMap((s) => [...s]));
  const inPr = new Set(pr.groups.flat());
  const baseEdges = new Set(base.edges.map((e) => key(toPr(e.from), toPr(e.to))));

  /** Each new runtime import inside the group, in (file, line) order, with the shortest loop through it; edges already on a loop are skipped. */
  const evidenceFor = (group: string[]): Evidence[] | undefined => {
    if (!("db" in pr)) return undefined;
    const members = new Set(group);
    const added = pr.edges
      .filter((e) => members.has(e.from) && members.has(e.to) && !baseEdges.has(key(e.from, e.to)))
      .sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line);
    const covered = new Set<string>();
    const out: Evidence[] = [];
    for (const e of added) {
      if (covered.has(key(e.from, e.to))) continue;
      const ev = loopEvidence(pr, e.from, e.to);
      if (!ev) continue;
      ev.loop.slice(1).forEach((to, i) => covered.add(key(ev.loop[i], to)));
      ev.hops = ev.hops.map((hop, i) => ({ ...hop, added: !baseEdges.has(key(ev.loop[i], ev.loop[i + 1])) }));
      out.push(ev);
    }
    return out;
  };

  const events: CycleEvent[] = [];
  const event = (type: CycleEventType, fields: Omit<CycleEvent, "type" | "outcome">, evidenceGroup?: string[]) => {
    const outcome = outcomeOf(type);
    const evidence = outcome !== "pass" && evidenceGroup ? evidenceFor(evidenceGroup) : undefined;
    events.push({ type, outcome, ...fields, ...(evidence && { evidence }) });
  };

  // PR side: groups that are new, grew or merged.
  const prInfo = pr.groups.map((group) => ({
    group,
    overlaps: baseSets.flatMap((s, i) => (group.some((f) => s.has(f)) ? [i] : [])),
    joined: group.filter((f) => !inBase.has(f)).sort(),
  }));
  for (const { group, overlaps, joined } of prInfo) {
    const baseGroups = sortGroups(overlaps.map((i) => base.groups[i]));
    if (overlaps.length === 0) event("new_cycle", { base_groups: [], pr_groups: [group], joined }, group);
    else if (overlaps.length > 1) event("cycles_merged", { base_groups: baseGroups, pr_groups: [group], joined }, group);
    else if (joined.length > 0) event("cycle_grown", { base_groups: baseGroups, pr_groups: [group], joined }, group);
  }

  // Base side: groups that resolved, split, shrank, or kept their files but gained a shorter loop.
  base.groups.forEach((group, i) => {
    const images = prInfo.filter((p) => p.overlaps.includes(i));
    const left = group.filter((f) => !inPr.has(toPr(f))).sort();
    if (images.length === 0) {
      event("cycle_resolved", { base_groups: [group], pr_groups: [], left });
      return;
    }
    // A group that grew or merged was reported above; the rest only lose files or loops.
    if (images.some((p) => p.overlaps.length > 1 || p.joined.length > 0)) return;
    const prGroups = sortGroups(images.map((p) => p.group));
    if (images.length > 1) {
      event("cycle_split", { base_groups: [group], pr_groups: prGroups, ...(left.length > 0 && { left }) });
    } else if (left.length > 0) {
      event("cycle_shrunk", { base_groups: [group], pr_groups: prGroups, left });
    } else {
      const shortened = images[0].group
        .map((file) => ({ file, base_length: shortestLoopLength(base, toBase(file)), pr_length: shortestLoopLength(pr, file) }))
        .filter((x) => x.pr_length < x.base_length);
      if (shortened.length > 0) event("loop_shortened", { base_groups: [group], pr_groups: prGroups, shortened }, images[0].group);
    }
  });

  if (events.length === 0) events.push({ type: "no_regression", outcome: outcomeOf("no_regression") });
  const outcome = events.reduce<Outcome>((worst, e) => (RANK[e.outcome] > RANK[worst] ? e.outcome : worst), "pass");
  return { outcome, events, groups: { base: base.groups, pr: pr.groups } };
}

/** A check whose indexes are still open, for a caller that keeps querying them (the investigation agent). Close both when done. */
export interface OpenCheck {
  result: CycleCheckResult;
  base: Snapshot;
  pr: Snapshot;
}

/** Index both snapshots and compare them, leaving both indexes open. */
export function checkCyclesOpen(input: CycleCheckInput): OpenCheck {
  const base = indexSnapshot(input.base);
  const pr = indexSnapshot(input.pr);
  try {
    const warnings: string[] = [];
    for (const [name, s] of [["base", base], ["PR", pr]] as const) {
      if (s.unresolved > 0) {
        warnings.push(`${s.unresolved} internal import(s) don't resolve in the ${name} snapshot, so its graph is missing edges:\n${s.unresolvedSummary}`);
      }
    }
    return { result: { ...compareSnapshots(base, pr, input), warnings }, base, pr };
  } catch (e) {
    base.db.close();
    pr.db.close();
    throw e;
  }
}

/** Index both snapshots and compare them. */
export function checkCycles(input: CycleCheckInput): CycleCheckResult {
  const { result, base, pr } = checkCyclesOpen(input);
  base.db.close();
  pr.db.close();
  return result;
}
