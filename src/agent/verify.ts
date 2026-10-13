import type { CycleEvent, CycleGraph, Snapshot } from "../check/index.js";
import { parseFinding, type Finding } from "./finding.js";

/**
 * The verifier for the investigation agent (plan, week 3): checks a finding's
 * facts against the PR's graph, with no model. It runs before anything the agent
 * wrote reaches a pull request; a finding with any error is sent back once with
 * the errors, and a second failure falls back to the deterministic comment.
 *
 * Each hop is checked against the PR's index: both files are in the snapshot, an
 * import from -> to sits at the claimed line, its statement is the one quoted,
 * its runtime flag is right, and added_in_pr agrees with the base graph (by the
 * same rule rie check uses: the file pair has no runtime import on base, after
 * renames). Every hop must also be a runtime import, since a loop through an
 * erased import is not a runtime cycle, however honestly it is labelled.
 *
 * The finding is also checked against the event it explains: the same event
 * type, loops inside the event's PR groups, and each loop through at least one
 * import the PR added - a true loop the PR didn't touch explains nothing.
 *
 * why_it_matters and suggestions are not checked; the format keeps them apart
 * from the facts so they can't pass as verified.
 */

export interface VerifyContext {
  /** The rie check event the finding explains. */
  event: CycleEvent;
  /** The PR snapshot, with its index still open. */
  pr: Snapshot;
  /** The base graph. */
  base: CycleGraph;
  /** Renamed files, base path -> PR path, as given to rie check. */
  renames?: Record<string, string>;
}

export type VerifyResult = { ok: true; finding: Finding } | { ok: false; errors: string[] };

const key = (from: string, to: string) => `${from}\u0000${to}`;
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Check a parsed finding's facts against the PR's graph. */
export function verifyFinding(finding: Finding, ctx: VerifyContext): VerifyResult {
  const { event, pr, base } = ctx;
  const renames = ctx.renames ?? {};
  const toPr = (f: string) => renames[f] ?? f;
  const baseEdges = new Set(base.edges.map((e) => key(toPr(e.from), toPr(e.to))));
  const inEvent = new Set((event.pr_groups ?? []).flat());
  const rowsOf = pr.db.prepare(
    `SELECT line, statement, is_type_only FROM edges WHERE from_file = ? AND to_file = ? ORDER BY line`
  );

  const errors: string[] = [];
  if (finding.event !== event.type) errors.push(`event: the finding explains ${finding.event}, but the event is ${event.type}`);

  finding.facts.loops.forEach((loop, i) => {
    const at = `facts.loops.${i}`;
    loop.hops.forEach((hop, j) => {
      const fail = (message: string) => errors.push(`${at}.hops.${j}: ${message}`);
      const from = pr.stored.get(hop.from);
      const to = pr.stored.get(hop.to);
      if (!from) return fail(`${hop.from} is not a file in the PR`);
      if (!to) return fail(`${hop.to} is not a file in the PR`);
      if (!inEvent.has(hop.from)) fail(`${hop.from} is not in the ${event.type} event's cycle group`);

      const rows = rowsOf.all(from, to) as { line: number | null; statement: string | null; is_type_only: number }[];
      if (rows.length === 0) return fail(`${hop.from} does not import ${hop.to}`);
      const atLine = rows.filter((r) => r.line === hop.line);
      if (atLine.length === 0) {
        const lines = [...new Set(rows.map((r) => r.line).filter((l) => l !== null))];
        return fail(`${hop.from} has no import of ${hop.to} at line ${hop.line}${lines.length > 0 ? ` (it imports it at line ${lines.join(", ")})` : ""}`);
      }

      const statement = atLine[0].statement;
      if ((hop.statement === null) !== (statement === null) || (hop.statement !== null && collapse(hop.statement) !== collapse(statement!))) {
        fail(`the statement at ${hop.from}:${hop.line} is ${statement === null ? "not recorded" : JSON.stringify(collapse(statement))}, not ${JSON.stringify(hop.statement)}`);
      }
      const runtime = atLine.some((r) => r.is_type_only === 0);
      if (hop.runtime !== runtime) {
        fail(`the import at ${hop.from}:${hop.line} is ${runtime ? "a runtime import" : "type-only (erased at compile time)"}, but the finding says the opposite`);
      }
      if (!runtime) fail(`the import at ${hop.from}:${hop.line} is erased at compile time, so this loop is not a runtime cycle`);
      const added = !baseEdges.has(key(hop.from, hop.to));
      if (hop.added_in_pr !== added) {
        fail(`${hop.from} -> ${hop.to} ${added ? "was added by the PR" : "is already a runtime import on the base branch"}, but the finding says the opposite`);
      }
    });
    if (!loop.hops.some((h) => h.added_in_pr)) errors.push(`${at}: no hop of this loop is an import the PR added, so it doesn't show what the PR changed`);
  });

  return errors.length === 0 ? { ok: true, finding } : { ok: false, errors };
}

/** Shape check, then fact check: every reason a draft is refused, for the revise loop. */
export function checkFinding(input: unknown, ctx: VerifyContext): VerifyResult {
  const parsed = parseFinding(input);
  return parsed.ok ? verifyFinding(parsed.finding, ctx) : parsed;
}
