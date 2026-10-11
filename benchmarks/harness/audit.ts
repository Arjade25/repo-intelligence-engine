#!/usr/bin/env tsx
/**
 * Answer-leakage audit for a finished results file.
 *
 *   npm run audit -- --config=directus <results.json> [<results.json> ...]
 *
 * Target repos live inside this project (benchmarks/candidates/...), a few folders
 * below the generated tasks and their expected answers (benchmarks/generated/),
 * past results, and RIE itself. An arm with a shell can reach all of that with a
 * couple of `ls ..`. Every session's tool calls are scanned for:
 *   - a path into this project that is not under the target repo's git checkout
 *   - a relative path that climbs out of that checkout (`../..` from a package)
 * Flagged sessions are listed with the offending calls and recorded in
 * meta.audit; a published number should exclude them. Nothing is re-graded.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findTranscript } from "./claude.js";
import { gitRootPrefix } from "./grade.js";
import type { RunRecord } from "./bench.js";

const BENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = join(BENCH_DIR, "..");

export interface ToolUse {
  name: string;
  input: unknown;
}

/** Every tool call in a transcript, sidechains included - a subagent reading the answers counts too. */
export function toolUses(transcriptPath: string): ToolUse[] {
  const uses: ToolUse[] = [];
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as { type?: string; name?: string; input?: unknown }[]) {
      if (block.type === "tool_use") uses.push({ name: block.name ?? "?", input: block.input });
    }
  }
  return uses;
}

/**
 * Why this tool call leaves the target checkout, or null if it doesn't.
 * `checkout` is the git root the agent may legitimately read (for directus/api,
 * the directus monorepo), `climbs` how many `..` from the agent's cwd reach it.
 */
export function leakReason(use: ToolUse, projectRoot: string, checkout: string, climbs: number): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  // JSON doubles every backslash; undo that before normalizing separators.
  const text = norm(JSON.stringify(use.input).replace(/\\\\/g, "/"));
  // An agent's Bash is Git Bash on Windows, which spells D:/x as /d/x.
  const spellings = (p: string) => {
    const n = norm(p);
    const drive = n.match(/^([a-z]):\/(.*)$/);
    return drive ? [n, `/${drive[1]}/${drive[2]}`, `/mnt/${drive[1]}/${drive[2]}`] : [n];
  };
  const allowedForms = spellings(checkout);

  for (const project of spellings(projectRoot)) {
    let at = text.indexOf(project);
    while (at !== -1) {
      const rest = text.slice(at);
      // Inside = the checkout path itself, ending at a non-path character (`/`, quote, space...).
      const inside = allowedForms.some(
        (allowed) => rest.startsWith(allowed) && (rest.length === allowed.length || !/[\w.-]/.test(rest[allowed.length]))
      );
      if (!inside) return `path into the project outside the target checkout: ${rest.slice(0, 120)}`;
      at = text.indexOf(project, at + project.length);
    }
  }

  // The files that would leak an answer, however they are reached: the generated
  // tasks and expected answers, past results, the task configs, RIE's indexes,
  // and the oracle.
  const answers = text.match(
    /benchmarks\/generated|(^|[^\w-])generated\/[\w-]+\.json|results\/harness|tasks-[\w-]+\.json|\.tasks\.json|harness-[\w-]+-index\.db|benchmarks\/oracle/
  );
  if (answers) return `reference to benchmark answers or results: ${text.slice(Math.max(0, (answers.index ?? 0) - 40), (answers.index ?? 0) + 80)}`;

  // An unquoted `../..` climbing out of the checkout. A quoted one is skipped: the
  // shell arm greps source for import specifiers (`grep "from '../../services/"`),
  // which is text, not a path it opens - on the first bash-madge run that was all
  // 7 hits this rule produced, each checked by hand. A quoted path that does reach
  // an answer file is still caught by the check above.
  // Shell quotes only: `'`, or `"` - which JSON escapes, so it reads `/"` here. A
  // bare `"` is JSON's own quote around a value like a Read file_path, and stays checked.
  const notQuoted = `(?<![.\\w'/])(?<!/")`;
  const escape = new RegExp(`${notQuoted}(\\.\\./){${climbs + 1},}|${notQuoted}(\\.\\./){${climbs}}\\.\\.(?![/\\w.])`);
  const m = text.match(escape);
  if (m) return `relative path climbing out of the target checkout: ${text.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 60)}`;
  return null;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const configName = args.find((a) => a.startsWith("--config="))?.slice("--config=".length);
  const files = args.filter((a) => !a.startsWith("--"));
  if (!configName || files.length === 0) throw new Error("usage: npm run audit -- --config=<name> <results.json> [...]");

  const configPath = [configName, join(BENCH_DIR, configName), join(BENCH_DIR, `tasks-${configName}.json`)].find(existsSync);
  if (!configPath) throw new Error(`--config=${configName}: no such task file`);
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { repo: { dir?: string; tsconfig: string } };
  const repoRoot = dirname(join(BENCH_DIR, config.repo.dir ?? "target-repo", config.repo.tsconfig)).replace(/\\/g, "/");
  const prefix = gitRootPrefix(repoRoot); // "api/" for directus/api
  const climbs = prefix ? prefix.split("/").filter(Boolean).length : 0;
  const checkout = prefix ? repoRoot.slice(0, repoRoot.length - prefix.length).replace(/\/$/, "") : repoRoot;

  for (const file of files) {
    const results = JSON.parse(readFileSync(file, "utf8")) as { meta: Record<string, unknown>; runs: RunRecord[] };
    const flagged: { task_id: string; tool: string; run: number; session_id: string; reasons: string[] }[] = [];
    let scanned = 0;
    for (const run of results.runs) {
      if (!run.session_id) continue;
      scanned++;
      const reasons = toolUses(findTranscript(run.session_id))
        .map((u) => {
          const why = leakReason(u, PROJECT_ROOT, checkout, climbs);
          return why && `${u.name}: ${why}`;
        })
        .filter((r): r is string => r !== null);
      if (reasons.length > 0) flagged.push({ task_id: run.task_id, tool: run.tool, run: run.run, session_id: run.session_id, reasons });
    }
    results.meta.audit = { at: new Date().toISOString(), checkout, sessions_scanned: scanned, flagged };
    writeFileSync(file, JSON.stringify(results, null, 2) + "\n");

    console.log(`${file}: ${scanned} sessions scanned, ${flagged.length} flagged (allowed: ${checkout})`);
    for (const f of flagged) {
      console.log(`  ${f.task_id} / ${f.tool} / run ${f.run + 1}:`);
      for (const r of f.reasons.slice(0, 5)) console.log(`    ${r}`);
    }
  }
}
