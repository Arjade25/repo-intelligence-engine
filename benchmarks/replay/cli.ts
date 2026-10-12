#!/usr/bin/env tsx
/**
 * History replay for rie check: score RIE and madge against emit-oracle labels on
 * real commits.
 *
 *   npm run replay -- --repo=<git checkout> --tsconfig=<path in repo> [--tsconfig-from=<file>]
 *                     (--last=N [--at=<ref>] | --commits=sha,sha) [--tools=rie,oracle,madge]
 *                     [--out=<results.jsonl>]
 *   npm run replay -- --summarize=<results.jsonl>[,<more.jsonl>]
 *   npm run replay -- --mine --repo=... --tsconfig=... --from=<oldest> [--at=<newest>] [--stride=25] [--out=<mine.jsonl>]
 *     (find the commits that change runtime cycles, with the oracle only - see mine.ts)
 *   npm run replay -- --seed --repo=... --tsconfig=... --commit=<sha> [--count=10] [--rng=1] [--out=<seeds.jsonl>]
 *     (one-line seeded "PRs" on a commit: a runtime import closing a loop, and two type-only lookalikes - see seed.ts)
 *
 * Each record is appended to the results file as it finishes; rerunning with the
 * same --out skips commits already there. The checkout is left at the last commit
 * replayed.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { firstParentCommits, replay, replaySeeds, type ReplayRecord, type Tool } from "./replay.js";
import { mine } from "./mine.js";
import { formatSummary, summarizeReplay } from "./summarize.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const read = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ReplayRecord);

const summarize = flag("summarize");
if (summarize) {
  const records = summarize.split(",").flatMap(read);
  const summary = summarizeReplay(records);
  console.log(formatSummary(summary));
  if (args.includes("--json")) writeFileSync(summarize.split(",")[0].replace(/\.jsonl$/, ".summary.json"), JSON.stringify(summary, null, 2));
  process.exit(0);
}

const repo = flag("repo");
const tsconfig = flag("tsconfig");
if (!repo || !tsconfig) throw new Error("pass --repo=<git checkout> and --tsconfig=<path inside it> (or --summarize=<results.jsonl>)");

if (args.includes("--mine")) {
  // Oracle-only search for commits that change runtime cycles, between --from and --at.
  const from = flag("from");
  if (!from) throw new Error("--mine needs --from=<oldest commit> (and --at=<newest>, default HEAD)");
  const at = flag("at") ?? "HEAD";
  const list = spawnSync("git", ["rev-list", "--first-parent", "--reverse", `${from}..${at}`], { cwd: repo, encoding: "utf8" }).stdout;
  const fromSha = spawnSync("git", ["rev-parse", from], { cwd: repo, encoding: "utf8" }).stdout.trim();
  const commits = [fromSha, ...list.split("\n").filter(Boolean)];
  const out = flag("out") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "results", "replay", "mine.jsonl");
  mkdirSync(dirname(out), { recursive: true });
  const known = new Map<string, string>(
    existsSync(out)
      ? readFileSync(out, "utf8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as { sha: string; signature: string })
          .map((r) => [r.sha, r.signature])
      : []
  );
  console.log(`Mining ${commits.length} first-parent commits, stride ${flag("stride") ?? 25} (${known.size} signatures already in ${out})`);
  const { changed, computed } = mine({
    repo,
    tsconfig,
    tsconfigFrom: flag("tsconfig-from"),
    commits,
    stride: Number(flag("stride") ?? 25),
    known,
    onSignature: (sha, signature, ms) => appendFileSync(out, JSON.stringify({ sha, signature, ms }) + "\n"),
    log: console.log,
  });
  writeFileSync(out.replace(/\.jsonl$/, ".changed.json"), JSON.stringify({ from: fromSha, at, commits: commits.length, changed }, null, 2));
  console.log(`\n${changed.length} commit(s) change runtime cycles (${computed} oracle runs). Replay them with --commits=${changed.join(",")}`);
  process.exit(0);
}
const tools = (flag("tools")?.split(",") ?? ["rie", "oracle", "madge"]) as Tool[];

if (args.includes("--seed")) {
  // Seeded cases on one commit: --commit=<sha> --count=<pairs> [--rng=<n>]
  const commit = flag("commit");
  if (!commit) throw new Error("--seed needs --commit=<sha>");
  const out = flag("out") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "results", "replay", "seeds.jsonl");
  mkdirSync(dirname(out), { recursive: true });
  const records = replaySeeds({
    repo,
    tsconfig,
    tsconfigFrom: flag("tsconfig-from"),
    commit,
    count: Number(flag("count") ?? 10),
    seed: Number(flag("rng") ?? 1),
    tools,
    onRecord: (r) => appendFileSync(out, JSON.stringify(r) + "\n"),
    log: console.log,
  });
  console.log(`\n${records.length} seeded case(s) in ${out}\n`);
  console.log(formatSummary(summarizeReplay(read(out))));
  process.exit(0);
}

const commits = flag("commits")?.split(",") ?? firstParentCommits(repo, flag("at") ?? "HEAD", Number(flag("last") ?? 20));
const out =
  flag("out") ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "results", "replay", `replay-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
mkdirSync(dirname(out), { recursive: true });
// A skipped commit is retried: a skip can be the run itself failing (a killed madge exits 0xC0000142).
const previous = existsSync(out) ? read(out) : [];
const done = new Set(previous.filter((r) => r.status !== "skipped").map((r) => r.sha));
if (previous.length > done.size) {
  writeFileSync(out, previous.filter((r) => done.has(r.sha)).map((r) => JSON.stringify(r) + "\n").join(""));
}

console.log(`Replaying ${commits.length} commit(s) of ${resolve(repo)} (${done.size} already in ${out})`);
const records = replay({
  repo,
  tsconfig,
  tsconfigFrom: flag("tsconfig-from"),
  commits,
  tools,
  skip: done,
  onRecord: (r) => appendFileSync(out, JSON.stringify(r) + "\n"),
  log: console.log,
});
console.log(`\n${records.length} new record(s) in ${out}\n`);
console.log(formatSummary(summarizeReplay(read(out))));
