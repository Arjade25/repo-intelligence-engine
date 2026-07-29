#!/usr/bin/env tsx
/**
 * Benchmark harness (plan §8/B). Runs each task under both arms, N times, from a
 * FRESH session per run, and reports MEDIAN file-reads / tool-calls per task.
 *
 * Primary metrics are machine-counted by parsing Claude Code's session transcript
 * JSONL and tallying tool_use blocks by name. This was verified against real local
 * transcripts (plan §12 risk) before being relied on here:
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
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { openDb } from "../src/storage/db.js";
import { reindex } from "../src/engine/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

type Arm = "baseline" | "assisted";

interface Task {
  id: string;
  prompt: string;
  oracle: { description: string; files: string[] };
}

interface BenchConfig {
  repo: { name: string; url: string; commit: string; tsconfig: string; note: string };
  protocol: { runs_per_arm: number; arms: Arm[]; note: string };
  tasks: Task[];
}

interface Metrics {
  file_reads: number; // count of Read tool_use blocks
  tool_calls: number; // Read + Grep + Glob + any MCP tool
}

interface RunResult {
  session_id: string;
  metrics: Metrics;
  located_oracle: boolean; // best-effort: does the final answer mention an oracle file's basename?
}

const config: BenchConfig = JSON.parse(readFileSync(join(__dirname, "tasks.json"), "utf8"));

const TARGET_REPO = join(__dirname, "target-repo");
const TARGET_TSCONFIG = join(TARGET_REPO, config.repo.tsconfig);
const INDEX_DB = join(__dirname, "target-repo-index.db");
const MCP_SERVER_ENTRY = join(PROJECT_ROOT, "dist", "mcp-server", "index.js");
const MCP_SERVER_NAME = "rie";

const READ_ONLY_TOOLS = "Read,Grep,Glob";
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

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
        `Clone ${config.repo.url} (commit ${config.repo.commit}) into benchmarks/target-repo first.`
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

/** Locate a run's transcript by globbing for the session id we chose ourselves -
 * sidesteps needing to replicate Claude Code's cwd -> project-directory-name
 * encoding, which was observed to vary in casing between runs. */
function findTranscript(sessionId: string): string {
  const projectsDir = join(CLAUDE_CONFIG_DIR, "projects");
  for (const entry of readdirSync(projectsDir)) {
    const candidate = join(projectsDir, entry, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`transcript not found for session ${sessionId} under ${projectsDir}`);
}

/** Tally tool_use blocks by name from assistant turns, skipping subagent sidechains. */
function parseMetrics(transcriptPath: string): Metrics {
  const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
  let fileReads = 0;
  let toolCalls = 0;

  for (const line of lines) {
    let record: { type?: string; isSidechain?: boolean; message?: { content?: unknown } };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "assistant" || record.isSidechain) continue;

    const content = record.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content as { type?: string; name?: string }[]) {
      if (block.type !== "tool_use") continue;
      toolCalls++;
      if (block.name === "Read") fileReads++;
    }
  }

  return { file_reads: fileReads, tool_calls: toolCalls };
}

function runOnce(task: Task, arm: Arm, mcpConfigPath: string): RunResult {
  const sessionId = randomUUID();

  const args = [
    "-p",
    task.prompt,
    "--session-id",
    sessionId,
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    "--tools",
    READ_ONLY_TOOLS,
    "--setting-sources",
    "project,local",
    "--strict-mcp-config",
  ];
  if (arm === "assisted") {
    args.push("--mcp-config", mcpConfigPath);
  }

  // shell:false is deliberate: shell:true concatenates+re-splits args without
  // escaping (Node warns on this), which silently breaks multi-word prompts like
  // task.prompt into separate argv tokens - verified this actually happens on
  // Windows before switching. claude resolves fine as a direct executable.
  const result = spawnSync("claude", args, { cwd: TARGET_REPO, encoding: "utf8", shell: false, stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`claude exited ${result.status} for task=${task.id} arm=${arm}: ${result.stderr}`);
  }

  let finalText = "";
  try {
    finalText = (JSON.parse(result.stdout) as { result?: string }).result ?? "";
  } catch {
    finalText = result.stdout;
  }

  const metrics = parseMetrics(findTranscript(sessionId));
  const located = task.oracle.files.some((f) => {
    const basename = f.split(":")[0].split("/").pop()!;
    return finalText.includes(basename);
  });

  return { session_id: sessionId, metrics, located_oracle: located };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface ArmSummary {
  median_file_reads: number;
  median_tool_calls: number;
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

  if (!skipBuild) buildProjectAndIndex();
  const mcpConfigPath = arms.includes("assisted") ? writeMcpConfig() : "";

  console.log(`\nBenchmark: ${config.repo.name} @ ${config.repo.commit.slice(0, 8)}`);
  console.log(`tasks=${tasks.map((t) => t.id).join(",")} arms=${arms.join(",")} runsPerArm=${runsPerArm}\n`);

  const summary: Record<string, Partial<Record<Arm, ArmSummary>>> = {};

  for (const task of tasks) {
    summary[task.id] = {};
    for (const arm of arms) {
      const runs: RunResult[] = [];
      for (let i = 0; i < runsPerArm; i++) {
        process.stdout.write(`  ${task.id} / ${arm} / run ${i + 1}/${runsPerArm} ... `);
        const r = runOnce(task, arm, mcpConfigPath);
        console.log(
          `file_reads=${r.metrics.file_reads} tool_calls=${r.metrics.tool_calls} located=${r.located_oracle}`
        );
        runs.push(r);
      }
      summary[task.id][arm] = {
        median_file_reads: median(runs.map((r) => r.metrics.file_reads)),
        median_tool_calls: median(runs.map((r) => r.metrics.tool_calls)),
        n: runs.length,
        runs,
      };
    }
  }

  console.log("\n| task | arm | median file-reads | median tool-calls | n |");
  console.log("|---|---|---|---|---|");
  for (const task of tasks) {
    for (const arm of arms) {
      const s = summary[task.id][arm];
      if (!s) continue;
      console.log(`| ${task.id} | ${arm} | ${s.median_file_reads} | ${s.median_tool_calls} | ${s.n} |`);
    }
  }

  const resultsDir = join(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });
  const outPath = join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(outPath, JSON.stringify({ repo: config.repo, arms, runsPerArm, summary }, null, 2));
  console.log(`\nResults written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
