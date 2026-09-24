#!/usr/bin/env tsx
/**
 * Usage:
 *   npm run taskgen -- --config=nest [--out=path] [--seed=1] [--min-path=4] [--max=10] [--impact-candidates=15]
 *   npm run taskgen -- <path-to-tsconfig.json> --repo=<label> --prefix=<id-prefix> [...same flags]
 *
 * --config reads a benchmarks/tasks-<name>.json and generates against its pinned
 * clone (benchmarks/<repo.dir>, which must already be checked out at repo.commit).
 * Output defaults to benchmarks/generated/<prefix>.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateTasks } from "./generate.js";

const BENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const num = (name: string) => (flag(name) !== undefined ? Number(flag(name)) : undefined);

let tsconfigPath: string;
let repo: string;
let prefix: string;

const configName = flag("config");
if (configName) {
  const configPath = [configName, join(BENCH_DIR, configName), join(BENCH_DIR, `tasks-${configName}.json`)].find(existsSync);
  if (!configPath) throw new Error(`--config=${configName}: no such task file`);
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    repo: { name: string; dir?: string; url: string; commit: string; tsconfig: string };
  };
  tsconfigPath = join(BENCH_DIR, config.repo.dir ?? "target-repo", config.repo.tsconfig);
  if (!existsSync(tsconfigPath)) {
    throw new Error(`${tsconfigPath} not found - clone ${config.repo.url} at ${config.repo.commit} first`);
  }
  const slug = config.repo.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  repo = `${slug}@${config.repo.commit}`;
  prefix = flag("prefix") ?? config.repo.name;
} else {
  tsconfigPath = args.find((a) => !a.startsWith("--")) ?? "";
  repo = flag("repo") ?? "";
  prefix = flag("prefix") ?? "";
  if (!tsconfigPath || !repo || !prefix) {
    console.error("usage: npm run taskgen -- --config=<name> | <tsconfig.json> --repo=<label> --prefix=<id-prefix>");
    process.exit(1);
  }
}

const started = Date.now();
const set = generateTasks({
  tsconfigPath,
  repo,
  idPrefix: prefix,
  seed: num("seed"),
  minPath: num("min-path"),
  maxPerCategory: num("max"),
  maxImpactCandidates: num("impact-candidates"),
});

const out = flag("out") ?? join(BENCH_DIR, "generated", `${prefix}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(set, null, 2) + "\n");

const s = set.stats;
console.log(`${repo}: ${s.files} files, ${s.runtime_edges} runtime / ${s.source_edges} source edges`);
console.log(`runtime SCCs [${s.runtime_sccs.join(", ")}]  source SCCs [${s.source_sccs.join(", ")}]`);
console.log(`| category | candidates | passed min-path | emitted |`);
console.log(`|---|---|---|---|`);
console.log(`| cycle_trace | ${s.cycle_trace.candidates} | ${s.cycle_trace.passed_min_path} | ${s.cycle_trace.emitted} |`);
console.log(
  `| runtime_type_trap | ${s.runtime_type_trap.candidates} | ${s.runtime_type_trap.passed_min_path} ` +
    `(${s.runtime_type_trap.true_candidates} yes / ${s.runtime_type_trap.false_candidates} no) | ${s.runtime_type_trap.emitted} |`
);
console.log(`| change_impact | ${s.change_impact.candidates} checked | ${s.change_impact.passed_min_path} | ${s.change_impact.emitted} |`);
console.log(`\n${set.tasks.length} tasks -> ${out} (${Date.now() - started}ms)`);
