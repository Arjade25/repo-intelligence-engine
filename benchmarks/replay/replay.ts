import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { compareSnapshots, indexSnapshot, type CycleEvent, type CycleGraph, type Outcome, type Snapshot } from "../../src/check/index.js";
import { parseRenames } from "../../src/check/git.js";
import { loadTsconfig, normalizePath } from "../../src/indexer/index.js";
import { dpdmGraph, eslintReports, madgeGraph, oracleGraph, type EslintReports } from "./graphs.js";
import { applySeed, pickSeeds, type Seed } from "./seed.js";

/**
 * History replay (plan, week 2): for each commit on a stretch of first-parent
 * history, compare it with its parent the way `rie check` compares a PR with its
 * base, three ways - RIE, the emit oracle (the labels) and madge - and record
 * every event, outcome and timing (dpdm and eslint no-cycle too, on request). Each snapshot is computed once: a commit's
 * parent is the previous commit, so walking forward reuses it.
 *
 * A commit that changes no file under the source directory can't change the
 * graph (the tsconfig is fixed), so it is recorded as unchanged without compute.
 * Dependencies are not installed per commit, the same as the benchmark runs:
 * imports of packages count as external on both sides.
 */

export type Tool = "rie" | "oracle" | "madge" | "dpdm" | "eslint";

export interface ToolResult {
  outcome: Outcome;
  /** "type base_groups pr_groups" per event, sorted - what is compared across tools. */
  events: string[];
  /** Full events (RIE's carry evidence). */
  detail: CycleEvent[];
  /** Milliseconds to build the commit's graph (and the parent's, when it wasn't reused). */
  ms: number;
  groups: number[];
}

export interface ReplayRecord {
  sha: string;
  parent: string;
  date: string;
  subject: string;
  /** More than one parent: a merge commit, compared with its first parent. */
  merge: boolean;
  status: "compared" | "unchanged" | "skipped";
  reason?: string;
  changed_files: number;
  renames: Record<string, string>;
  tools: Partial<Record<Tool, ToolResult>>;
  /** RIE's runtime edges against the oracle's, at this commit: a hidden edge could hide a cycle. */
  edges?: { agree: number; rie_only: number; oracle_only: number };
  unresolved?: { rie: number; oracle: number };
  /** Seeded cases only: the injected line. */
  seed?: Seed;
}

export interface ReplayOptions {
  /** The git checkout (sparse is fine). */
  repo: string;
  /** tsconfig path inside the repo, e.g. apps/web/tsconfig.rie.json. */
  tsconfig: string;
  /** Copied to `tsconfig` at every checkout, when the repo doesn't track one. */
  tsconfigFrom?: string;
  /** Oldest first. */
  commits: string[];
  tools: Tool[];
  /** Commits already recorded (resume). */
  skip?: Set<string>;
  onRecord?: (record: ReplayRecord) => void;
  log?: (line: string) => void;
}

function git(repo: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** The last `count` first-parent commits ending at `tip`, oldest first. */
export function firstParentCommits(repo: string, tip: string, count: number): string[] {
  return git(repo, ["rev-list", "--first-parent", `--max-count=${count}`, tip]).split("\n").filter(Boolean).reverse();
}

const eventKey = (e: CycleEvent) => `${e.type} ${JSON.stringify(e.base_groups ?? [])} ${JSON.stringify(e.pr_groups ?? [])}`;

type Graphs = Partial<Record<Tool, CycleGraph | Snapshot | EslintReports>> & { ms: Partial<Record<Tool, number>> };

const BUILD: Record<Tool, (tsconfigPath: string) => CycleGraph | Snapshot | EslintReports> = {
  rie: indexSnapshot,
  oracle: oracleGraph,
  madge: (t) => madgeGraph(t),
  dpdm: (t) => dpdmGraph(t),
  eslint: (t) => eslintReports(t),
};

function buildGraphs(tsconfigPath: string, tools: Tool[]): Graphs {
  const graphs: Graphs = { ms: {} };
  for (const tool of tools) {
    const t = Date.now();
    graphs[tool] = BUILD[tool](tsconfigPath);
    graphs.ms[tool] = Date.now() - t;
  }
  return graphs;
}

const release = (g: Graphs | undefined) => (g?.rie as Snapshot | undefined)?.db.close();

/**
 * no-cycle has no groups (see eslintReports), so it is compared the way a team
 * gates a PR with it: the PR fails when it has a reported import (importing file ->
 * imported file, after renames) that the base didn't. Its events are never the
 * oracle's event types, so the summary scores its outcome only.
 */
export function compareReports(before: EslintReports, after: EslintReports, renames: Record<string, string>): { outcome: Outcome; events: string[] } {
  const key = (from: string, to: string) => `${from} -> ${to}`;
  const base = new Set(before.reports.map((r) => key(renames[r.from] ?? r.from, renames[r.to] ?? r.to)));
  const added = after.reports.map((r) => key(r.from, r.to)).filter((k) => !base.has(k)).sort();
  return added.length > 0 ? { outcome: "fail", events: added.map((k) => `no_cycle_report_added ${k}`) } : { outcome: "pass", events: ["no_regression [] []"] };
}

function compareAll(before: Graphs, after: Graphs, tools: Tool[], renames: Record<string, string>, parentMs: boolean) {
  const out: Partial<Record<Tool, ToolResult>> = {};
  for (const tool of tools) {
    const ms = after.ms[tool]! + (parentMs ? before.ms[tool]! : 0);
    if (tool === "eslint") {
      const { outcome, events } = compareReports(before.eslint as EslintReports, after.eslint as EslintReports, renames);
      out.eslint = { outcome, events, detail: [], ms, groups: [] };
      continue;
    }
    const result = compareSnapshots(before[tool] as CycleGraph | Snapshot, after[tool] as CycleGraph | Snapshot, { renames });
    out[tool] = {
      outcome: result.outcome,
      events: result.events.map(eventKey).sort(),
      detail: result.events,
      ms,
      groups: result.groups.pr.map((g) => g.length),
    };
  }
  return out;
}

export interface SeedOptions {
  repo: string;
  tsconfig: string;
  tsconfigFrom?: string;
  /** The commit to seed. */
  commit: string;
  /** Pairs to pick; each gives one seed of every kind. */
  count: number;
  /** PRNG seed for the pair choice. */
  seed: number;
  tools: Tool[];
  onRecord?: (record: ReplayRecord) => void;
  log?: (line: string) => void;
}

/** Seeded cases (seed.ts): the commit is the base, and each seed is a one-line "PR" on top of it. */
export function replaySeeds(options: SeedOptions): ReplayRecord[] {
  const { repo, tools } = options;
  const log = options.log ?? (() => {});
  const tsconfigPath = join(repo, options.tsconfig);
  git(repo, ["checkout", "-q", "--detach", "--force", options.commit]);
  if (options.tsconfigFrom) copyFileSync(options.tsconfigFrom, tsconfigPath);
  const full = git(repo, ["rev-parse", "HEAD"]);
  const date = git(repo, ["show", "-s", "--format=%cs", full]);
  const toolsWithOracle = tools.includes("oracle") ? tools : [...tools, "oracle" as Tool];
  const base = buildGraphs(tsconfigPath, toolsWithOracle);
  const root = posix.dirname(resolvePosix(tsconfigPath)) + "/";
  const files = loadTsconfig(tsconfigPath).fileNames.map((f) => resolvePosix(f).slice(root.length));
  const seeds = pickSeeds(base.oracle as CycleGraph, files, tsconfigPath, options.count, options.seed);
  const records: ReplayRecord[] = [];
  try {
    for (const seed of seeds) {
      const restore = applySeed(tsconfigPath, seed);
      let after: Graphs | undefined;
      const record: ReplayRecord = {
        sha: full,
        parent: full,
        date,
        subject: `seed ${seed.kind}: ${seed.from} -> ${seed.to}`,
        merge: false,
        status: "compared",
        changed_files: 1,
        renames: {},
        tools: {},
        seed,
      };
      try {
        after = buildGraphs(tsconfigPath, toolsWithOracle);
        record.tools = compareAll(base, after, toolsWithOracle, {}, false);
      } catch (err) {
        record.status = "skipped";
        record.reason = (err as Error).message.split("\n")[0];
      } finally {
        restore();
        release(after);
      }
      log(`${seed.kind.padEnd(13)} ${record.status === "compared" ? toolsWithOracle.map((t) => `${t}=${record.tools[t]!.outcome}`).join(" ") : record.reason}  ${seed.from} -> ${seed.to}`);
      records.push(record);
      options.onRecord?.(record);
    }
  } finally {
    release(base);
  }
  return records;
}

const resolvePosix = (p: string) => normalizePath(resolve(p));

export function replay(options: ReplayOptions): ReplayRecord[] {
  const { repo, tools } = options;
  const log = options.log ?? (() => {});
  const tsconfigPath = join(repo, options.tsconfig);
  const prefix = posix.dirname(options.tsconfig.replace(/\\/g, "/"));
  const sourceDir = posix.join(prefix === "." ? "" : prefix, "src");
  const records: ReplayRecord[] = [];
  let cached: { sha: string; graphs: Graphs } | null = null;

  const checkout = (sha: string) => {
    git(repo, ["checkout", "-q", "--detach", "--force", sha]);
    if (options.tsconfigFrom) copyFileSync(options.tsconfigFrom, tsconfigPath);
    if (!existsSync(tsconfigPath)) throw new Error(`${options.tsconfig} doesn't exist at ${sha.slice(0, 10)}`);
  };
  const build = (sha: string): Graphs => {
    checkout(sha);
    return buildGraphs(tsconfigPath, tools);
  };

  for (const sha of options.commits) {
    const full = git(repo, ["rev-parse", sha]);
    if (options.skip?.has(full)) continue;
    const [parentsLine, date, subject] = git(repo, ["show", "-s", "--format=%P%n%cs%n%s", full]).split("\n");
    const parents = parentsLine.split(" ");
    const parent = parents[0];
    const changed = git(repo, ["diff", "--name-only", parent, full, "--", sourceDir]).split("\n").filter(Boolean);
    const record: ReplayRecord = {
      sha: full,
      parent,
      date,
      subject,
      merge: parents.length > 1,
      status: "compared",
      changed_files: changed.length,
      renames: {},
      tools: {},
    };

    if (changed.length === 0) {
      record.status = "unchanged";
      // Same source files, same graphs: they stand in for this commit's when the next one needs its parent.
      if (cached?.sha === parent) cached.sha = full;
    } else {
      try {
        const reused = cached?.sha === parent;
        const before = reused ? cached!.graphs : build(parent);
        if (!reused) release(cached?.graphs);
        const after = build(full);
        record.renames = parseRenames(git(repo, ["diff", "-M", "--name-status", parent, full]), prefix === "." ? "" : prefix);
        record.tools = compareAll(before, after, tools, record.renames, !reused);
        if (after.rie && after.oracle) {
          const key = (e: { from: string; to: string }) => `${e.from}\u0000${e.to}`;
          const rie = new Set((after.rie as Snapshot).edges.map(key));
          const oracle = new Set((after.oracle as CycleGraph).edges.map(key));
          record.edges = {
            agree: [...rie].filter((k) => oracle.has(k)).length,
            rie_only: [...rie].filter((k) => !oracle.has(k)).length,
            oracle_only: [...oracle].filter((k) => !rie.has(k)).length,
          };
          record.unresolved = { rie: (after.rie as Snapshot).unresolved, oracle: (after.oracle as { unresolved: number }).unresolved };
        }
        release(before);
        cached = { sha: full, graphs: after };
      } catch (err) {
        record.status = "skipped";
        record.reason = (err as Error).message.split("\n")[0];
        release(cached?.graphs);
        cached = null;
      }
    }
    const t = record.tools;
    log(
      `${full.slice(0, 10)} ${record.status.padEnd(9)} ` +
        (record.status === "compared" ? tools.map((tool) => `${tool}=${t[tool]!.outcome}`).join(" ") + "  " : "") +
        `${record.changed_files} files  ${subject.slice(0, 60)}`
    );
    records.push(record);
    options.onRecord?.(record);
  }
  release(cached?.graphs);
  return records;
}
