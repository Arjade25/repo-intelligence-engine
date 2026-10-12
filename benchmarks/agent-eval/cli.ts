#!/usr/bin/env tsx
/**
 * Agent evaluation (plan, week 4): the investigation agent on every fail and warn
 * finding rie check made in the history replay, plus seeded traps, scored without
 * a model (see score.ts).
 *
 *   npm run agent-eval -- [--repos=element-web,directus] [--runs=3] [--limit=<commits>]
 *                         [--budget=40] [--traps=10] [--out=<results.jsonl>]
 *   npm run agent-eval -- --summarize=<results.jsonl>
 *
 * Tasks:
 * - real: each commit the replay flagged (benchmarks/results/replay/<repo>-replay-{a,b}.jsonl),
 *   checked out with its parent in temporary worktrees, indexed fresh, and compared
 *   exactly as rie check compares a PR. The agent explains each fail or warn event.
 * - trap: the first `--traps` of those commits whose finding has a loop of 3 or more
 *   files get a seeded `import type` on the PR side, from the loop's second file back to
 *   its first. Counted, it would make a 2-file loop; it is erased at compile time, so
 *   citing it is wrong. The seed must leave rie check's events unchanged, or the trap
 *   is skipped. It is part of the diff the agent sees.
 *
 * Each commit's base and PR are indexed (and compiled, for the oracle) once, and all
 * runs of its tasks reuse them. Records are appended as they finish; rerunning with
 * the same --out skips sessions already there. Stops: --budget (USD, the SDK's
 * estimates, which a subscription doesn't bill), and 3 sessions in a row that error
 * out (a usage limit, say) - rerun later to resume.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareSnapshots, indexSnapshot, type CycleEvent, type Snapshot } from "../../src/check/index.js";
import { parseRenames } from "../../src/check/git.js";
import { explain } from "../../src/agent/runtime.js";
import { oracleGraph } from "../replay/graphs.js";
import type { ReplayRecord } from "../replay/replay.js";
import { checkoutPair, git } from "../replay/worktree.js";
import { citesTrap, formatSummaries, summarize, unsupportedHops, usefulness, type SessionRecord, type Trap } from "./score.js";

const BENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const readJsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as T)
    : [];

const summarizeFile = flag("summarize");
if (summarizeFile) {
  const records = readJsonl<SessionRecord>(summarizeFile);
  const groups: [string, SessionRecord[]][] = [];
  for (const repo of [...new Set(records.map((r) => r.repo))]) {
    for (const kind of ["real", "trap"] as const) groups.push([`${repo} · ${kind}`, records.filter((r) => r.repo === repo && r.kind === kind)]);
  }
  groups.push(["all · real", records.filter((r) => r.kind === "real")], ["all · trap", records.filter((r) => r.kind === "trap")], ["all", records]);
  const rows = groups.filter(([, rs]) => rs.length > 0).map(([label, rs]) => summarize(label, rs));
  console.log(formatSummaries(rows));
  writeFileSync(summarizeFile.replace(/\.jsonl$/, ".summary.json"), JSON.stringify(rows, null, 2) + "\n");
  for (const r of records.filter((x) => x.unsupported.length > 0)) console.log(`\nUNSUPPORTED ${r.task_id} run ${r.run}:\n  ${r.unsupported.join("\n  ")}`);
  process.exit(0);
}

interface RepoConfig {
  repo: string;
  tsconfig: string;
  tsconfigFrom: string;
  replay: string[];
  /** Extension on the trap's import specifier: Node16 resolution needs ".js", bundler resolution takes none. */
  trapExt: string;
}

const REPOS: Record<string, RepoConfig> = {
  "element-web": {
    repo: join(BENCH_DIR, "candidates", "element-web"),
    tsconfig: "apps/web/tsconfig.rie.json",
    tsconfigFrom: join(BENCH_DIR, "candidates-config", "element-web.tsconfig.rie.json"),
    replay: ["element-web-replay-a.jsonl", "element-web-replay-b.jsonl"],
    trapExt: "",
  },
  directus: {
    repo: join(BENCH_DIR, "candidates", "directus"),
    tsconfig: "api/tsconfig.rie.json",
    tsconfigFrom: join(BENCH_DIR, "candidates-config", "directus-api.tsconfig.rie.json"),
    replay: ["directus-replay-a.jsonl", "directus-replay-b.jsonl"],
    trapExt: ".js",
  },
};

const repos = (flag("repos") ?? "element-web,directus").split(",");
const runs = Number(flag("runs") ?? 3);
const budget = Number(flag("budget") ?? 40);
const trapsPerRepo = Number(flag("traps") ?? 10);
const limit = flag("limit") ? Number(flag("limit")) : Infinity;
const out = resolve(flag("out") ?? join(BENCH_DIR, "results", "agent-eval", `agent-eval-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));
mkdirSync(dirname(out), { recursive: true });

const previous = readJsonl<SessionRecord>(out);
const done = new Set(previous.map((r) => `${r.task_id}#${r.event_index}#${r.run}`));
let spent = previous.reduce((n, r) => n + (r.cost_usd ?? 0), 0);
let consecutiveErrors = 0;
console.log(`Agent eval -> ${out}\n${previous.length} session(s) already recorded, $${spent.toFixed(2)} of $${budget} spent; ${runs} run(s) per task.`);

const flagged = (events: CycleEvent[]) => events.map((e, i) => ({ e, i })).filter(({ e }) => e.outcome !== "pass" && (e.evidence?.length ?? 0) > 0);
const eventKey = (e: CycleEvent) => `${e.type}|${e.outcome}|${JSON.stringify(e.pr_groups)}`;

class Stop extends Error {}

/** Every run of one task's events, appended as each finishes. */
async function runTask(t: {
  task_id: string;
  repo: string;
  sha: string;
  kind: "real" | "trap";
  events: { e: CycleEvent; i: number }[];
  pr: Snapshot;
  base: Snapshot;
  renames: Record<string, string>;
  tsconfig: string;
  gitRoot: string;
  diff: string;
  oracle: { base: ReturnType<typeof oracleGraph>; pr: ReturnType<typeof oracleGraph> };
  trap?: Trap;
}) {
  for (let run = 1; run <= runs; run++) {
    for (const { e, i } of t.events) {
      if (done.has(`${t.task_id}#${i}#${run}`)) continue;
      if (spent >= budget) throw new Stop(`budget of $${budget} reached ($${spent.toFixed(2)} spent)`);
      const started = Date.now();
      const x = await explain({ event: e, pr: t.pr, base: t.base, renames: t.renames, tsconfig: t.tsconfig, gitRoot: t.gitRoot, diff: t.diff });
      const posted = x.source === "agent" ? x.finding : undefined;
      const record: SessionRecord = {
        task_id: t.task_id,
        repo: t.repo,
        sha: t.sha,
        kind: t.kind,
        run,
        event_index: i,
        event_type: e.type,
        loops_in_event: e.evidence!.length,
        ...(t.trap && { trap: t.trap, trap_cited: x.attempts.map((a) => citesTrap(a.draft, t.trap!)) }),
        source: x.source,
        ...(x.source === "deterministic" && { reason: x.reason }),
        attempts: x.attempts.map(({ finding: _f, draft: _d, ...a }) => a),
        ...(posted && { posted }),
        unsupported: posted ? unsupportedHops(posted, t.oracle, t.renames) : [],
        ...(posted && { usefulness: usefulness(posted, e) }),
        cost_usd: x.cost_usd,
        wall_ms: Date.now() - started,
      };
      appendFileSync(out, JSON.stringify(record) + "\n");
      done.add(`${t.task_id}#${i}#${run}`);
      spent += x.cost_usd ?? 0;
      const a = record.attempts;
      console.log(
        `  ${t.task_id} run ${run}: ${x.source === "agent" ? "posted" : "fell back"} (${a.map((y) => y.status).join(" -> ") || "none"})` +
          `${record.unsupported.length ? ` UNSUPPORTED ${record.unsupported.length}` : ""}${record.trap_cited?.some(Boolean) ? " trap cited" : ""}` +
          ` $${(x.cost_usd ?? 0).toFixed(3)} ${(record.wall_ms / 1000).toFixed(0)} s  [total $${spent.toFixed(2)}]`
      );
      const errored = a[0]?.stop?.startsWith("error") ?? false;
      consecutiveErrors = errored ? consecutiveErrors + 1 : 0;
      if (errored) console.log(`    ${a[0].stop!.slice(0, 300)}`);
      if (consecutiveErrors >= 3) throw new Stop("3 sessions in a row errored (a usage limit?); rerun with the same --out to resume");
    }
  }
}

try {
  for (const name of repos) {
    const cfg = REPOS[name];
    if (!cfg) throw new Error(`unknown repo ${name}; known: ${Object.keys(REPOS).join(", ")}`);
    const prefix = posix.dirname(cfg.tsconfig);
    const commits = cfg.replay
      .flatMap((f) => readJsonl<ReplayRecord>(join(BENCH_DIR, "results", "replay", f)))
      .filter((r) => r.status === "compared" && flagged(r.tools.rie?.detail ?? []).length > 0)
      .slice(0, limit);
    let traps = new Set(previous.filter((r) => r.repo === name && r.kind === "trap").map((r) => r.task_id)).size;
    console.log(`\n${name}: ${commits.length} flagged commit(s)`);

    for (const c of commits) {
      const id = `${name}-${c.sha.slice(0, 10)}`;
      const wantTrap = traps < trapsPerRepo;
      const realDone = [...Array(runs).keys()].every((k) => [...done].some((d) => d.startsWith(`${id}#`) && d.endsWith(`#${k + 1}`)));
      const trapDone = [...Array(runs).keys()].every((k) => [...done].some((d) => d.startsWith(`${id}-trap#`) && d.endsWith(`#${k + 1}`)));
      const trapStarted = [...done].some((d) => d.startsWith(`${id}-trap#`));
      if (realDone && (trapDone || (!wantTrap && !trapStarted))) continue;

      console.log(`${id} ${c.subject.slice(0, 70)}`);
      const pair = checkoutPair(cfg.repo, c.parent, c.sha, cfg.tsconfig, cfg.tsconfigFrom);
      const open: Snapshot[] = [];
      try {
        const t0 = Date.now();
        const renames = parseRenames(git(cfg.repo, ["diff", "-M", "--name-status", c.parent, c.sha]), prefix === "." ? "" : prefix);
        const base = indexSnapshot(pair.baseTsconfig);
        open.push(base);
        const pr = indexSnapshot(pair.prTsconfig);
        open.push(pr);
        const result = compareSnapshots(base, pr, { renames });
        const oracle = { base: oracleGraph(pair.baseTsconfig), pr: oracleGraph(pair.prTsconfig) };
        const events = flagged(result.events);
        console.log(`  indexed and compiled in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${events.map(({ e }) => `${e.type} (${e.evidence!.length} loop(s))`).join(", ")}`);
        const diffOf = () => git(pair.prDir, ["diff", "-M", c.parent, "--", prefix]);
        const common = { repo: name, sha: c.sha, base, renames, tsconfig: pair.prTsconfig, gitRoot: pair.prDir };

        if (!realDone) await runTask({ ...common, task_id: id, kind: "real", events, pr, diff: diffOf(), oracle });

        if (wantTrap || trapStarted) {
          // The trap: loop[1] gets `import type` of loop[0], on line 1.
          const target = events.map(({ e, i }) => ({ e, i, loop: e.evidence!.find((ev) => ev.loop.length >= 4)?.loop })).find((x) => x.loop);
          if (!target) {
            console.log("  no loop of 3+ files: no trap here");
            continue;
          }
          const [to, from] = target.loop!;
          const spec = posix.relative(posix.dirname(from), to).replace(/\.[cm]?tsx?$/, "") + cfg.trapExt;
          const line = `import type * as rieTrap from "${spec.startsWith(".") ? spec : `./${spec}`}";`;
          const file = join(dirname(pair.prTsconfig), from);
          writeFileSync(file, `${line}\n${readFileSync(file, "utf8")}`);
          const pr2 = indexSnapshot(pair.prTsconfig);
          open.push(pr2);
          const result2 = compareSnapshots(base, pr2, { renames });
          const edge = pr2.db
            .prepare("SELECT is_type_only FROM edges WHERE from_file = ? AND to_file = ? AND line = 1")
            .get(pr2.stored.get(from), pr2.stored.get(to)) as { is_type_only: number } | undefined;
          const same = result2.events.map(eventKey).join("\n") === result.events.map(eventKey).join("\n");
          if (!edge || edge.is_type_only !== 1 || !same) {
            console.log(`  trap skipped: ${!edge ? "the seeded import didn't resolve" : edge.is_type_only !== 1 ? "the seeded import isn't type-only" : "it changed rie check's events"}`);
            continue;
          }
          const oracle2 = { base: oracle.base, pr: oracleGraph(pair.prTsconfig) };
          if (oracle2.pr.edges.some((e) => e.from === from && e.to === to)) {
            console.log("  trap skipped: the oracle keeps the seeded import");
            continue;
          }
          const events2 = flagged(result2.events).filter(({ i }) => i === target.i);
          if (!trapStarted) traps++;
          await runTask({ ...common, task_id: `${id}-trap`, kind: "trap", events: events2, pr: pr2, diff: diffOf(), oracle: oracle2, trap: { file: from, target: to, line: 1 } });
        }
      } finally {
        for (const s of open) s.db.close();
        pair.dispose();
      }
    }
  }
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  console.log(`\nSTOPPED: ${e.message}`);
}
console.log(`\n$${spent.toFixed(2)} spent. Summarize with: npm run agent-eval -- --summarize=${out}`);
