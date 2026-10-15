import { parseFinding } from "./finding.js";
const key = (from, to) => `${from}\u0000${to}`;
const collapse = (s) => s.replace(/\s+/g, " ").trim();
/** Check a parsed finding's facts against the PR's graph. */
export function verifyFinding(finding, ctx) {
    const { event, pr, base } = ctx;
    const renames = ctx.renames ?? {};
    const toPr = (f) => renames[f] ?? f;
    const baseEdges = new Set(base.edges.map((e) => key(toPr(e.from), toPr(e.to))));
    const inEvent = new Set((event.pr_groups ?? []).flat());
    const rowsOf = pr.db.prepare(`SELECT line, statement, is_type_only FROM edges WHERE from_file = ? AND to_file = ? ORDER BY line`);
    const errors = [];
    if (finding.event !== event.type)
        errors.push(`event: the finding explains ${finding.event}, but the event is ${event.type}`);
    finding.facts.loops.forEach((loop, i) => {
        const at = `facts.loops.${i}`;
        loop.hops.forEach((hop, j) => {
            const fail = (message) => errors.push(`${at}.hops.${j}: ${message}`);
            const from = pr.stored.get(hop.from);
            const to = pr.stored.get(hop.to);
            if (!from)
                return fail(`${hop.from} is not a file in the PR`);
            if (!to)
                return fail(`${hop.to} is not a file in the PR`);
            if (!inEvent.has(hop.from))
                fail(`${hop.from} is not in the ${event.type} event's cycle group`);
            const rows = rowsOf.all(from, to);
            if (rows.length === 0)
                return fail(`${hop.from} does not import ${hop.to}`);
            const atLine = rows.filter((r) => r.line === hop.line);
            if (atLine.length === 0) {
                const lines = [...new Set(rows.map((r) => r.line).filter((l) => l !== null))];
                return fail(`${hop.from} has no import of ${hop.to} at line ${hop.line}${lines.length > 0 ? ` (it imports it at line ${lines.join(", ")})` : ""}`);
            }
            const statement = atLine[0].statement;
            if ((hop.statement === null) !== (statement === null) || (hop.statement !== null && collapse(hop.statement) !== collapse(statement))) {
                fail(`the statement at ${hop.from}:${hop.line} is ${statement === null ? "not recorded" : JSON.stringify(collapse(statement))}, not ${JSON.stringify(hop.statement)}`);
            }
            const runtime = atLine.some((r) => r.is_type_only === 0);
            if (hop.runtime !== runtime) {
                fail(`the import at ${hop.from}:${hop.line} is ${runtime ? "a runtime import" : "type-only (erased at compile time)"}, but the finding says the opposite`);
            }
            if (!runtime)
                fail(`the import at ${hop.from}:${hop.line} is erased at compile time, so this loop is not a runtime cycle`);
            const added = !baseEdges.has(key(hop.from, hop.to));
            if (hop.added_in_pr !== added) {
                fail(`${hop.from} -> ${hop.to} ${added ? "was added by the PR" : "is already a runtime import on the base branch"}, but the finding says the opposite`);
            }
        });
        if (!loop.hops.some((h) => h.added_in_pr))
            errors.push(`${at}: no hop of this loop is an import the PR added, so it doesn't show what the PR changed`);
    });
    return errors.length === 0 ? { ok: true, finding } : { ok: false, errors };
}
/** Shape check, then fact check: every reason a draft is refused, for the revise loop. */
export function checkFinding(input, ctx) {
    const parsed = parseFinding(input);
    return parsed.ok ? verifyFinding(parsed.finding, ctx) : parsed;
}
//# sourceMappingURL=verify.js.map