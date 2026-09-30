#!/usr/bin/env tsx
/**
 * Re-grade a finished results file with the current grader, without running any agent.
 *
 *   npm run regrade -- --config=directus <results.json> [<results.json> ...]
 *
 * Every run keeps its saved final_text, so a grader fix can be applied to past
 * results. The file is rewritten in place: grades and summary are recomputed, and
 * meta.regraded records when, and every run whose verdict changed (old -> new
 * reason), so a changed number is never silent. The original stays in git history.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GeneratedTaskSet } from "../taskgen/generate.js";
import { gradeAnswer } from "./grade.js";
import { summarize, type RunRecord } from "./bench.js";

const BENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const configName = args.find((a) => a.startsWith("--config="))?.slice("--config=".length);
const files = args.filter((a) => !a.startsWith("--"));
if (!configName || files.length === 0) {
  throw new Error("usage: npm run regrade -- --config=<name> <results.json> [...]");
}

const configPath = [configName, join(BENCH_DIR, configName), join(BENCH_DIR, `tasks-${configName}.json`)].find(existsSync);
if (!configPath) throw new Error(`--config=${configName}: no such task file`);
const config = JSON.parse(readFileSync(configPath, "utf8")) as { repo: { dir?: string; tsconfig: string } };
const repoRoot = dirname(join(BENCH_DIR, config.repo.dir ?? "target-repo", config.repo.tsconfig)).replace(/\\/g, "/");

interface ResultsFile {
  meta: { task_set: string; regraded?: unknown[] } & Record<string, unknown>;
  summary: unknown;
  runs: RunRecord[];
}

for (const file of files) {
  const results = JSON.parse(readFileSync(file, "utf8")) as ResultsFile;
  const taskSet = JSON.parse(readFileSync(results.meta.task_set, "utf8")) as GeneratedTaskSet;
  const tasks = new Map(taskSet.tasks.map((t) => [t.id, t]));

  const changed: { task_id: string; tool: string; run: number; before: string; after: string }[] = [];
  for (const run of results.runs) {
    if (!run.ok || run.final_text === undefined) continue; // failed sessions have nothing to grade
    const task = tasks.get(run.task_id);
    if (!task) throw new Error(`${file}: task ${run.task_id} is not in ${results.meta.task_set}`);
    const grade = gradeAnswer(task, run.final_text, repoRoot);
    if (grade.correct !== run.grade.correct) {
      const verdict = (g: RunRecord["grade"]) => (g.correct ? "correct" : `wrong (${g.reason ?? "incorrect"})`);
      changed.push({ task_id: run.task_id, tool: run.tool, run: run.run, before: verdict(run.grade), after: verdict(grade) });
    }
    run.grade = grade;
  }

  results.summary = summarize(results.runs);
  results.meta.regraded = [
    ...(results.meta.regraded ?? []),
    { at: new Date().toISOString(), note: "re-graded from saved final_text with the current grader", changed },
  ];
  writeFileSync(file, JSON.stringify(results, null, 2) + "\n");

  console.log(`${file}: ${changed.length} verdict(s) changed`);
  for (const c of changed) console.log(`  ${c.task_id} / ${c.tool} / run ${c.run + 1}: ${c.before} -> ${c.after}`);
}
