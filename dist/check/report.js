/** Plain-text report of a check: one block per event, strictest first, with each finding's loops. */
const SUMMARY = {
    new_cycle: (e) => `new runtime cycle of ${e.pr_groups[0].length} files`,
    cycle_grown: (e) => `cycle of ${e.base_groups[0].length} files grew to ${e.pr_groups[0].length}`,
    cycles_merged: (e) => `${e.base_groups.length} cycles merged into one of ${e.pr_groups[0].length} files`,
    loop_shortened: (e) => `shorter loops inside a cycle of ${e.pr_groups[0].length} files`,
    cycle_split: (e) => `cycle of ${e.base_groups[0].length} files split into ${e.pr_groups.length}`,
    cycle_shrunk: (e) => `cycle of ${e.base_groups[0].length} files shrank to ${e.pr_groups[0].length}`,
    cycle_resolved: (e) => `cycle of ${e.base_groups[0].length} files resolved`,
    no_regression: () => "no change to runtime import cycles makes them worse",
};
const RANK = { fail: 0, warn: 1, pass: 2 };
export function formatLoop(ev, indent = "  ") {
    const lines = [`${indent}loop (${ev.loop.length - 1} files): ${ev.loop.join(" -> ")}`];
    const width = Math.max(...ev.hops.map((h) => h.at.length));
    // runtime_names says which imported names keep the import at runtime, when the statement also imports types.
    for (const h of ev.hops) {
        lines.push(`${indent}  ${h.at.padEnd(width)}  ${h.statement ?? ""}${h.runtime_names ? `  (runtime: ${h.runtime_names.join(", ")})` : ""}`);
    }
    return lines;
}
export function formatReport(result) {
    const lines = [`rie check: ${result.outcome.toUpperCase()}`];
    const events = [...result.events].sort((a, b) => RANK[a.outcome] - RANK[b.outcome]);
    for (const e of events) {
        lines.push("", `${e.outcome.toUpperCase()}  ${e.type}: ${SUMMARY[e.type](e)}`);
        if (e.joined?.length)
            lines.push(`  joined: ${e.joined.join(", ")}`);
        if (e.left?.length)
            lines.push(`  left: ${e.left.join(", ")}`);
        for (const s of e.shortened ?? [])
            lines.push(`  ${s.file}: shortest loop ${s.base_length} -> ${s.pr_length} files`);
        for (const ev of e.evidence ?? [])
            lines.push(...formatLoop(ev));
    }
    for (const w of result.warnings)
        lines.push("", `WARNING: ${w}`);
    return lines.join("\n");
}
/** Marks the PR comment, so the action updates its own comment instead of adding one per push. */
export const COMMENT_MARKER = "<!-- rie-check -->";
/** Files listed per event and loops shown per event before the rest are counted; a PR comment is capped at 65,536 characters. */
const MAX_FILES = 20;
const MAX_LOOPS = 5;
const code = (s) => `\`${s.replace(/`/g, "'")}\``;
const fileList = (files) => files.slice(0, MAX_FILES).map(code).join(", ") + (files.length > MAX_FILES ? ` and ${files.length - MAX_FILES} more` : "");
/**
 * The PR comment and job summary: a table of every event, then the loops behind
 * each fail or warn. Pass events get a row and nothing else.
 */
export function formatMarkdown(result, context = {}, explanations = []) {
    const explained = new Map(explanations.map((x) => [result.events[x.event_index], x.explanation]));
    const events = [...result.events].sort((a, b) => RANK[a.outcome] - RANK[b.outcome]);
    const lines = [COMMENT_MARKER, `### rie check: ${result.outcome}`, ""];
    const against = context.baseCommit
        ? `Compared with ${code(context.baseCommit.slice(0, 10))}${context.baseRef ? `, the merge base with ${code(context.baseRef)}` : ""}. `
        : "";
    lines.push(`${against}Runtime import cycle groups: ${result.groups.base.length} on base, ${result.groups.pr.length} with this PR.`, "");
    lines.push("| Outcome | Event | Change |", "|---|---|---|");
    for (const e of events)
        lines.push(`| ${e.outcome} | ${code(e.type)} | ${SUMMARY[e.type](e)} |`);
    for (const e of events.filter((x) => x.outcome !== "pass")) {
        lines.push("", `#### ${e.outcome}: ${code(e.type)}, ${SUMMARY[e.type](e)}`);
        if (e.joined?.length)
            lines.push("", `Joined: ${fileList(e.joined)}`);
        if (e.shortened?.length) {
            lines.push("", "Shorter loops: " + e.shortened.slice(0, MAX_FILES).map((s) => `${code(s.file)} ${s.base_length} → ${s.pr_length} files`).join(", "));
        }
        const loops = e.evidence ?? [];
        for (const ev of loops.slice(0, MAX_LOOPS)) {
            lines.push("", `Loop of ${ev.loop.length - 1} files through an import this PR adds:`, "", "```", ...formatLoop(ev, "").slice(1).map((l) => l.trimStart()), "```");
        }
        if (loops.length > MAX_LOOPS)
            lines.push("", `${loops.length - MAX_LOOPS} more loop(s) in the job log.`);
        const x = explained.get(e);
        if (x)
            lines.push("", ...formatExplanation(x, loops));
    }
    for (const w of result.warnings)
        lines.push("", `> **Warning:** ${w.split("\n")[0]}`);
    lines.push("", "<sub>Runtime imports only: type-only imports and dynamic <code>import()</code> don't count, and barrel re-exports do. Cycles already on the base branch never fail a PR.</sub>");
    return lines.join("\n");
}
/** Longest explanation or suggestion shown; the agent is asked to be brief, this only bounds a runaway. */
const MAX_PROSE = 3000;
/** After an @, so "@name" no longer notifies anyone. */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
/**
 * The agent's text, made safe to post: it is model output written after reading a
 * diff the PR's author controls. No HTML, no @-mentions that would ping anyone,
 * and a length cap.
 */
export function safeProse(text) {
    const t = text.trim().replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/@(?=[\w-])/g, `@${ZERO_WIDTH_SPACE}`);
    return t.length > MAX_PROSE ? `${t.slice(0, MAX_PROSE)}…` : t;
}
const hopKey = (loop) => loop.hops.map((h) => `${h.from}>${h.to}:${h.line}`).join("|");
const evidenceKey = (ev) => ev.hops.map((h, i) => `${ev.loop[i]}>${ev.loop[i + 1]}:${h.at.slice(h.at.lastIndexOf(":") + 1)}`).join("|");
/**
 * The agent's part of one event: its explanation and the loops it cites when they
 * differ from rie check's (each hop of those passed the verifier), then its
 * suggestions, which nobody has checked. Without a verified finding, one line says
 * why there is no explanation, and none of the agent's text is shown.
 */
export function formatExplanation(x, evidence = []) {
    if (x.source === "deterministic") {
        const why = x.attempts.length === 0 ? x.reason : x.attempts.at(-1).status === "rejected" ? "its draft didn't pass verification" : "it returned no finding";
        return [`<sub>No explanation for this finding: ${safeProse(why)}.</sub>`];
    }
    const f = x.finding;
    const lines = ["##### Explanation (verified facts)", "", safeProse(f.why_it_matters)];
    const shown = new Set(evidence.map(evidenceKey));
    const extra = f.facts.loops.filter((l) => !shown.has(hopKey(l)));
    if (extra.length > 0) {
        lines.push("", "Loops the explanation cites (every hop checked against the import graph):");
        for (const loop of extra.slice(0, MAX_LOOPS)) {
            const width = Math.max(...loop.hops.map((h) => `${h.from}:${h.line}`.length));
            lines.push("", "```", ...loop.hops.map((h) => `${`${h.from}:${h.line}`.padEnd(width)}  ${h.statement ?? ""}${h.added_in_pr ? "  (added in this PR)" : ""}`), "```");
        }
    }
    if (f.suggestions.length > 0) {
        lines.push("", "##### Suggestions (not verified)", "", ...f.suggestions.slice(0, 5).map((sg) => `- ${safeProse(sg.text).replace(/\s*\n\s*/g, " ")}`));
    }
    return lines;
}
//# sourceMappingURL=report.js.map