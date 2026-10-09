#!/usr/bin/env tsx
/**
 * Generated-task benchmark harness (plan step 4).
 *
 *   npm run harness -- --config=nest [--tools=baseline,rie] [--runs=3] [--model=<id>]
 *   npm run harness -- --tsconfig=<path> --tasks=<generated.json> [...]
 *
 * Filters: --category=cycle_trace,dependency_path,change_impact  --task-ids=id,id  --limit=N
 * Other:   --skip-build  --dry-run (print the plan and exact agent command, spawn nothing)
 *          --allow-unresolved (benchmark even if the RIE index has unresolved internal imports;
 *          only for imports shown not to affect the tasks - the count is recorded in the results)
 *          --out=<path>  (default benchmarks/results/harness/<label>-<timestamp>.json)
 *          --session-timeout-min=N  (kill a session after N minutes and record it as an error; default 30)
 *          --resume=<results.json | .partial.jsonl>  (finish an interrupted run: keep its successful
 *          sessions, run only the missing or failed ones, and write the combined results back to that
 *          run's results file; meta.resumed records what was kept and what was re-run)
 * Spend:   the plan prints an estimated cost per arm, from the mean cost of past sessions
 *          --max-spend=USD  (stop launching once this invocation's spend reaches USD; the
 *          results are marked stopped_early and finish later with --resume)
 *          --pilot  (one run per task, results named <label>-pilot-*, to catch prompt or grader
 *          bugs first; the default is 3 runs - use --runs=5 only for numbers you publish)
 *          --reuse=<tool>=<results.json>[,...]  (use that arm's sessions from an earlier run
 *          instead of new ones - for an arm that hasn't changed, like the Read/Grep baseline;
 *          refused if any task's prompt changed or a session is missing; recorded in meta.reused)
 *          --max-turns=N  (cap each session at N turns, default 150, 0 = off; a capped session
 *          counts as wrong and is reported in its own column - keep the cap far above normal
 *          use, or it hands the cheaper arm wins it didn't earn)
 *
 * Each finished run is also appended to <out>.partial.jsonl as it completes, so a
 * run stopped midway keeps the sessions it already paid for. The file is deleted
 * once the full results are written.
 *
 * Every run is a fresh headless Claude Code session in the target repo with the
 * same prompt, model and built-in tools; arms differ only in the one MCP server
 * they load. Results keep every run's transcript metrics, final text and grade,
 * so a published number can always be traced back to the raw answers.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { GeneratedTaskSet, Task } from "../taskgen/generate.js";
import { openDb } from "../../src/storage/db.js";
import { reindex } from "../../src/engine/index.js";
import { describeUnresolved } from "../../src/indexer/resolution.js";
import { claudeArgs, resolveClaudeBin, runClaude } from "./claude.js";
import { runBenchmark, summarize, type CellSummary, type RunRecord, type ToolArm } from "./bench.js";
import { buildPrompt } from "./grade.js";
import { estimateCost, loadCostHistory, loadReusedArm, type ReuseSource } from "./budget.js";

const BENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = join(BENCH_DIR, "..");

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const list = (name: string) => flag(name)?.split(",").filter(Boolean);
const dryRun = args.includes("--dry-run");

// --- target repo + task set -------------------------------------------------------
let tsconfigPath: string;
let label: string;
const configName = flag("config");
if (configName) {
  const configPath = [configName, join(BENCH_DIR, configName), join(BENCH_DIR, `tasks-${configName}.json`)].find(existsSync);
  if (!configPath) throw new Error(`--config=${configName}: no such task file`);
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { repo: { name: string; dir?: string; tsconfig: string } };
  tsconfigPath = join(BENCH_DIR, config.repo.dir ?? "target-repo", config.repo.tsconfig);
  label = config.repo.name;
} else {
  const given = flag("tsconfig");
  if (!given) throw new Error("pass --config=<name> or --tsconfig=<path> (with --tasks=<generated.json>)");
  tsconfigPath = resolve(given);
  label = basename(dirname(tsconfigPath));
}
if (!existsSync(tsconfigPath)) throw new Error(`tsconfig not found: ${tsconfigPath}`);
const repoRoot = dirname(tsconfigPath).replace(/\\/g, "/");

const tasksPath = flag("tasks") ?? join(BENCH_DIR, "generated", `${label}.json`);
if (!existsSync(tasksPath)) throw new Error(`task set not found: ${tasksPath} (run npm run taskgen first)`);
const taskSet = JSON.parse(readFileSync(tasksPath, "utf8")) as GeneratedTaskSet;

let tasks: Task[] = taskSet.tasks;
const categories = list("category");
if (categories) tasks = tasks.filter((t) => categories.includes(t.category));
const ids = list("task-ids");
if (ids) tasks = tasks.filter((t) => ids.includes(t.id));
if (flag("limit")) tasks = tasks.slice(0, Number(flag("limit")));
if (tasks.length === 0) throw new Error("no tasks left after filtering");

// --- tool arms ----------------------------------------------------------------------
interface ToolSpec {
  description: string;
  setup?: "rie-index";
  mcp?: { command: string; args?: string[]; env?: Record<string, string> };
  /** For a CLI competitor: built-in tools (default Read,Grep,Glob), PATH additions, env, and a system-prompt note. */
  builtin_tools?: string;
  path_prepend?: string[];
  env?: Record<string, string>;
  system_note?: string;
}
const registry = (JSON.parse(readFileSync(join(BENCH_DIR, "tools.json"), "utf8")) as { tools: Record<string, ToolSpec> }).tools;
// --reuse=<tool>=<results.json>[,...]: that arm's earlier sessions stand in for new ones.
const reuseSources: ReuseSource[] = (list("reuse") ?? []).map((spec) => {
  const eq = spec.indexOf("=");
  if (eq < 1) throw new Error(`--reuse expects <tool>=<results.json>, got "${spec}"`);
  return { tool: spec.slice(0, eq), path: resolve(spec.slice(eq + 1)) };
});
const reusedNames = reuseSources.map((s) => s.tool);
const explicitTools = list("tools");
for (const name of reusedNames) {
  if (explicitTools?.includes(name)) throw new Error(`"${name}" is both in --tools and --reuse - pick one`);
}
const toolNames = [...new Set([...(explicitTools ?? Object.keys(registry)), ...reusedNames])];
for (const name of toolNames) if (!registry[name]) throw new Error(`unknown tool "${name}" (see benchmarks/tools.json)`);

// --pilot: one run per task, to catch prompt and grader bugs before paying for the full run.
// Three runs is the default for internal checks; pass --runs=5 for numbers you publish.
const pilot = args.includes("--pilot");
if (pilot && flag("runs") && flag("runs") !== "1") throw new Error("--pilot means one run per task - drop --runs");
const runs = pilot ? 1 : Number(flag("runs") ?? 3);
const maxSpend = flag("max-spend") === undefined ? undefined : Number(flag("max-spend"));
if (maxSpend !== undefined && !(maxSpend > 0)) throw new Error(`--max-spend must be a dollar amount above 0, got "${flag("max-spend")}"`);
// 150 is about twice the most turns any session has taken (74, an element-web baseline);
// medians are 5-11. 0 turns the cap off.
const maxTurns = Number(flag("max-turns") ?? 150);
const model = flag("model");
const rieDb = join(BENCH_DIR, `harness-${label}-index.db`);
const placeholders: Record<string, string> = {
  NODE: process.execPath,
  PROJECT_ROOT,
  REPO_DIR: repoRoot,
  TSCONFIG: tsconfigPath,
  RIE_DB: rieDb,
};
const expand = (s: string) => s.replace(/\$\{(\w+)\}/g, (_, k: string) => placeholders[k] ?? `\${${k}}`);

const tmp = mkdtempSync(join(tmpdir(), "rie-harness-"));
const tools: ToolArm[] = toolNames.map((name) => {
  const spec = registry[name];
  const launch: Omit<ToolArm, "name" | "mcpConfigPath"> = {
    ...(spec.builtin_tools && { builtinTools: spec.builtin_tools }),
    ...(spec.path_prepend && { pathPrepend: spec.path_prepend.map(expand) }),
    ...(spec.env && { env: Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, expand(v)])) }),
    ...(spec.system_note && { appendSystemPrompt: expand(spec.system_note) }),
  };
  if (!spec.mcp) return { name, ...launch };
  const cfg = {
    mcpServers: {
      [name]: {
        command: expand(spec.mcp.command),
        args: (spec.mcp.args ?? []).map(expand),
        env: Object.fromEntries(Object.entries(spec.mcp.env ?? {}).map(([k, v]) => [k, expand(v)])),
      },
    },
  };
  const path = join(tmp, `${name}.mcp.json`);
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return { name, mcpConfigPath: path, ...launch };
});

console.log(`Task set: ${tasksPath} (${taskSet.repo})`);
console.log(`Repo root: ${repoRoot}`);
console.log(
  `Tasks: ${tasks.length}  Tools: ${toolNames.join(", ")}  Runs per tool: ${runs}${pilot ? " (pilot)" : ""}  Model: ${model ?? "(CLI default)"}`
);

const reused = reuseSources.map((s) => loadReusedArm(s, tasks, runs));
for (const r of reused) {
  console.log(
    `Reusing ${r.records.length} ${r.tool} session(s) from ${r.from} (CLI ${String(r.source_meta.claude_version ?? "?")}` +
      `${r.prompts_verified ? ", prompts verified" : ", PROMPTS NOT VERIFIED - that run saved no task set"})`
  );
}
const liveTools = toolNames.filter((n) => !reusedNames.includes(n));
console.log(`Agent sessions to launch: ${tasks.length * liveTools.length * runs}`);
const estimate = estimateCost(loadCostHistory(join(BENCH_DIR, "results", "harness")), taskSet.repo, tasks, liveTools, runs);
const usd = (n: number | null) => (n === null ? "unknown" : `$${n.toFixed(2)}`);
for (const a of estimate.arms) console.log(`  ${a.tool}: ${a.sessions} sessions, ~${usd(a.usd)} (from ${a.basis})`);
console.log(`Estimated spend: ~${usd(estimate.total_usd)}${maxSpend !== undefined ? `  Hard stop at: $${maxSpend.toFixed(2)}` : ""}`);
if (maxSpend !== undefined && estimate.total_usd !== null && estimate.total_usd > maxSpend) {
  console.warn(`WARNING: the estimate is over --max-spend, so this run will probably stop early (finish it later with --resume).`);
}
console.log(`Turn cap per session: ${maxTurns > 0 ? maxTurns : "off"}`);

if (dryRun) {
  const sample = tasks[0];
  console.log(`\n--- prompt for ${sample.id} (identical on every arm) ---\n${buildPrompt(sample)}\n`);
  for (const tool of tools.filter((t) => liveTools.includes(t.name))) {
    const argv = claudeArgs({ prompt: "<prompt>", cwd: repoRoot, model, maxTurns, ...tool }, "<session-id>");
    console.log(`[${tool.name}] claude ${argv.join(" ")}`);
    if (tool.pathPrepend || tool.env) console.log(`  PATH += ${tool.pathPrepend?.join(";") ?? ""}  env: ${JSON.stringify(tool.env ?? {})}`);
    if (tool.mcpConfigPath) console.log(readFileSync(tool.mcpConfigPath, "utf8"));
  }
  process.exit(0);
}

// --- setup + run --------------------------------------------------------------------
const claudeBin = resolveClaudeBin();
const setups = new Set(liveTools.map((n) => registry[n].setup).filter(Boolean));
let unresolvedCount: number | null = null; // null = no arm built an index
if (setups.has("rie-index")) {
  if (!args.includes("--skip-build")) {
    console.log("Building repo-intelligence-engine (npm run build)...");
    const build = spawnSync("npm", ["run", "build"], { cwd: PROJECT_ROOT, stdio: "inherit", shell: true });
    if (build.status !== 0) throw new Error("npm run build failed");
  }
  if (!existsSync(join(PROJECT_ROOT, "dist", "mcp-server", "index.js"))) throw new Error("dist/mcp-server/index.js missing - build first");
  console.log(`Indexing ${tsconfigPath} -> ${rieDb} ...`);
  const db = openDb(rieDb);
  const { unresolved_internal_imports } = reindex(db, tsconfigPath);
  db.close();
  unresolvedCount = unresolved_internal_imports.length;
  if (unresolvedCount > 0) {
    // The rie arm would be answering from a partial index - that measures the tsconfig, not the tool.
    // --allow-unresolved is for imports shown not to matter (e.g. Babylon's build-generated
    // shader modules, which can't sit on a cycle); the count is kept in the results.
    if (!args.includes("--allow-unresolved")) {
      throw new Error(`refusing to benchmark against a partial index:\n${describeUnresolved(unresolved_internal_imports)}\n(pass --allow-unresolved if they can't affect the tasks)`);
    }
    console.warn(`WARNING: benchmarking with --allow-unresolved:\n${describeUnresolved(unresolved_internal_imports)}`);
  }
}

// --resume: the sessions an interrupted attempt already paid for. A run whose agent
// failed to launch (ok: false) is re-run, never kept: losing the harness's console
// once made every later `claude` launch die at startup (0xC0000142), which recorded
// 61 instant "errors" that measured nothing.
const resumeFrom = flag("resume");
let previous: RunRecord[] = [];
let previousMeta: Record<string, unknown> | undefined;
if (resumeFrom) {
  const text = readFileSync(resumeFrom, "utf8");
  if (resumeFrom.endsWith(".jsonl")) {
    previous = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as RunRecord);
  } else {
    const prior = JSON.parse(text) as { meta: Record<string, unknown>; runs: RunRecord[] };
    previous = prior.runs;
    previousMeta = prior.meta;
  }
}
const kept = previous.filter((r) => r.ok);

const startedAt = previousMeta?.started_at ? new Date(previousMeta.started_at as string) : new Date();
const out =
  flag("out") ??
  (resumeFrom ? resumeFrom.replace(/\.partial\.jsonl$/, "") : undefined) ??
  join(BENCH_DIR, "results", "harness", `${label}${pilot ? "-pilot" : ""}-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
const partialOut = `${out}.partial.jsonl`;
mkdirSync(dirname(out), { recursive: true });
const sessionTimeoutMs = Number(flag("session-timeout-min") ?? 30) * 60_000;
console.log(`Session timeout: ${sessionTimeoutMs / 60_000} min. Progress: ${partialOut}`);
if (resumeFrom) {
  console.log(`Resuming ${resumeFrom}: keeping ${kept.length} successful session(s), discarding ${previous.length - kept.length} failed one(s).`);
}

const resumedAt = new Date();
// Spend of the sessions launched by this invocation (kept and reused ones were paid for earlier).
let spent = 0;
const stop = { early: false };
const records = runBenchmark({
  tasks,
  tools,
  runs,
  model,
  repoRoot,
  keep: [...kept, ...reused.flatMap((r) => r.records)],
  runner: (req) => runClaude(claudeBin, { ...req, timeoutMs: sessionTimeoutMs, maxTurns }),
  shouldStop: () => {
    if (maxSpend === undefined || spent < maxSpend) return false;
    stop.early = true;
    return true;
  },
  onRun: (r, done, total, wasKept) => {
    appendFileSync(partialOut, JSON.stringify(r) + "\n");
    if (wasKept) return; // already reported by the earlier attempt, or reused
    spent += r.cost_usd ?? 0;
    const m = r.metrics;
    const verdict = !r.ok
      ? `ERROR ${r.error?.split("\n")[0]}`
      : r.capped
        ? `CAPPED at ${maxTurns} turns`
        : r.grade.correct
          ? "correct"
          : `wrong (${r.grade.reason ?? "incorrect"})`;
    console.log(
      `[${done}/${total}] ${r.task_id} / ${r.tool} / run ${r.run + 1}: ` +
        (m ? `${m.tool_calls} calls, ${m.total_tokens} tokens, ` : "") +
        `${verdict}  (spent $${spent.toFixed(2)})`
    );
  },
});
if (stop.early) {
  console.warn(`\nSTOPPED: spend reached $${spent.toFixed(2)} (--max-spend=${maxSpend}). Finish later with --resume=${out}`);
}

const summary = summarize(records);
const gitHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).stdout.trim();
const claudeVersion = spawnSync(claudeBin, ["--version"], { encoding: "utf8" }).stdout.trim();
const observedModels = [...new Set(records.flatMap((r) => r.metrics?.models ?? []))].sort();

writeFileSync(
  out,
  JSON.stringify(
    {
      meta: {
        task_set: tasksPath.replace(/\\/g, "/"),
        repo: taskSet.repo,
        tsconfig_flags: taskSet.tsconfig_flags,
        unresolved_internal_imports: unresolvedCount,
        tools: Object.fromEntries(toolNames.map((n) => [n, registry[n].description])),
        // Everything that differed between arms besides the MCP server, exactly as launched.
        tool_launch: Object.fromEntries(tools.map(({ name, mcpConfigPath: _, ...launch }) => [name, launch])),
        runs_per_tool: runs,
        pilot,
        max_turns: maxTurns > 0 ? maxTurns : null,
        max_spend_usd: maxSpend ?? null,
        spent_usd: spent,
        estimated_usd: estimate.total_usd,
        // A stopped run is incomplete: its summary covers only the sessions that ran.
        ...(stop.early && { stopped_early: { reason: "max_spend", sessions: records.length, of: tasks.length * toolNames.length * runs } }),
        ...(reused.length > 0 && {
          reused: reused.map((r) => ({
            tool: r.tool,
            from: r.from.replace(/\\/g, "/"),
            sessions: r.records.length,
            prompts_verified: r.prompts_verified,
            claude_version: r.source_meta.claude_version ?? null,
            harness_commit: r.source_meta.harness_commit ?? null,
            started_at: r.source_meta.started_at ?? null,
          })),
        }),
        model_requested: model ?? null,
        models_observed: observedModels,
        claude_version: claudeVersion,
        harness_commit: gitHead,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        ...(resumeFrom && {
          resumed: {
            from: resumeFrom.replace(/\\/g, "/"),
            at: resumedAt.toISOString(),
            kept: records.filter((r) => kept.includes(r)).length,
            rerun: records.filter((r) => !kept.includes(r) && !r.reused_from).length,
            discarded_failed_launches: previous.length - kept.length,
            previous_claude_version: previousMeta?.claude_version ?? null,
          },
        }),
      },
      summary,
      runs: records,
    },
    null,
    2
  ) + "\n"
);
rmSync(partialOut, { force: true });
// The exact tasks this run used, prompts included, next to its results.
// benchmarks/generated/ is regenerated as taskgen changes (the cycle and trap
// prompts were reworded after the first long-loop runs), so a results file must
// not depend on it to be reproducible.
const tasksOut = out.replace(/\.json$/, ".tasks.json");
writeFileSync(tasksOut, JSON.stringify({ ...taskSet, tasks }, null, 2) + "\n");

const fmt = (n: number | null) => (n === null ? "-" : Math.round(n).toLocaleString("en-US"));
const table = (title: string, cells: CellSummary[]) => {
  console.log(`\n${title}`);
  console.log("| key | tool | accuracy | tokens / correct | median tokens [IQR] | median calls | errors | capped |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const c of cells) {
    console.log(
      `| ${c.key} | ${c.tool} | ${c.correct}/${c.runs} | ${fmt(c.tokens_per_correct)} | ` +
        `${fmt(c.median_tokens)} [${fmt(c.tokens_q1)}-${fmt(c.tokens_q3)}] | ${fmt(c.median_tool_calls)} | ${c.errors} | ${c.capped} |`
    );
  }
};
table("By category", summary.by_category);
table("Overall", summary.overall);
if (observedModels.length > 1) console.log(`\nWARNING: more than one model answered: ${observedModels.join(", ")}`);
console.log(`\nResults -> ${out}`);
