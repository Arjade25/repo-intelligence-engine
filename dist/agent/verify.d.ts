import type { CycleEvent, CycleGraph, Snapshot } from "../check/index.js";
import { type Finding } from "./finding.js";
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
export type VerifyResult = {
    ok: true;
    finding: Finding;
} | {
    ok: false;
    errors: string[];
};
/** Check a parsed finding's facts against the PR's graph. */
export declare function verifyFinding(finding: Finding, ctx: VerifyContext): VerifyResult;
/** Shape check, then fact check: every reason a draft is refused, for the revise loop. */
export declare function checkFinding(input: unknown, ctx: VerifyContext): VerifyResult;
