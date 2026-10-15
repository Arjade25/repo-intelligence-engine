import { factsFromEvent } from "./finding.js";
import { explain } from "./runtime.js";
const RANK = { fail: 0, warn: 1, pass: 2 };
/** Explain each fail and warn event that has evidence, strictest first, up to maxEvents. */
export async function explainEvents(input) {
    const log = input.log ?? (() => { });
    const flagged = input.result.events
        .map((event, event_index) => ({ event, event_index }))
        .filter(({ event }) => event.outcome !== "pass" && (event.evidence?.length ?? 0) > 0)
        .sort((a, b) => RANK[a.event.outcome] - RANK[b.event.outcome] || a.event_index - b.event_index);
    const max = input.maxEvents ?? 3;
    const out = [];
    for (const [i, { event, event_index }] of flagged.entries()) {
        if (i >= max) {
            out.push({ event_index, explanation: skipped(event, `only the first ${max} finding(s) are explained`) });
            continue;
        }
        let explanation;
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
        }
        catch (e) {
            explanation = skipped(event, `the agent failed: ${e.message}`);
        }
        const a = explanation.attempts;
        log(`explain ${event.type}: ${explanation.source === "agent" ? "verified" : `rie check's facts only (${explanation.reason})`}` +
            `; ${a.length} attempt(s), ${a.reduce((n, x) => n + x.tool_calls, 0)} tool call(s), $${(explanation.cost_usd ?? 0).toFixed(3)}`);
        out.push({ event_index, explanation });
    }
    return out;
}
function skipped(event, reason) {
    return { source: "deterministic", facts: factsFromEvent(event), reason, attempts: [], cost_usd: null };
}
//# sourceMappingURL=pr.js.map