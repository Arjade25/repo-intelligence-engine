import type Database from "better-sqlite3";
/**
 * rie check: does a PR make the runtime import-cycle structure worse than its base?
 *
 * Both snapshots are indexed in full (symbols and edges; references aren't
 * needed), and their runtime cycle groups - strongly connected components over
 * imports that survive compilation - are compared. Groups are matched by shared
 * files after mapping renamed files through git's rename detection. Each PR group
 * and each base group then gives at most one event (see CycleEventType). Old
 * cycles never fail a PR: only a change between base and PR does.
 *
 * Findings carry evidence: for each runtime import the PR added inside a cycle
 * group, the shortest loop that takes it, with the statement behind each hop.
 * The rules are pinned down as test cases in cycle-events.cases.ts.
 */
export type Outcome = "fail" | "warn" | "pass";
export type CycleEventType = 
/** A group appears whose files were in no cycle on base. */
"new_cycle"
/** An existing group gains files. */
 | "cycle_grown"
/** Two or more base groups become one. */
 | "cycles_merged"
/** No file joins or leaves a group, but a new import makes a shorter loop through some file. */
 | "loop_shortened"
/** One base group becomes two or more smaller groups, and no file joins. */
 | "cycle_split"
/** Files leave a group that still exists. */
 | "cycle_shrunk"
/** A base group no longer exists. */
 | "cycle_resolved"
/** No other event fired. */
 | "no_regression";
export declare const DEFAULT_OUTCOMES: Record<CycleEventType, Outcome>;
export interface EvidenceHop {
    /** "file:line" of the import or re-export behind this hop. */
    at: string;
    /** That statement's text, whitespace-collapsed. */
    statement: string | null;
    /** The imported names that survive compilation, when the statement names any. */
    runtime_names?: string[];
    /** On a PR finding: whether the PR added this file pair's import (it isn't in the base graph). */
    added?: boolean;
}
export interface Evidence {
    /** Starts and ends with the same file. */
    loop: string[];
    /** hops[i] is loop[i] -> loop[i + 1]. */
    hops: EvidenceHop[];
}
export interface CycleEvent {
    type: CycleEventType;
    outcome: Outcome;
    /** The base groups this event is about, in base paths. */
    base_groups?: string[][];
    /** The PR groups this event is about. */
    pr_groups?: string[][];
    /** Files in a PR group that were in no base group. */
    joined?: string[];
    /** Files of a base group that are in no PR group, in base paths. */
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
export interface CycleCheckInput {
    /** tsconfig of the base snapshot. */
    base: string;
    /** tsconfig of the PR snapshot. */
    pr: string;
    /** Renamed files, base path -> PR path, relative to each snapshot's tsconfig directory. */
    renames?: Record<string, string>;
    /** Per-repo outcome overrides, e.g. { cycle_grown: "warn" }. */
    outcomes?: Partial<Record<CycleEventType, Outcome>>;
}
export interface CycleCheckResult {
    /** The strictest event's outcome: fail > warn > pass. */
    outcome: Outcome;
    events: CycleEvent[];
    /** Runtime cycle groups of each snapshot, largest first. */
    groups: {
        base: string[][];
        pr: string[][];
    };
    /** Problems that make the result less trustworthy, such as imports that don't resolve. */
    warnings: string[];
}
export interface RuntimeEdge {
    from: string;
    to: string;
    /** The pair's first import line; 0 when the graph's source has no lines (the emit oracle, madge). */
    line: number;
}
/**
 * A runtime import graph, every path relative to the tsconfig directory. Events
 * can be computed from any source of one: RIE's index here, or the emit oracle and
 * madge in the history replay (benchmarks/replay).
 */
export interface CycleGraph {
    /** Runtime cycle groups, each sorted, largest first. */
    groups: string[][];
    /** Runtime imports, one per file pair, at the pair's first line. */
    edges: RuntimeEdge[];
    /** Runtime successors of each file, sorted, so loops are deterministic. */
    next: Map<string, string[]>;
}
/** Successor lists for a graph's edges, sorted. */
export declare function successors(edges: RuntimeEdge[]): Map<string, string[]>;
/** One snapshot indexed by RIE: a CycleGraph plus the index, which the evidence's import lines come from. */
export interface Snapshot extends CycleGraph {
    db: Database.Database;
    /** The snapshot's paths as the index stores them, by relative path. */
    stored: Map<string, string>;
    unresolved: number;
    unresolvedSummary: string;
    /** The tsconfig's own errors (say, an `extends` that isn't installed): its options may be incomplete. */
    configErrors: string[];
}
export declare function indexSnapshot(tsconfigPath: string): Snapshot;
/** Files on the shortest loop through `file`; 0 when it is in none. */
export declare function shortestLoopLength(snapshot: Pick<CycleGraph, "next">, file: string): number;
/** The loop through `from -> to` and the import behind each hop. */
export declare function loopEvidence(snapshot: Snapshot, from: string, to: string): Evidence | null;
/**
 * Compare two snapshots' runtime graphs. Evidence (the loop and the import line
 * behind each hop) needs the PR side's RIE index; for any other graph, such as the
 * emit oracle's, events come without it.
 */
export declare function compareSnapshots(base: CycleGraph, pr: CycleGraph | Snapshot, options?: Pick<CycleCheckInput, "renames" | "outcomes">): Omit<CycleCheckResult, "warnings">;
/** A check whose indexes are still open, for a caller that keeps querying them (the investigation agent). Close both when done. */
export interface OpenCheck {
    result: CycleCheckResult;
    base: Snapshot;
    pr: Snapshot;
}
/** One warning for a tsconfig's own errors; the first line is what the PR comment shows. */
export declare function configWarning(which: string, errors: string[]): string;
/** Index both snapshots and compare them, leaving both indexes open. */
export declare function checkCyclesOpen(input: CycleCheckInput): OpenCheck;
/** Index both snapshots and compare them. */
export declare function checkCycles(input: CycleCheckInput): CycleCheckResult;
