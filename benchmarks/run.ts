#!/usr/bin/env tsx
/**
 * Benchmark harness (plan §8/B). Runs each task under both arms, N times, from a
 * FRESH session per run, and reports MEDIAN tool-calls / total-tokens per task.
 *
 * Primary metrics are machine-counted by parsing Claude Code's session transcript
 * JSONL: tool_use blocks are tallied by name, and each assistant turn's
 * message.usage (input/output/cache-creation/cache-read tokens) is summed. This
 * was verified against real local transcripts (plan §12 risk) before being relied
 * on here:
 *   - assistant turns are `{type:"assistant", isSidechain, message:{content:[...]}}`
 *   - tool calls are `{type:"tool_use", name, input}` blocks in that content array
 *   - built-in tools are named "Read"/"Grep"/"Glob"/...; MCP tools are named
 *     "mcp__<server-name>__<tool-name>"
 *   - the transcript file lives at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl,
 *     but the encoding scheme isn't worth reverse-engineering: since we choose the
 *     session id ourselves (--session-id), we just glob for it by filename instead.
 *
 * Two more things were verified empirically (not assumed) before this was trusted:
 *   1. `--tools` only restricts the BUILT-IN toolset; MCP tool availability is a
 *      separate axis controlled by --mcp-config/--strict-mcp-config. So both arms
 *      pass the same --tools list, and --mcp-config is the only difference.
 *   2. The very first turn's tool list can be snapshotted before our MCP server
 *      (spawned fresh per run) finishes its handshake (~1s). For the short
 *      single-fact smoke prompts used to verify this, the model fell back to Grep
 *      before the MCP tools came online. For realistic multi-turn navigation tasks
 *      (what tasks.json actually contains), the connection catches up within a
 *      couple of turns and the MCP tools do get used. This IS the real, honest
 *      behavior of a freshly-started MCP server, not a harness bug — worth keeping
 *      in mind when reading a spread that skews toward Grep on any given run.
 *
 * `--setting-sources project,local` excludes the operator's personal user-level
 * config (custom CLAUDE.md discovery, auto-memory, etc.) from every run, verified
 * against a real transcript to remove an off-task file read that had nothing to do
 * with the target repo. `--bare` would do this more thoroughly but requires
 * ANTHROPIC_API_KEY-based auth and breaks OAuth/keychain-authenticated sessions,
 * so it's not used here.
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openDb } from "../src/storage/db.js";
import { reindex } from "../src/engine/index.js";
import { resolveClaudeBin, runClaude } from "./harness/claude.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

type Arm = "baseline" | "assisted";

interface Task {
  id: string;
  prompt: string;
  oracle: { description: string; files: string[] };
}

interface BenchConfig {
  repo: { name: string; dir?: string; url: string; commit: string; tsconfig: string; note: string };
  protocol: { runs_per_arm: number; arms: Arm[]; note: string };
  tasks: Task[];
}

interface Metrics {
  tool_calls: number; // Read + Grep + Glob + any MCP tool
  total_tokens: number; // sum of input+output+cache tokens across the transcript's assistant turns
}

interface RunResult {
  session_id: string;
  metrics: Metrics;
  located_oracle: boolean; // best-effort: does the final answer mention an oracle file's basename?
}

/**
 * Which task set to run. `--config=` takes a path (or a bare name: `nest` ->
 * benchmarks/tasks-nest.json), defaulting to the original TypeORM set.
 *
 * Read straight from argv rather than through parseArgs() because the target repo
 * and index paths below are module-level constants derived from it.
 */
function resolveConfigPath(argv: string[]): string {
  const raw = argv.find((a) => a.startsWith("--config="))?.slice("--config=".length);
  if (!raw) return join(__dirname, "tasks.json");
  for (const candidate of [raw, join(__dirname, raw), join(__dirname, `tasks-${raw}.json`)]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`--config=${raw}: no such task file (tried it as a path, and as benchmarks/tasks-${raw}.json)`);
}

const CONFIG_PATH = resolveConfigPath(process.argv.slice(2));
const config: BenchConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

// Each target gets its own clone directory and its own index, so switching task
// sets never silently reuses the previous target's index. `dir` defaults to
// "target-repo" to keep the original TypeORM config working unchanged.
const TARGET_DIR = config.repo.dir ?? "target-repo";
const TARGET_REPO = join(__dirname, TARGET_DIR);
const TARGET_TSCONFIG = join(TARGET_REPO, config.repo.tsconfig);
const INDEX_DB = join(__dirname, `${TARGET_DIR}-index.db`);
const MCP_SERVER_ENTRY = join(PROJECT_ROOT, "dist", "mcp-server", "index.js");
const MCP_SERVER_NAME = "rie";

/** Build the project and index the target repo, so the assisted arm's MCP server
 * serves reads against an already-built index (not an extra "reindex" call the
 * agent would need to make itself, which a real user wouldn't do per-question). */
function buildProjectAndIndex(): void {
  console.log("Building repo-intelligence-engine (npm run build)...");
  const build = spawnSync("npm", ["run", "build"], { cwd: PROJECT_ROOT, stdio: "inherit", shell: true });
  if (build.status !== 0) throw new Error("npm run build failed");
  if (!existsSync(MCP_SERVER_ENTRY)) {
    throw new Error(`expected build output missing: ${MCP_SERVER_ENTRY}`);
  }

  if (!existsSync(TARGET_TSCONFIG)) {
    throw new Error(
      `target repo not found at ${TARGET_REPO} (expected tsconfig at ${TARGET_TSCONFIG}). ` +
        `Clone ${config.repo.url} (commit ${config.repo.commit}) into benchmarks/${TARGET_DIR} first.`
    );
  }

  console.log(`Indexing ${config.repo.name} -> ${INDEX_DB} ...`);
  const db = openDb(INDEX_DB);
  reindex(db, TARGET_TSCONFIG);
  db.close();
}

/** Writes an MCP config file naming exactly our server, for --mcp-config. */
function writeMcpConfig(): string {
  const cfg = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [MCP_SERVER_ENTRY],
        env: { RIE_DB: INDEX_DB, RIE_TSCONFIG: TARGET_TSCONFIG },
      },
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "rie-bench-"));
  const path = join(dir, "mcp-config.json");
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}

function runOnce(task: Task, arm: Arm, mcpConfigPath: string, claudeBin: string): RunResult {
  let out;
  try {
    out = runClaude(claudeBin, {
      prompt: task.prompt,
      cwd: TARGET_REPO,
      mcpConfigPath: arm === "assisted" ? mcpConfigPath : undefined,
    });
  } catch (err) {
    throw new Error(`task=${task.id} arm=${arm}: ${(err as Error).message}`);
  }

  const located = task.oracle.files.some((f) => {
    const basename = f.split(":")[0].split("/").pop()!;
    return out.final_text.includes(basename);
  });

  return {
    session_id: out.session_id,
    metrics: { tool_calls: out.metrics.tool_calls, total_tokens: out.metrics.total_tokens },
    located_oracle: located,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface ArmSummary {
  median_tool_calls: number;
  median_tokens: number;
  n: number;
  runs: RunResult[];
}

function parseArgs(argv: string[]) {
  const get = (flag: string) => argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const taskIds = get("--tasks")?.split(",") ?? null;
  const arms = (get("--arms")?.split(",") as Arm[] | undefined) ?? config.protocol.arms;
  const runsPerArm = get("--runs") ? Number(get("--runs")) : config.protocol.runs_per_arm;
  const skipBuild = argv.includes("--skip-build");
  return { taskIds, arms, runsPerArm, skipBuild };
}

async function main() {
  const { taskIds, arms, runsPerArm, skipBuild } = parseArgs(process.argv.slice(2));
  const tasks = taskIds ? config.tasks.filter((t) => taskIds.includes(t.id)) : config.tasks;
  if (tasks.length === 0) throw new Error("no matching tasks (check --tasks=<id,...>)");

  const claudeBin = resolveClaudeBin();
  if (!skipBuild) buildProjectAndIndex();
  const mcpConfigPath = arms.includes("assisted") ? writeMcpConfig() : "";

  console.log(`\nBenchmark: ${config.repo.name} @ ${config.repo.commit.slice(0, 8)}  (${CONFIG_PATH})`);
  console.log(`tasks=${tasks.map((t) => t.id).join(",")} arms=${arms.join(",")} runsPerArm=${runsPerArm}\n`);

  const summary: Record<string, Partial<Record<Arm, ArmSummary>>> = {};

  for (const task of tasks) {
    summary[task.id] = {};
    for (const arm of arms) {
      const runs: RunResult[] = [];
      for (let i = 0; i < runsPerArm; i++) {
        process.stdout.write(`  ${task.id} / ${arm} / run ${i + 1}/${runsPerArm} ... `);
        const r = runOnce(task, arm, mcpConfigPath, claudeBin);
        console.log(
          `tool_calls=${r.metrics.tool_calls} total_tokens=${r.metrics.total_tokens} located=${r.located_oracle}`
        );
        runs.push(r);
      }
      summary[task.id][arm] = {
        median_tool_calls: median(runs.map((r) => r.metrics.tool_calls)),
        median_tokens: median(runs.map((r) => r.metrics.total_tokens)),
        n: runs.length,
        runs,
      };
    }
  }

  console.log("\n| task | arm | median tool-calls | median tokens | n |");
  console.log("|---|---|---|---|---|");
  for (const task of tasks) {
    for (const arm of arms) {
      const s = summary[task.id][arm];
      if (!s) continue;
      console.log(`| ${task.id} | ${arm} | ${s.median_tool_calls} | ${s.median_tokens} | ${s.n} |`);
    }
  }

  const resultsDir = join(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(resultsDir, `${config.repo.name}-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({ repo: config.repo, arms, runsPerArm, summary }, null, 2));
  console.log(`\nResults written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
