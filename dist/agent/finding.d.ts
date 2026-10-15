import { z } from "zod";
import type { CycleEvent, Evidence } from "../check/index.js";
/**
 * The finding format for the investigation agent (plan, week 3): what the agent
 * hands back for one `rie check` event, in three parts that are never mixed.
 *
 * - facts: the loops the agent cites, hop by hop. Each hop is a claim the verifier
 *   checks against the PR's graph without a model: the import exists, at that line,
 *   with that statement, is (or isn't) a runtime import, and was (or wasn't) added
 *   by the PR. Only facts are verified.
 * - why_it_matters: the explanation, in prose. Not verified; it may only lean on
 *   the facts.
 * - suggestions: possible fixes, always marked unverified. The schema refuses a
 *   suggestion that claims otherwise.
 *
 * parseFinding checks shape only (fields, types, each loop closed and chained);
 * whether the facts are true is the verifier's job. factsFromEvent turns an
 * event's own evidence into facts, which is both the agent's starting point and
 * the deterministic fallback when a draft fails verification.
 */
export declare const FINDING_VERSION = 1;
declare const FactHop: z.ZodObject<{
    from: z.ZodString;
    to: z.ZodString;
    line: z.ZodNumber;
    statement: z.ZodNullable<z.ZodString>;
    runtime: z.ZodBoolean;
    added_in_pr: z.ZodBoolean;
}, z.core.$strict>;
declare const FactLoop: z.ZodObject<{
    hops: z.ZodArray<z.ZodObject<{
        from: z.ZodString;
        to: z.ZodString;
        line: z.ZodNumber;
        statement: z.ZodNullable<z.ZodString>;
        runtime: z.ZodBoolean;
        added_in_pr: z.ZodBoolean;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const FindingSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    event: z.ZodEnum<{
        new_cycle: "new_cycle";
        cycle_grown: "cycle_grown";
        cycles_merged: "cycles_merged";
        loop_shortened: "loop_shortened";
        cycle_split: "cycle_split";
        cycle_shrunk: "cycle_shrunk";
        cycle_resolved: "cycle_resolved";
        no_regression: "no_regression";
    }>;
    facts: z.ZodObject<{
        loops: z.ZodArray<z.ZodObject<{
            hops: z.ZodArray<z.ZodObject<{
                from: z.ZodString;
                to: z.ZodString;
                line: z.ZodNumber;
                statement: z.ZodNullable<z.ZodString>;
                runtime: z.ZodBoolean;
                added_in_pr: z.ZodBoolean;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    why_it_matters: z.ZodString;
    suggestions: z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        verified: z.ZodLiteral<false>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type FactHop = z.infer<typeof FactHop>;
export type FactLoop = z.infer<typeof FactLoop>;
export type Finding = z.infer<typeof FindingSchema>;
export type ParseResult = {
    ok: true;
    finding: Finding;
} | {
    ok: false;
    errors: string[];
};
/** Shape check of a finding, from parsed JSON or JSON text. */
export declare function parseFinding(input: unknown): ParseResult;
/** One evidence loop as facts. Every hop of rie check evidence is a runtime import. */
export declare function factsFromEvidence(ev: Evidence): FactLoop;
/** The facts behind a fail or warn event: one loop per piece of its evidence. */
export declare function factsFromEvent(event: CycleEvent): Finding["facts"];
export {};
