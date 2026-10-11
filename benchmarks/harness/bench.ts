import type { Task } from "../taskgen/generate.js";
import type { ClaudeRunOutput, ClaudeRunRequest, TranscriptMetrics } from "./claude.js";
import { buildPrompt, gradeAnswer, type Grade } from "./grade.js";
import { mean, median, quantile } from "./stats.js";

/**
 * Orchestration and scoring for the generated-task harness, independent of how an
 * agent is actually launched: `runner` is Claude Code in real use and a stub in
 * tests. Every arm gets the identical prompt, model, repo checkout and built-in
 * toolset by default. An arm may differ in its MCP config, and - for a competitor
 * that is a CLI rather than an MCP server - its built-in tools, PATH, environment
 * and a system-prompt note saying what it has (see benchmarks/tools.json).
 */

export interface ToolArm {
  name: string;
  /** Omitted for the baseline arm. */
  mcpConfigPath?: string;
  /** Per-arm launch settings - see ClaudeRunRequest. Omitted = Read/Grep/Glob, no extras. */
  builtinTools?: string;
  env?: Record<string, string>;
  pathPrepend?: string[];
  appendSystemPrompt?: string;
}

export type Runner = (req: ClaudeRunRequest) => ClaudeRunOutput;

export interface RunRecord {
  task_id: string;
  category: Task["category"];
  tool: string;
  run: number;
  /** False if the agent process itself failed; such a run counts as wrong, not as missing. */
  ok: boolean;
  error?: string;
  session_id?: string;
  wall_ms?: number;
  cost_usd?: number | null;
  num_turns?: number | null;
  metrics?: TranscriptMetrics;
  grade: Grade;
  final_text?: string;
  /** The session hit the turn cap before answering (graded on whatever it said, usually nothing). */
  capped?: boolean;
  /** Copied from an earlier results file by --reuse, not run in this attempt. */
  reused_from?: string;
}

export interface BenchmarkOptions {
  tasks: Task[];
  tools: ToolArm[];
  runs: number;
  runner: Runner;
  repoRoot: string;
  model?: string;
  /** `kept` is true for a record carried over from `keep`, not run now. */
  onRun?: (record: RunRecord, done: number, total: number, kept: boolean) => void;
  /**
   * Successful records from an earlier, interrupted attempt (--resume). A
   * (task, tool, run) with an ok record here is carried over instead of re-run;
   * everything else - never run, or failed to launch - runs now, in the usual
   * rotated order.
   */
  keep?: RunRecord[];
  /** Checked before each new launch; true stops the run there and returns what finished (--max-spend). */
  shouldStop?: () => boolean;
}

export function runBenchmark(opts: BenchmarkOptions): RunRecord[] {
  const records: RunRecord[] = [];
  const total = opts.tasks.length * opts.tools.length * opts.runs;

  for (let run = 0; run < opts.runs; run++) {
    for (const [ti, task] of opts.tasks.entries()) {
      // Rotate which arm goes first, so no arm is always first (or last) in
      // wall-clock order across a long run - rate limits and API latency drift.
      const shift = (run + ti) % opts.tools.length;
      const order = [...opts.tools.slice(shift), ...opts.tools.slice(0, shift)];
      for (const tool of order) {
        const base = { task_id: task.id, category: task.category, tool: tool.name, run };
        const kept = opts.keep?.find((r) => r.ok && r.task_id === task.id && r.tool === tool.name && r.run === run);
        if (kept) {
          records.push(kept);
          opts.onRun?.(kept, records.length, total, true);
          continue;
        }
        if (opts.shouldStop?.()) return records;
        let record: RunRecord;
        try {
          const out = opts.runner({
            prompt: buildPrompt(task),
            cwd: opts.repoRoot,
            mcpConfigPath: tool.mcpConfigPath,
            builtinTools: tool.builtinTools,
            env: tool.env,
            pathPrepend: tool.pathPrepend,
            appendSystemPrompt: tool.appendSystemPrompt,
            model: opts.model,
          });
          record = {
            ...base,
            ok: true,
            session_id: out.session_id,
            wall_ms: out.wall_ms,
            cost_usd: out.cost_usd,
            num_turns: out.num_turns,
            metrics: out.metrics,
            grade: gradeAnswer(task, out.final_text, opts.repoRoot),
            final_text: out.final_text,
            ...(out.capped && { capped: true }),
          };
        } catch (err) {
          record = {
            ...base,
            ok: false,
            error: (err as Error).message,
            grade: { parsed: false, correct: false, score: 0, reason: "agent run failed" },
          };
        }
        records.push(record);
        opts.onRun?.(record, records.length, total, false);
      }
    }
  }
  return records;
}

export interface CellSummary {
  key: string;
  tool: string;
  runs: number;
  errors: number;
  /** Runs stopped by the turn cap. Reported apart: each one is a wrong answer the cap may have caused. */
  capped: number;
  correct: number;
  accuracy: number;
  mean_score: number | null;
  median_tokens: number | null;
  tokens_q1: number | null;
  tokens_q3: number | null;
  median_tokens_when_correct: number | null;
  /** Total tokens spent across all runs / number of correct answers: the expected
   *  cost of getting one right answer. Null when nothing was answered correctly. */
  tokens_per_correct: number | null;
  median_tool_calls: number | null;
  median_wall_ms: number | null;
}

function summarizeCell(key: string, tool: string, rs: RunRecord[]): CellSummary {
  const measured = rs.filter((r) => r.metrics);
  const tokens = measured.map((r) => r.metrics!.total_tokens);
  const correct = rs.filter((r) => r.grade.correct);
  const spent = tokens.reduce((a, b) => a + b, 0);
  return {
    key,
    tool,
    runs: rs.length,
    errors: rs.filter((r) => !r.ok).length,
    capped: rs.filter((r) => r.capped).length,
    correct: correct.length,
    accuracy: rs.length === 0 ? 0 : correct.length / rs.length,
    mean_score: mean(rs.map((r) => r.grade.score)),
    median_tokens: median(tokens),
    tokens_q1: quantile(tokens, 0.25),
    tokens_q3: quantile(tokens, 0.75),
    median_tokens_when_correct: median(correct.filter((r) => r.metrics).map((r) => r.metrics!.total_tokens)),
    tokens_per_correct: correct.length === 0 ? null : spent / correct.length,
    median_tool_calls: median(measured.map((r) => r.metrics!.tool_calls)),
    median_wall_ms: median(rs.filter((r) => r.wall_ms !== undefined).map((r) => r.wall_ms!)),
  };
}

function groupBy(records: RunRecord[], keyOf: (r: RunRecord) => string): CellSummary[] {
  const groups = new Map<string, RunRecord[]>();
  for (const r of records) {
    const k = `${keyOf(r)}\u0000${r.tool}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return [...groups].map(([k, rs]) => summarizeCell(k.split("\u0000")[0], rs[0].tool, rs));
}

export function summarize(records: RunRecord[]) {
  return {
    by_task: groupBy(records, (r) => r.task_id),
    by_category: groupBy(records, (r) => r.category),
    overall: groupBy(records, () => "all"),
  };
}
