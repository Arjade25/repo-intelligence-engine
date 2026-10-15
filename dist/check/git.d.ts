import { type CycleCheckInput, type CycleCheckResult, type Snapshot } from "./index.js";
/**
 * `git diff -M --name-status` output -> renames relative to `prefix` (the tsconfig's
 * directory relative to the git root, "" at the root). Renames that cross out of
 * that directory are dropped: on one side the file isn't in the snapshot at all.
 */
export declare function parseRenames(nameStatus: string, prefix: string): Record<string, string>;
export interface GitCheckInput extends Pick<CycleCheckInput, "outcomes"> {
    /** tsconfig of the PR checkout (the working tree). */
    pr: string;
    /** The branch or commit the PR merges into, e.g. origin/main. */
    baseRef: string;
}
export interface GitCheckResult extends CycleCheckResult {
    /** The commit the PR was compared against: the merge base of baseRef and HEAD. */
    base_commit: string;
    renames: Record<string, string>;
}
/** checkAgainstRef with both indexes left open, and where the diff comes from. Close both when done. */
export interface OpenGitCheck {
    result: GitCheckResult;
    base: Snapshot;
    pr: Snapshot;
    gitRoot: string;
}
export declare function checkAgainstRef(input: GitCheckInput): GitCheckResult;
/** The PR's changes against the commit it was compared with, working tree included, as a unified diff. */
export declare function prDiff(gitRoot: string, baseCommit: string): string;
export declare function checkAgainstRefOpen(input: GitCheckInput): OpenGitCheck;
