import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../taskgen/generate.js";
import type { RunRecord } from "./bench.js";
import { buildPrompt } from "./grade.js";

/**
 * Spending controls for the harness: a cost estimate from earlier results before
 * anything launches, and reuse of an arm's earlier sessions instead of paying for
 * them again. The Read/Grep baseline is ~70% of a three-arm run's cost, and it
 * doesn't change when RIE does.
 */

export interface PastSession {
  repo: string;
  tool: string;
  category: string;
  cost_usd: number;
}

/** Every successful session with a recorded cost, from the results files in `dir`. */
export function loadCostHistory(dir: string): PastSession[] {
  if (!existsSync(dir)) return [];
  const out: PastSession[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f.endsWith(".tasks.json")) continue;
    let results: { meta?: { repo?: string }; runs?: RunRecord[] };
    try {
      results = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    const repo = results.meta?.repo ?? "";
    for (const r of results.runs ?? []) {
      if (r.ok && typeof r.cost_usd === "number") out.push({ repo, tool: r.tool, category: r.category, cost_usd: r.cost_usd });
    }
  }
  return out;
}

export interface ArmEstimate {
  tool: string;
  sessions: number;
  usd: number | null;
  /** Which past sessions the average came from, most specific first; "none" = no history for this arm. */
  basis: string;
}

/**
 * Expected spend: per arm, sessions x the mean past cost of the closest match -
 * the same repo, arm and category, else the arm and category on any repo, else the
 * arm on anything. A rough figure: costs vary by task, and cache hits move them.
 */
export function estimateCost(
  history: PastSession[],
  repo: string,
  tasks: Task[],
  tools: string[],
  runs: number
): { arms: ArmEstimate[]; total_usd: number | null } {
  const mean = (xs: PastSession[]) => xs.reduce((s, x) => s + x.cost_usd, 0) / xs.length;
  const arms = tools.map((tool): ArmEstimate => {
    let usd = 0;
    const bases = new Set<string>();
    for (const task of tasks) {
      const levels: [string, PastSession[]][] = [
        [`${repo} ${task.category}`, history.filter((h) => h.tool === tool && h.repo === repo && h.category === task.category)],
        [`any repo, ${task.category}`, history.filter((h) => h.tool === tool && h.category === task.category)],
        ["any task", history.filter((h) => h.tool === tool)],
      ];
      const hit = levels.find(([, xs]) => xs.length > 0);
      if (!hit) return { tool, sessions: tasks.length * runs, usd: null, basis: "none" };
      usd += mean(hit[1]) * runs;
      bases.add(`${hit[0]} (n=${hit[1].length})`);
    }
    return { tool, sessions: tasks.length * runs, usd, basis: [...bases].join("; ") };
  });
  const known = arms.every((a) => a.usd !== null);
  return { arms, total_usd: known ? arms.reduce((s, a) => s + a.usd!, 0) : null };
}

export interface ReuseSource {
  tool: string;
  path: string;
}

export interface ReusedArm {
  tool: string;
  from: string;
  records: RunRecord[];
  /** Whether each task's prompt was checked against the source run's saved task set. */
  prompts_verified: boolean;
  source_meta: Record<string, unknown>;
}

/**
 * --reuse=<tool>=<results.json>: that arm's sessions from an earlier run, for the
 * same tasks and run numbers, instead of new ones. Refuses when any (task, run) is
 * missing or failed there, or when a task's prompt differs from the one that run
 * used (the trap and cycle prompts were reworded once already). A source written
 * before results kept their task set can't be checked; it is used with
 * prompts_verified: false, which the results file records.
 */
export function loadReusedArm(source: ReuseSource, tasks: Task[], runs: number): ReusedArm {
  const prior = JSON.parse(readFileSync(source.path, "utf8")) as { meta: Record<string, unknown>; runs: RunRecord[] };
  const tasksFile = source.path.replace(/\.json$/, ".tasks.json");
  const priorTasks = existsSync(tasksFile)
    ? new Map((JSON.parse(readFileSync(tasksFile, "utf8")) as { tasks: Task[] }).tasks.map((t) => [t.id, t]))
    : null;

  const problems: string[] = [];
  const records: RunRecord[] = [];
  for (const task of tasks) {
    if (priorTasks) {
      const before = priorTasks.get(task.id);
      if (!before) problems.push(`${task.id}: not in ${tasksFile}`);
      else if (buildPrompt(before) !== buildPrompt(task)) problems.push(`${task.id}: prompt changed since that run`);
    }
    for (let run = 0; run < runs; run++) {
      const r = prior.runs.find((x) => x.ok && x.tool === source.tool && x.task_id === task.id && x.run === run);
      if (r) records.push({ ...r, reused_from: source.path.replace(/\\/g, "/") });
      else problems.push(`${task.id} run ${run + 1}: no successful ${source.tool} session`);
    }
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, 10).join("\n  ");
    throw new Error(
      `--reuse=${source.tool}=${source.path} can't stand in for a new run:\n  ${shown}` +
        (problems.length > 10 ? `\n  ...and ${problems.length - 10} more` : "")
    );
  }
  return { tool: source.tool, from: source.path, records, prompts_verified: priorTasks !== null, source_meta: prior.meta };
}
