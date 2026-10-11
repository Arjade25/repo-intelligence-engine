import type { CycleCheckResult, CycleEvent, Evidence } from "./index.js";

/** Plain-text report of a check: one block per event, strictest first, with each finding's loops. */

const SUMMARY: Record<CycleEvent["type"], (e: CycleEvent) => string> = {
  new_cycle: (e) => `new runtime cycle of ${e.pr_groups![0].length} files`,
  cycle_grown: (e) => `cycle of ${e.base_groups![0].length} files grew to ${e.pr_groups![0].length}`,
  cycles_merged: (e) => `${e.base_groups!.length} cycles merged into one of ${e.pr_groups![0].length} files`,
  loop_shortened: (e) => `shorter loops inside a cycle of ${e.pr_groups![0].length} files`,
  cycle_split: (e) => `cycle of ${e.base_groups![0].length} files split into ${e.pr_groups!.length}`,
  cycle_shrunk: (e) => `cycle of ${e.base_groups![0].length} files shrank to ${e.pr_groups![0].length}`,
  cycle_resolved: (e) => `cycle of ${e.base_groups![0].length} files resolved`,
  no_regression: () => "no change to runtime import cycles makes them worse",
};

const RANK = { fail: 0, warn: 1, pass: 2 } as const;

export function formatLoop(ev: Evidence, indent = "  "): string[] {
  const lines = [`${indent}loop (${ev.loop.length - 1} files): ${ev.loop.join(" -> ")}`];
  const width = Math.max(...ev.hops.map((h) => h.at.length));
  // runtime_names says which imported names keep the import at runtime, when the statement also imports types.
  for (const h of ev.hops) {
    lines.push(`${indent}  ${h.at.padEnd(width)}  ${h.statement ?? ""}${h.runtime_names ? `  (runtime: ${h.runtime_names.join(", ")})` : ""}`);
  }
  return lines;
}

export function formatReport(result: CycleCheckResult): string {
  const lines = [`rie check: ${result.outcome.toUpperCase()}`];
  const events = [...result.events].sort((a, b) => RANK[a.outcome] - RANK[b.outcome]);
  for (const e of events) {
    lines.push("", `${e.outcome.toUpperCase()}  ${e.type}: ${SUMMARY[e.type](e)}`);
    if (e.joined?.length) lines.push(`  joined: ${e.joined.join(", ")}`);
    if (e.left?.length) lines.push(`  left: ${e.left.join(", ")}`);
    for (const s of e.shortened ?? []) lines.push(`  ${s.file}: shortest loop ${s.base_length} -> ${s.pr_length} files`);
    for (const ev of e.evidence ?? []) lines.push(...formatLoop(ev));
  }
  for (const w of result.warnings) lines.push("", `WARNING: ${w}`);
  return lines.join("\n");
}

/** Marks the PR comment, so the action updates its own comment instead of adding one per push. */
export const COMMENT_MARKER = "<!-- rie-check -->";

/** Files listed per event and loops shown per event before the rest are counted; a PR comment is capped at 65,536 characters. */
const MAX_FILES = 20;
const MAX_LOOPS = 5;

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const fileList = (files: string[]) =>
  files.slice(0, MAX_FILES).map(code).join(", ") + (files.length > MAX_FILES ? ` and ${files.length - MAX_FILES} more` : "");

/**
 * The PR comment and job summary: a table of every event, then the loops behind
 * each fail or warn. Pass events get a row and nothing else.
 */
export function formatMarkdown(result: CycleCheckResult, context: { baseCommit?: string; baseRef?: string } = {}): string {
  const events = [...result.events].sort((a, b) => RANK[a.outcome] - RANK[b.outcome]);
  const lines = [COMMENT_MARKER, `### rie check: ${result.outcome}`, ""];
  const against = context.baseCommit
    ? `Compared with ${code(context.baseCommit.slice(0, 10))}${context.baseRef ? `, the merge base with ${code(context.baseRef)}` : ""}. `
    : "";
  lines.push(`${against}Runtime import cycle groups: ${result.groups.base.length} on base, ${result.groups.pr.length} with this PR.`, "");
  lines.push("| Outcome | Event | Change |", "|---|---|---|");
  for (const e of events) lines.push(`| ${e.outcome} | ${code(e.type)} | ${SUMMARY[e.type](e)} |`);

  for (const e of events.filter((x) => x.outcome !== "pass")) {
    lines.push("", `#### ${e.outcome}: ${code(e.type)}, ${SUMMARY[e.type](e)}`);
    if (e.joined?.length) lines.push("", `Joined: ${fileList(e.joined)}`);
    if (e.shortened?.length) {
      lines.push("", "Shorter loops: " + e.shortened.slice(0, MAX_FILES).map((s) => `${code(s.file)} ${s.base_length} → ${s.pr_length} files`).join(", "));
    }
    const loops = e.evidence ?? [];
    for (const ev of loops.slice(0, MAX_LOOPS)) {
      lines.push("", `Loop of ${ev.loop.length - 1} files through an import this PR adds:`, "", "```", ...formatLoop(ev, "").slice(1).map((l) => l.trimStart()), "```");
    }
    if (loops.length > MAX_LOOPS) lines.push("", `${loops.length - MAX_LOOPS} more loop(s) in the job log.`);
  }
  for (const w of result.warnings) lines.push("", `> **Warning:** ${w.split("\n")[0]}`);
  lines.push(
    "",
    "<sub>Runtime imports only: type-only imports and dynamic <code>import()</code> don't count, and barrel re-exports do. Cycles already on the base branch never fail a PR.</sub>"
  );
  return lines.join("\n");
}
