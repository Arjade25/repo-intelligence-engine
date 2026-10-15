import type { CycleEventType, Outcome } from "./index.js";
/**
 * The cycle event rules for `rie check`, written as test cases before the check
 * exists (plan, week 1). Each case is a base snapshot, a PR snapshot, the runtime
 * cycle groups each one has, and what the check must report.
 *
 * Two test suites read these:
 * - benchmarks/oracle/cycle-events.test.ts checks the groups and the evidence
 *   against a real tsc emit, so a case can't encode a premise that isn't true;
 * - src/check/cycle-events.test.ts asserts the check's output.
 *
 * Conventions:
 * - Paths are relative to the snapshot root ("src/a.ts"); groups and file lists
 *   are sorted.
 * - `modules({ a: ["b", "c"] })` writes src/a.ts with one import per line, in
 *   order (`import { b } from "./b.js";` on line 1, c on line 2), and uses every
 *   import as a value, so none is erased.
 * - Evidence: for each runtime edge the PR added that lies inside a PR cycle
 *   group, the shortest loop that takes that edge, with the import statement
 *   behind each hop. Edges are taken in (file, line) order, and an edge already on
 *   a reported loop is skipped. This is the plan's "shortest loop through each
 *   affected file", made precise: a loop through the new edge is what shows a
 *   merge, where the bridging file's own shortest loop can stay inside its old group.
 * - Outcomes use the defaults: cycle_grown fails, loop_shortened warns. A PR's
 *   outcome is its strictest event's: fail > warn > pass.
 */
export type { CycleEventType, Outcome };
export interface EvidenceHop {
    /** "file:line" of the import or re-export behind this hop. */
    at: string;
    /** That statement's text, whitespace-collapsed. */
    statement: string;
}
export interface Evidence {
    /** Starts and ends with the same file. */
    loop: string[];
    /** hops[i] is loop[i] -> loop[i + 1]. */
    hops: EvidenceHop[];
}
export interface ExpectedEvent {
    type: CycleEventType;
    outcome: Outcome;
    /** The base groups this event is about (matched by shared files, after renames). */
    base_groups?: string[][];
    /** The PR groups this event is about. */
    pr_groups?: string[][];
    /** Files in a PR group that were in no base group (new_cycle: all of them). */
    joined?: string[];
    /** Files of a base group that are in no PR group. */
    left?: string[];
    /** loop_shortened: every file whose shortest loop got shorter. */
    shortened?: {
        file: string;
        base_length: number;
        pr_length: number;
    }[];
    /** Fail and warn events only. */
    evidence?: Evidence[];
}
/** Path under src/ (no "src/" prefix) -> file content. */
export type Snapshot = Record<string, string>;
export interface CycleEventCase {
    name: string;
    /** What this case pins down, in the plan's words. */
    rule: string;
    base: Snapshot;
    pr: Snapshot;
    /** Git's rename detection, as the check will get it: base path -> PR path. */
    renames?: Record<string, string>;
    /** Every runtime cycle group in each whole snapshot. Checked against tsc emit. */
    groups: {
        base: string[][];
        pr: string[][];
    };
    /**
     * An import in the PR that would close a loop if counted, and must not be:
     * erased at emit ("type") or loaded lazily ("dynamic").
     */
    trap?: {
        from: string;
        to: string;
        kind: "type" | "dynamic";
    };
    expected: {
        outcome: Outcome;
        events: ExpectedEvent[];
    };
    /** What the same PR must give if the rename map were ignored - proof the map matters. */
    expected_without_renames?: {
        outcome: Outcome;
    };
}
export declare function modules(graph: Record<string, string[]>): Snapshot;
export declare const CYCLE_EVENT_CASES: CycleEventCase[];
/** Writes a snapshot as a small CommonJS repo; returns its tsconfig path. */
export declare function materialize(snapshot: Snapshot, label: string): string;
