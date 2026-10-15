import type { CycleCheckResult, CycleGraph, Snapshot } from "../check/index.js";
import { type Explanation, type InvestigationInput } from "./runtime.js";
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
/** Explain each fail and warn event that has evidence, strictest first, up to maxEvents. */
export declare function explainEvents(input: ExplainEventsInput): Promise<PrExplanation[]>;
