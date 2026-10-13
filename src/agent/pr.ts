import type { CycleCheckResult, CycleEvent, CycleGraph, Snapshot } from "../check/index.js";
import { factsFromEvent } from "./finding.js";
import { explain, type Explanation, type InvestigationInput } from "./runtime.js";

/**
 * The agent on a PR (plan, week 4): rie check runs first and alone decides the
 * outcome; the agent only runs on its fail and warn events, one session each, and
 * never changes the outcome. Whatever happens to the agent - no credentials, a
 * crash, a rejected draft - the event still gets rie check's own facts.
 */

export interface PrExplanation {
  /** Index of the event in result.events. */
  event_index: number;
  explanation: Explanation;
}

export interface ExplainEventsInput {
  result: CycleCheckResult;
  pr: Snapshot;
  base: CycleGraph;
  renames?: Record<string, string>;
  tsconfig: string;
  diff: string;
  gitRoot?: string;
  /** Events explained, strictest first; the rest get rie check's facts only. */
  maxEvents?: number;
  model?: InvestigationInput["model"];
  limits?: InvestigationInput["limits"];
  run?: InvestigationInput["run"];
  log?: (line: string) => void;
}

const RANK = { fail: 0, warn: 1, pass: 2 } as const;

/** Explain each fail and warn event that has evidence, strictest first, up to maxEvents. */
export async function explainEvents(input: ExplainEventsInput): Promise<PrExplanation[]> {
  const log = input.log ?? (() => {});
  const flagged = input.result.events
    .map((event, event_index) => ({ event, event_index }))
    .filter(({ event }) => event.outcome !== "pass" && (event.evidence?.length ?? 0) > 0)
    .sort((a, b) => RANK[a.event.outcome] - RANK[b.event.outcome] || a.event_index - b.event_index);
  const max = input.maxEvents ?? 3;
  const out: PrExplanation[] = [];
  for (const [i, { event, event_index }] of flagged.entries()) {
    if (i >= max) {
      out.push({ event_index, explanation: skipped(event, `only the first ${max} finding(s) are explained`) });
      continue;
    }
    let explanation: Explanation;
    try {
      explanation = await explain({
        event,
        pr: input.pr,
        base: input.base,
        renames: input.renames,
        tsconfig: input.tsconfig,
        diff: input.diff,
        gitRoot: input.gitRoot,
        model: input.model,
        limits: input.limits,
        run: input.run,
      });
    } catch (e) {
      explanation = skipped(event, `the agent failed: ${(e as Error).message}`);
    }
    const a = explanation.attempts;
    log(
      `explain ${event.type}: ${explanation.source === "agent" ? "verified" : `rie check's facts only (${explanation.reason})`}` +
        `; ${a.length} attempt(s), ${a.reduce((n, x) => n + x.tool_calls, 0)} tool call(s), $${(explanation.cost_usd ?? 0).toFixed(3)}`
    );
    out.push({ event_index, explanation });
  }
  return out;
}

function skipped(event: CycleEvent, reason: string): Explanation {
  return { source: "deterministic", facts: factsFromEvent(event), reason, attempts: [], cost_usd: null };
}
