import type { Outcome } from "../../src/check/index.js";
import type { ReplayRecord, Tool } from "./replay.js";

/**
 * Scores RIE and madge against the emit oracle's labels over replayed commits
 * (the plan's evaluation table): detection, false alarms, exact event agreement,
 * run time, and what was skipped. Unchanged commits are counted, never scored:
 * they can't change the graph, so they would only inflate agreement.
 */

export interface ToolScore {
  tool: Tool;
  /** label outcome -> tool outcome -> commits */
  outcomes: Record<Outcome, Record<Outcome, number>>;
  /** Label fail or warn commits the tool also failed or warned on. */
  detected: number;
  /** The tool failed a commit whose label isn't fail. */
  false_alarms: number;
  /** Same event types and groups as the label. */
  exact_events: number;
  compared: number;
  median_ms: number | null;
}

export interface ReplaySummary {
  commits: number;
  unchanged: number;
  skipped: { sha: string; reason: string }[];
  compared: number;
  /** Compared commits whose label has any event other than no_regression. */
  label_changes: number;
  /** Compared commits labelled fail or warn. */
  label_regressions: number;
  tools: ToolScore[];
  disagreements: { sha: string; subject: string; label: string[]; tool: Tool; got: string[] }[];
  /** At the commits compared: total runtime edges only RIE has, and only the oracle has. */
  edges: { rie_only: number; oracle_only: number };
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function summarizeReplay(records: ReplayRecord[]): ReplaySummary {
  const compared = records.filter((r) => r.status === "compared" && r.tools.oracle);
  const tools = (["rie", "madge"] as Tool[]).filter((t) => compared.some((r) => r.tools[t]));
  const isRegression = (o: Outcome) => o !== "pass";
  const changes = (r: ReplayRecord) => r.tools.oracle!.events.some((e) => !e.startsWith("no_regression"));

  const disagreements: ReplaySummary["disagreements"] = [];
  const scores = tools.map((tool): ToolScore => {
    const outcomes = { fail: { fail: 0, warn: 0, pass: 0 }, warn: { fail: 0, warn: 0, pass: 0 }, pass: { fail: 0, warn: 0, pass: 0 } };
    let detected = 0;
    let falseAlarms = 0;
    let exact = 0;
    const scored = compared.filter((r) => r.tools[tool]);
    for (const r of scored) {
      const label = r.tools.oracle!;
      const got = r.tools[tool]!;
      outcomes[label.outcome][got.outcome]++;
      if (isRegression(label.outcome) && isRegression(got.outcome)) detected++;
      if (got.outcome === "fail" && label.outcome !== "fail") falseAlarms++;
      if (JSON.stringify(label.events) === JSON.stringify(got.events)) exact++;
      else disagreements.push({ sha: r.sha, subject: r.subject, label: label.events, tool, got: got.events });
    }
    return {
      tool,
      outcomes,
      detected,
      false_alarms: falseAlarms,
      exact_events: exact,
      compared: scored.length,
      median_ms: median(scored.map((r) => r.tools[tool]!.ms)),
    };
  });

  return {
    commits: records.length,
    unchanged: records.filter((r) => r.status === "unchanged").length,
    skipped: records.filter((r) => r.status === "skipped").map((r) => ({ sha: r.sha, reason: r.reason ?? "" })),
    compared: compared.length,
    label_changes: compared.filter(changes).length,
    label_regressions: compared.filter((r) => isRegression(r.tools.oracle!.outcome)).length,
    tools: scores,
    disagreements,
    edges: {
      rie_only: compared.reduce((n, r) => n + (r.edges?.rie_only ?? 0), 0),
      oracle_only: compared.reduce((n, r) => n + (r.edges?.oracle_only ?? 0), 0),
    },
  };
}

export function formatSummary(s: ReplaySummary): string {
  const lines = [
    `Commits: ${s.commits} (${s.compared} compared, ${s.unchanged} unchanged, ${s.skipped.length} skipped)`,
    `Oracle labels: ${s.label_regressions} fail/warn, ${s.label_changes} with any cycle change`,
    `Runtime edges vs the oracle, summed over compared commits: ${s.edges.rie_only} only in RIE, ${s.edges.oracle_only} only in the oracle`,
    "",
    "| Tool | Compared | Detected (of label fail/warn) | False alarms | Exact events | Median ms per commit |",
    "|---|---|---|---|---|---|",
  ];
  for (const t of s.tools) {
    lines.push(`| ${t.tool} | ${t.compared} | ${t.detected} of ${s.label_regressions} | ${t.false_alarms} | ${t.exact_events} of ${t.compared} | ${t.median_ms ?? "-"} |`);
  }
  for (const t of s.tools) {
    lines.push("", `${t.tool}: label (rows) x ${t.tool} (columns)`, "| | fail | warn | pass |", "|---|---|---|---|");
    for (const label of ["fail", "warn", "pass"] as Outcome[]) {
      const row = t.outcomes[label];
      lines.push(`| ${label} | ${row.fail} | ${row.warn} | ${row.pass} |`);
    }
  }
  if (s.disagreements.length > 0) {
    lines.push("", "Disagreements with the label:");
    for (const d of s.disagreements) {
      lines.push(`- ${d.sha.slice(0, 10)} ${d.tool}: label ${d.label.join("; ")} | got ${d.got.join("; ")}  (${d.subject.slice(0, 50)})`);
    }
  }
  for (const k of s.skipped) lines.push(`skipped ${k.sha.slice(0, 10)}: ${k.reason}`);
  return lines.join("\n");
}
