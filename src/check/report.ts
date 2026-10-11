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
