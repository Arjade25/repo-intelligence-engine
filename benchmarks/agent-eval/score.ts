import { posix } from "node:path";
import type { CycleEvent, CycleGraph } from "../../src/check/index.js";
import type { Finding } from "../../src/agent/finding.js";
import type { Explanation, InvestigationResult } from "../../src/agent/runtime.js";

/**
 * Scoring for the agent evaluation (plan, week 4). Everything here is computed
 * without a model:
 * - unsupported claims: every hop of a posted finding re-checked against the emit
 *   oracle (what tsc actually compiles), not the RIE index the verifier used, so a
 *   shared blind spot of RIE and its verifier would still show;
 * - usefulness: does the explanation name the import the PR added, and a file it
 *   pulls into the cycle (by file stem, case-insensitive);
 * - traps: did a draft cite the seeded type-only import as a hop.
 */

const key = (from: string, to: string) => `${from}\u0000${to}`;

/** Hops of a posted finding that the emit oracle doesn't back: not a runtime import in the compiled output, or added_in_pr wrong. */
export function unsupportedHops(finding: Finding, oracle: { base: CycleGraph; pr: CycleGraph }, renames: Record<string, string> = {}): string[] {
  const prEdges = new Set(oracle.pr.edges.map((e) => key(e.from, e.to)));
  const baseEdges = new Set(oracle.base.edges.map((e) => key(renames[e.from] ?? e.from, renames[e.to] ?? e.to)));
  const out: string[] = [];
  finding.facts.loops.forEach((loop, i) =>
    loop.hops.forEach((h, j) => {
      const at = `loop ${i} hop ${j} (${h.from} -> ${h.to})`;
      if (!prEdges.has(key(h.from, h.to))) out.push(`${at}: not a runtime import in the compiled PR`);
      else if (h.added_in_pr !== !baseEdges.has(key(h.from, h.to))) out.push(`${at}: added_in_pr is ${h.added_in_pr}, the compiled base says otherwise`);
    })
  );
  return out;
}

/** "src/stores/RoomListStore.ts" -> "roomliststore" */
export const stem = (path: string) => posix.basename(path.replace(/\\/g, "/")).replace(/\.[cm]?[jt]sx?$/, "").toLowerCase();

export interface Usefulness {
  /** The explanation names both files of an import the PR added. */
  names_added_import: boolean;
  /** The explanation names a file that joined the cycle; null when none joined (merges, shorter loops). */
  names_joined_file: boolean | null;
}

export function usefulness(finding: Finding, event: CycleEvent): Usefulness {
  const prose = finding.why_it_matters.toLowerCase();
  const added = finding.facts.loops.flatMap((l) => l.hops).filter((h) => h.added_in_pr);
  return {
    names_added_import: added.some((h) => prose.includes(stem(h.from)) && prose.includes(stem(h.to))),
    names_joined_file: event.joined?.length ? event.joined.some((f) => prose.includes(stem(f))) : null,
  };
}

export interface Trap {
  /** The file that got the seeded `import type`. */
  file: string;
  /** What it imports. */
  target: string;
  /** 1-based line of the seeded import. */
  line: number;
}

/** Whether a draft (parsed or not) cites the trap's import as a hop. */
export function citesTrap(draft: unknown, trap: Trap): boolean {
  const loops = (draft as { facts?: { loops?: { hops?: { from?: unknown; to?: unknown }[] }[] } } | undefined)?.facts?.loops ?? [];
  return loops.some((l) => (l.hops ?? []).some((h) => h.from === trap.file && h.to === trap.target));
}

/** One session's record, as the evaluation writes it. */
export interface SessionRecord {
  task_id: string;
  repo: string;
  sha: string;
  kind: "real" | "trap";
  run: number;
  event_index: number;
  event_type: string;
  loops_in_event: number;
  trap?: Trap;
  source: Explanation["source"];
  reason?: string;
  attempts: Omit<InvestigationResult, "finding" | "draft">[];
  /** The draft of each attempt cited the trap. */
  trap_cited?: boolean[];
  posted?: Finding;
  unsupported: string[];
  usefulness?: Usefulness;
  cost_usd: number | null;
  wall_ms: number;
}

const pct = (n: number, d: number) => (d === 0 ? "–" : `${n}/${d} (${Math.round((100 * n) / d)}%)`);
const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export interface Summary {
  label: string;
  sessions: number;
  posted: number;
  fallback: number;
  first_draft_rejected: number;
  rescued_by_retry: number;
  no_draft: number;
  unsupported_posted: number;
  names_added_import: number;
  names_joined_file: [number, number];
  trap_cited_first_draft: number;
  trap_posted: number;
  cost_total: number;
  cost_median: number;
  wall_median_s: number;
  tool_calls_median: number;
}

export function summarize(label: string, records: SessionRecord[]): Summary {
  const posted = records.filter((r) => r.source === "agent");
  const joinedScored = posted.filter((r) => r.usefulness?.names_joined_file !== null && r.usefulness?.names_joined_file !== undefined);
  return {
    label,
    sessions: records.length,
    posted: posted.length,
    fallback: records.length - posted.length,
    first_draft_rejected: records.filter((r) => r.attempts[0]?.status === "rejected").length,
    rescued_by_retry: records.filter((r) => r.attempts.length === 2 && r.source === "agent").length,
    no_draft: records.filter((r) => r.attempts.at(-1)?.status === "no_draft").length,
    unsupported_posted: posted.filter((r) => r.unsupported.length > 0).length,
    names_added_import: posted.filter((r) => r.usefulness?.names_added_import).length,
    names_joined_file: [joinedScored.filter((r) => r.usefulness!.names_joined_file).length, joinedScored.length],
    trap_cited_first_draft: records.filter((r) => r.trap_cited?.[0]).length,
    trap_posted: posted.filter((r) => r.trap && citesTrap(r.posted, r.trap)).length,
    cost_total: records.reduce((n, r) => n + (r.cost_usd ?? 0), 0),
    cost_median: median(records.map((r) => r.cost_usd ?? 0)),
    wall_median_s: median(records.map((r) => r.wall_ms / 1000)),
    tool_calls_median: median(records.map((r) => r.attempts.reduce((n, a) => n + a.tool_calls, 0))),
  };
}

export function formatSummaries(rows: Summary[]): string {
  const lines = [
    "| Set | Sessions | Posted (verified) | Fell back | First draft rejected | Rescued by retry | Unsupported posted | Names added import | Names joined file | Trap cited (1st draft) | Trap posted | Cost total | Median cost | Median time | Median tool calls |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const s of rows) {
    const trap = s.label.includes("trap");
    lines.push(
      `| ${s.label} | ${s.sessions} | ${pct(s.posted, s.sessions)} | ${pct(s.fallback, s.sessions)} | ${pct(s.first_draft_rejected, s.sessions)} | ${s.rescued_by_retry} | **${s.unsupported_posted}** | ${pct(s.names_added_import, s.posted)} | ${pct(...s.names_joined_file)} | ${trap ? pct(s.trap_cited_first_draft, s.sessions) : "–"} | ${trap ? `**${s.trap_posted}**` : "–"} | $${s.cost_total.toFixed(2)} | $${s.cost_median.toFixed(3)} | ${s.wall_median_s.toFixed(0)} s | ${s.tool_calls_median} |`
    );
  }
  return lines.join("\n");
}
