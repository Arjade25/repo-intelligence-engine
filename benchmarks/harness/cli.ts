#!/usr/bin/env tsx
/**
 * Generated-task benchmark harness (plan step 4).
 *
 *   npm run harness -- --config=nest [--tools=baseline,rie] [--runs=3] [--model=<id>]
 *   npm run harness -- --tsconfig=<path> --tasks=<generated.json> [...]
 *
 * Filters: --category=cycle_trace,change_impact  --task-ids=id,id  --limit=N
 * Other:   --skip-build  --dry-run (print the plan and exact agent command, spawn nothing)
 *          --out=<path>  (default benchmarks/results/harness/<label>-<timestamp>.json)
 *
 * Every run is a fresh headless Claude Code session in the target repo with the
 * same prompt, model and built-in tools; arms differ only in the one MCP server
 * they load. Results keep every run's transcript metrics, final text and grade,
 * so a published number can always be traced back to the raw answers.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { GeneratedTaskSet, Task } from "../taskgen/generate.js";
import { openDb } from "../../src/storage/db.js";
import { reindex } from "../../src/engine/index.js";
import { claudeArgs, resolveClaudeBin, runClaude } from "./claude.js";
import { runBenchmark, summarize, type CellSummary, type ToolArm } from "./bench.js";
import { buildPrompt } from "./grade.js";

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
}
const registry = (JSON.parse(readFileSync(join(BENCH_DIR, "tools.json"), "utf8")) as { tools: Record<string, ToolSpec> }).tools;
const toolNames = list("tools") ?? Object.keys(registry);
for (const name of toolNames) if (!registry[name]) throw new Error(`unknown tool "${name}" (see benchmarks/tools.json)`);

const runs = Number(flag("runs") ?? 3);
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
  if (!spec.mcp) return { name };
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
  return { name, mcpConfigPath: path };
});

console.log(`Task set: ${tasksPath} (${taskSet.repo})`);
console.log(`Repo root: ${repoRoot}`);
console.log(`Tasks: ${tasks.length}  Tools: ${toolNames.join(", ")}  Runs per tool: ${runs}  Model: ${model ?? "(CLI default)"}`);
console.log(`Agent sessions to launch: ${tasks.length * tools.length * runs}`);

if (dryRun) {
  const sample = tasks[0];
  console.log(`\n--- prompt for ${sample.id} (identical on every arm) ---\n${buildPrompt(sample)}\n`);
  for (const tool of tools) {
    const argv = claudeArgs({ prompt: "<prompt>", cwd: repoRoot, mcpConfigPath: tool.mcpConfigPath, model }, "<session-id>");
    console.log(`[${tool.name}] claude ${argv.join(" ")}`);
    if (tool.mcpConfigPath) console.log(readFileSync(tool.mcpConfigPath, "utf8"));
  }
  process.exit(0);
}

// --- setup + run --------------------------------------------------------------------
const claudeBin = resolveClaudeBin();
const setups = new Set(toolNames.map((n) => registry[n].setup).filter(Boolean));
if (setups.has("rie-index")) {
  if (!args.includes("--skip-build")) {
    console.log("Building repo-intelligence-engine (npm run build)...");
    const build = spawnSync("npm", ["run", "build"], { cwd: PROJECT_ROOT, stdio: "inherit", shell: true });
    if (build.status !== 0) throw new Error("npm run build failed");
  }
  if (!existsSync(join(PROJECT_ROOT, "dist", "mcp-server", "index.js"))) throw new Error("dist/mcp-server/index.js missing - build first");
  console.log(`Indexing ${tsconfigPath} -> ${rieDb} ...`);
  const db = openDb(rieDb);
  reindex(db, tsconfigPath);
  db.close();
}

const startedAt = new Date();
const records = runBenchmark({
  tasks,
  tools,
  runs,
  model,
  repoRoot,
  runner: (req) => runClaude(claudeBin, req),
  onRun: (r, done, total) => {
    const m = r.metrics;
    const verdict = !r.ok ? `ERROR ${r.error?.split("\n")[0]}` : r.grade.correct ? "correct" : `wrong (${r.grade.reason ?? "incorrect"})`;
    console.log(
      `[${done}/${total}] ${r.task_id} / ${r.tool} / run ${r.run + 1}: ` +
        (m ? `${m.tool_calls} calls, ${m.total_tokens} tokens, ` : "") +
        verdict
    );
  },
});

const summary = summarize(records);
const gitHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).stdout.trim();
const claudeVersion = spawnSync(claudeBin, ["--version"], { encoding: "utf8" }).stdout.trim();
const observedModels = [...new Set(records.flatMap((r) => r.metrics?.models ?? []))].sort();

const out =
  flag("out") ?? join(BENCH_DIR, "results", "harness", `${label}-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      meta: {
        task_set: tasksPath.replace(/\\/g, "/"),
        repo: taskSet.repo,
        tsconfig_flags: taskSet.tsconfig_flags,
        tools: Object.fromEntries(toolNames.map((n) => [n, registry[n].description])),
        runs_per_tool: runs,
        model_requested: model ?? null,
        models_observed: observedModels,
        claude_version: claudeVersion,
        harness_commit: gitHead,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
      },
      summary,
      runs: records,
    },
    null,
    2
  ) + "\n"
);

const fmt = (n: number | null) => (n === null ? "-" : Math.round(n).toLocaleString("en-US"));
const table = (title: string, cells: CellSummary[]) => {
  console.log(`\n${title}`);
  console.log("| key | tool | accuracy | tokens / correct | median tokens [IQR] | median calls | errors |");
  console.log("|---|---|---|---|---|---|---|");
  for (const c of cells) {
    console.log(
      `| ${c.key} | ${c.tool} | ${c.correct}/${c.runs} | ${fmt(c.tokens_per_correct)} | ` +
        `${fmt(c.median_tokens)} [${fmt(c.tokens_q1)}-${fmt(c.tokens_q3)}] | ${fmt(c.median_tool_calls)} | ${c.errors} |`
    );
  }
};
table("By category", summary.by_category);
table("Overall", summary.overall);
if (observedModels.length > 1) console.log(`\nWARNING: more than one model answered: ${observedModels.join(", ")}`);
console.log(`\nResults -> ${out}`);
