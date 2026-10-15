import { z } from "zod";
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
export const FINDING_VERSION = 1;
const EVENT_TYPES = [
    "new_cycle",
    "cycle_grown",
    "cycles_merged",
    "loop_shortened",
    "cycle_split",
    "cycle_shrunk",
    "cycle_resolved",
    "no_regression",
];
const FactHop = z
    .object({
    /** Importing file, relative to the tsconfig directory. */
    from: z.string().min(1),
    /** Imported file. */
    to: z.string().min(1),
    /** 1-based line of the import or re-export in `from`. */
    line: z.number().int().positive(),
    /** The statement at that line, whitespace-collapsed; null when it has none to quote. */
    statement: z.string().min(1).nullable(),
    /** Survives compilation to JavaScript. */
    runtime: z.boolean(),
    /** Not in the base branch's graph. */
    added_in_pr: z.boolean(),
})
    .strict();
const FactLoop = z
    .object({ hops: z.array(FactHop).min(1) })
    .strict()
    .superRefine(({ hops }, ctx) => {
    hops.forEach((hop, i) => {
        const next = hops.at((i + 1) % hops.length);
        if (hop.to !== next.from) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["hops", i, "to"],
                message: i === hops.length - 1 ? `loop doesn't close: ends at ${hop.to}, starts at ${hops[0].from}` : `hop ${i} ends at ${hop.to} but hop ${i + 1} starts at ${next.from}`,
            });
        }
    });
});
const Suggestion = z
    .object({
    text: z.string().min(1),
    /** Always false: a suggested fix is never checked. */
    verified: z.literal(false),
})
    .strict();
export const FindingSchema = z
    .object({
    version: z.literal(FINDING_VERSION),
    /** The rie check event this finding explains. */
    event: z.enum(EVENT_TYPES),
    facts: z.object({ loops: z.array(FactLoop).min(1) }).strict(),
    why_it_matters: z.string().min(1),
    suggestions: z.array(Suggestion),
})
    .strict();
/** Shape check of a finding, from parsed JSON or JSON text. */
export function parseFinding(input) {
    let value = input;
    if (typeof input === "string") {
        try {
            value = JSON.parse(input);
        }
        catch (e) {
            return { ok: false, errors: [`not JSON: ${e.message}`] };
        }
    }
    const r = FindingSchema.safeParse(value);
    if (r.success)
        return { ok: true, finding: r.data };
    return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}
/** "src/a.ts:12" -> ["src/a.ts", 12]; the path may itself contain colons (a Windows drive). */
function splitAt(at) {
    const i = at.lastIndexOf(":");
    return [at.slice(0, i), Number(at.slice(i + 1))];
}
/** One evidence loop as facts. Every hop of rie check evidence is a runtime import. */
export function factsFromEvidence(ev) {
    return {
        hops: ev.hops.map((hop, i) => {
            const [file, line] = splitAt(hop.at);
            if (file !== ev.loop[i])
                throw new Error(`evidence hop ${i} is at ${hop.at}, not in ${ev.loop[i]}`);
            return { from: ev.loop[i], to: ev.loop[i + 1], line, statement: hop.statement, runtime: true, added_in_pr: hop.added ?? false };
        }),
    };
}
/** The facts behind a fail or warn event: one loop per piece of its evidence. */
export function factsFromEvent(event) {
    if (!event.evidence?.length)
        throw new Error(`${event.type} (${event.outcome}) has no evidence to state as facts`);
    return { loops: event.evidence.map(factsFromEvidence) };
}
//# sourceMappingURL=finding.js.map