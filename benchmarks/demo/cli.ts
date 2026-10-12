#!/usr/bin/env tsx
/**
 * The rie check demo: one real commit, seen the way a reviewer would see it as a PR,
 * next to what madge and the emit oracle say about the same pair.
 *
 *   npm run demo                      element-web 526b4b8c33 (the defaults below)
 *   npm run demo -- --repo=<git checkout> --commit=<sha> --tsconfig=<path in repo>
 *                   [--tsconfig-from=<file>] [--out=<dir>]
 *
 * The commit and its first parent are checked out into two temporary worktrees, so
 * the benchmark clone stays where it is. A sparse clone stays sparse: the worktrees
 * copy its patterns. --tsconfig-from is copied into both, for repos that don't track
 * the tsconfig. Writes to --out:
 *   rie-report.txt   what `rie check` prints
 *   rie-comment.md   the PR comment the GitHub Action would post
 *   result.json      all three tools' outcomes, events and group sizes, and why madge differs
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { compareSnapshots, indexSnapshot, type CycleCheckResult, type CycleEvent } from "../../src/check/index.js";
import { formatMarkdown, formatReport } from "../../src/check/report.js";
import { madgeGraph, oracleGraph } from "../replay/graphs.js";

const BENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const repo = resolve(flag("repo") ?? join(BENCH_DIR, "candidates", "element-web"));
const commitArg = flag("commit") ?? "526b4b8c330482a97adba4869b90e5f28f0f0f20";
const tsconfig = flag("tsconfig") ?? "apps/web/tsconfig.rie.json";
const tsconfigFrom = flag("tsconfig-from") ?? (flag("repo") ? undefined : join(BENCH_DIR, "candidates-config", "element-web.tsconfig.rie.json"));

function git(cwd: string, gitArgs: string[]): string {
  const r = spawnSync("git", gitArgs, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${gitArgs.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

const commit = git(repo, ["rev-parse", commitArg]);
const parent = git(repo, ["rev-parse", `${commit}^1`]);
const subject = git(repo, ["log", "-1", "--format=%s", commit]);
const out = resolve(flag("out") ?? join(BENCH_DIR, "results", "demo", `${repo.split(/[\\/]/).pop()}-${commit.slice(0, 10)}`));

const sparse = git(repo, ["sparse-checkout", "list"]).split("\n").filter(Boolean);
const tmp = mkdtempSync(join(tmpdir(), "rie-demo-"));
const worktrees: string[] = [];

/** A detached worktree at `sha`, sparse like the clone, with the tsconfig in place. */
function checkout(name: string, sha: string): string {
  const dir = join(tmp, name);
  git(repo, ["worktree", "add", "--detach", "--no-checkout", dir, sha]);
  worktrees.push(dir);
  if (sparse.length > 0) git(dir, ["sparse-checkout", "set", "--no-cone", ...sparse]);
  git(dir, ["checkout", "--detach", sha]);
  const path = join(dir, tsconfig);
  if (tsconfigFrom) copyFileSync(tsconfigFrom, path);
  return path;
}

const eventLine = (e: CycleEvent) =>
  `${e.type} (${e.outcome})${e.base_groups ? `: ${e.base_groups.map((g) => g.length).join("+") || "-"} -> ${(e.pr_groups ?? []).map((g) => g.length).join("+") || "-"} files` : ""}`;

try {
  console.log(`${commit.slice(0, 10)} ${subject}\nparent ${parent.slice(0, 10)}`);
  const baseTsconfig = checkout("base", parent);
  const prTsconfig = checkout("pr", commit);

  // rie check, exactly as `npm run check -- --base=... --pr=...` would run it.
  let t = Date.now();
  const rieBase = indexSnapshot(baseTsconfig);
  const riePr = indexSnapshot(prTsconfig);
  const warnings = [rieBase, riePr].filter((s) => s.unresolved > 0).map((s) => `${s.unresolved} internal import(s) don't resolve:\n${s.unresolvedSummary}`);
  const rie: CycleCheckResult = { ...compareSnapshots(rieBase, riePr), warnings };
  const rieMs = Date.now() - t;
  rieBase.db.close();
  riePr.db.close();

  t = Date.now();
  const madgeBase = madgeGraph(baseTsconfig);
  const madgePr = madgeGraph(prTsconfig);
  const madge = compareSnapshots(madgeBase, madgePr);
  const madgeMs = Date.now() - t;

  t = Date.now();
  const oracle = compareSnapshots(oracleGraph(baseTsconfig), oracleGraph(prTsconfig));
  const oracleMs = Date.now() - t;

  // Why madge differs: of the files RIE says joined a cycle, how many madge had in a cycle already.
  const joined = [...new Set(rie.events.flatMap((e) => e.joined ?? []))].sort();
  const madgeBaseFiles = new Set(madgeBase.groups.flat());
  const alreadyInMadge = joined.filter((f) => madgeBaseFiles.has(f));

  const report = formatReport(rie);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "rie-report.txt"), report + "\n");
  writeFileSync(join(out, "rie-comment.md"), formatMarkdown(rie, { baseCommit: parent }) + "\n");
  const summarize = (r: Omit<CycleCheckResult, "warnings">, ms: number) => ({
    outcome: r.outcome,
    events: r.events.map(eventLine),
    largest_group: { base: r.groups.base[0]?.length ?? 0, pr: r.groups.pr[0]?.length ?? 0 },
    ms,
  });
  const result = {
    repo: git(repo, ["remote", "get-url", "origin"]),
    commit,
    parent,
    subject,
    tsconfig,
    rie: { ...summarize(rie, rieMs), joined, warnings },
    oracle: summarize(oracle, oracleMs),
    madge: { ...summarize(madge, madgeMs), joined_files_already_in_a_madge_cycle_on_base: alreadyInMadge },
  };
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");

  console.log(`\n${report}`);
  for (const [name, r] of [["oracle (labels)", result.oracle], ["madge", result.madge], ["rie", result.rie]] as const) {
    console.log(`\n${name}: ${r.outcome.toUpperCase()}, largest group ${r.largest_group.base} -> ${r.largest_group.pr} files, ${(r.ms / 1000).toFixed(1)} s`);
    for (const e of r.events) console.log(`  ${e}`);
  }
  if (joined.length > 0) {
    console.log(`\nOf the ${joined.length} files that joined the runtime cycle, madge already had ${alreadyInMadge.length} in a cycle on the parent.`);
  }
  console.log(`\nWrote ${out}`);
} finally {
  for (const dir of worktrees) git(repo, ["worktree", "remove", "--force", dir]);
  rmSync(tmp, { recursive: true, force: true });
}
