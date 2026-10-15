import { dirname, resolve } from "node:path";
import { openDb } from "../storage/db.js";
import { indexRepository, normalizePath } from "../indexer/index.js";
import { describeUnresolved } from "../indexer/resolution.js";
import { cycleHops, findCircularDependencies } from "../engine/index.js";
export const DEFAULT_OUTCOMES = {
    new_cycle: "fail",
    cycle_grown: "fail",
    cycles_merged: "fail",
    loop_shortened: "warn",
    cycle_split: "pass",
    cycle_shrunk: "pass",
    cycle_resolved: "pass",
    no_regression: "pass",
};
/** Successor lists for a graph's edges, sorted. */
export function successors(edges) {
    const next = new Map();
    for (const e of edges)
        next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
    for (const list of next.values())
        list.sort();
    return next;
}
export function indexSnapshot(tsconfigPath) {
    const db = openDb(":memory:");
    const { unresolved, configErrors } = indexRepository(db, tsconfigPath);
    const root = normalizePath(dirname(resolve(tsconfigPath))).replace(/\/+$/, "") + "/";
    const stored = new Map();
    const rel = (p) => {
        const r = p.toLowerCase().startsWith(root.toLowerCase()) ? p.slice(root.length) : p;
        stored.set(r, p);
        return r;
    };
    const groups = findCircularDependencies(db).map((g) => g.files.map(rel).sort());
    const rows = db
        .prepare(`SELECT from_file, to_file, MIN(line) AS line FROM edges WHERE is_type_only = 0
        GROUP BY from_file, to_file`)
        .all();
    const edges = rows.map((r) => ({ from: rel(r.from_file), to: rel(r.to_file), line: r.line ?? 0 }));
    return {
        db,
        stored,
        groups,
        edges,
        next: successors(edges),
        unresolved: unresolved.length,
        unresolvedSummary: unresolved.length > 0 ? describeUnresolved(unresolved) : "",
        configErrors,
    };
}
/** Shortest path from `from` to `to` (both included), or null. */
function shortestPath(next, from, to) {
    const parent = new Map();
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length > 0) {
        const at = queue.shift();
        if (at === to) {
            const path = [to];
            while (path[0] !== from)
                path.unshift(parent.get(path[0]));
            return path;
        }
        for (const n of next.get(at) ?? []) {
            if (seen.has(n))
                continue;
            seen.add(n);
            parent.set(n, at);
            queue.push(n);
        }
    }
    return null;
}
/** Files on the shortest loop through `file`; 0 when it is in none. */
export function shortestLoopLength(snapshot, file) {
    let best = Infinity;
    for (const n of snapshot.next.get(file) ?? []) {
        const back = n === file ? [file] : shortestPath(snapshot.next, n, file);
        if (back)
            best = Math.min(best, back.length);
    }
    return Number.isFinite(best) ? best : 0;
}
/** The loop through `from -> to` and the import behind each hop. */
export function loopEvidence(snapshot, from, to) {
    const back = to === from ? [from] : shortestPath(snapshot.next, to, from);
    if (!back)
        return null;
    const loop = [from, ...back];
    const relOf = new Map([...snapshot.stored].map(([r, abs]) => [abs, r]));
    const hops = cycleHops(snapshot.db, loop.map((f) => snapshot.stored.get(f)), false, (p) => relOf.get(p) ?? p).map(({ at, statement, runtime_names }) => ({ at, statement, ...(runtime_names && { runtime_names }) }));
    return { loop, hops };
}
const RANK = { pass: 0, warn: 1, fail: 2 };
const key = (from, to) => `${from}\u0000${to}`;
const sortGroups = (groups) => [...groups].sort((a, b) => a.join().localeCompare(b.join()));
/**
 * Compare two snapshots' runtime graphs. Evidence (the loop and the import line
 * behind each hop) needs the PR side's RIE index; for any other graph, such as the
 * emit oracle's, events come without it.
 */
export function compareSnapshots(base, pr, options = {}) {
    const renames = options.renames ?? {};
    const unrenames = Object.fromEntries(Object.entries(renames).map(([b, p]) => [p, b]));
    const toPr = (f) => renames[f] ?? f;
    const toBase = (f) => unrenames[f] ?? f;
    const outcomeOf = (type) => options.outcomes?.[type] ?? DEFAULT_OUTCOMES[type];
    const baseSets = base.groups.map((g) => new Set(g.map(toPr)));
    const inBase = new Set(baseSets.flatMap((s) => [...s]));
    const inPr = new Set(pr.groups.flat());
    const baseEdges = new Set(base.edges.map((e) => key(toPr(e.from), toPr(e.to))));
    /** Each new runtime import inside the group, in (file, line) order, with the shortest loop through it; edges already on a loop are skipped. */
    const evidenceFor = (group) => {
        if (!("db" in pr))
            return undefined;
        const members = new Set(group);
        const added = pr.edges
            .filter((e) => members.has(e.from) && members.has(e.to) && !baseEdges.has(key(e.from, e.to)))
            .sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line);
        const covered = new Set();
        const out = [];
        for (const e of added) {
            if (covered.has(key(e.from, e.to)))
                continue;
            const ev = loopEvidence(pr, e.from, e.to);
            if (!ev)
                continue;
            ev.loop.slice(1).forEach((to, i) => covered.add(key(ev.loop[i], to)));
            ev.hops = ev.hops.map((hop, i) => ({ ...hop, added: !baseEdges.has(key(ev.loop[i], ev.loop[i + 1])) }));
            out.push(ev);
        }
        return out;
    };
    const events = [];
    const event = (type, fields, evidenceGroup) => {
        const outcome = outcomeOf(type);
        const evidence = outcome !== "pass" && evidenceGroup ? evidenceFor(evidenceGroup) : undefined;
        events.push({ type, outcome, ...fields, ...(evidence && { evidence }) });
    };
    // PR side: groups that are new, grew or merged.
    const prInfo = pr.groups.map((group) => ({
        group,
        overlaps: baseSets.flatMap((s, i) => (group.some((f) => s.has(f)) ? [i] : [])),
        joined: group.filter((f) => !inBase.has(f)).sort(),
    }));
    for (const { group, overlaps, joined } of prInfo) {
        const baseGroups = sortGroups(overlaps.map((i) => base.groups[i]));
        if (overlaps.length === 0)
            event("new_cycle", { base_groups: [], pr_groups: [group], joined }, group);
        else if (overlaps.length > 1)
            event("cycles_merged", { base_groups: baseGroups, pr_groups: [group], joined }, group);
        else if (joined.length > 0)
            event("cycle_grown", { base_groups: baseGroups, pr_groups: [group], joined }, group);
    }
    // Base side: groups that resolved, split, shrank, or kept their files but gained a shorter loop.
    base.groups.forEach((group, i) => {
        const images = prInfo.filter((p) => p.overlaps.includes(i));
        const left = group.filter((f) => !inPr.has(toPr(f))).sort();
        if (images.length === 0) {
            event("cycle_resolved", { base_groups: [group], pr_groups: [], left });
            return;
        }
        // A group that grew or merged was reported above; the rest only lose files or loops.
        if (images.some((p) => p.overlaps.length > 1 || p.joined.length > 0))
            return;
        const prGroups = sortGroups(images.map((p) => p.group));
        if (images.length > 1) {
            event("cycle_split", { base_groups: [group], pr_groups: prGroups, ...(left.length > 0 && { left }) });
        }
        else if (left.length > 0) {
            event("cycle_shrunk", { base_groups: [group], pr_groups: prGroups, left });
        }
        else {
            const shortened = images[0].group
                .map((file) => ({ file, base_length: shortestLoopLength(base, toBase(file)), pr_length: shortestLoopLength(pr, file) }))
                .filter((x) => x.pr_length < x.base_length);
            if (shortened.length > 0)
                event("loop_shortened", { base_groups: [group], pr_groups: prGroups, shortened }, images[0].group);
        }
    });
    if (events.length === 0)
        events.push({ type: "no_regression", outcome: outcomeOf("no_regression") });
    const outcome = events.reduce((worst, e) => (RANK[e.outcome] > RANK[worst] ? e.outcome : worst), "pass");
    return { outcome, events, groups: { base: base.groups, pr: pr.groups } };
}
/** One warning for a tsconfig's own errors; the first line is what the PR comment shows. */
export function configWarning(which, errors) {
    // A config that isn't found is usually an `extends` from a package that isn't installed.
    const hint = errors.some((e) => /not found/i.test(e)) ? " (are the dependencies installed?)" : "";
    return [
        `${errors.length} error(s) in ${which}, so its compiler options may be incomplete${hint}: ${errors[0]}`,
        ...errors.slice(1),
    ].join("\n");
}
/** Index both snapshots and compare them, leaving both indexes open. */
export function checkCyclesOpen(input) {
    const base = indexSnapshot(input.base);
    const pr = indexSnapshot(input.pr);
    try {
        const warnings = [];
        for (const [name, s] of [["base", base], ["PR", pr]]) {
            if (s.configErrors.length > 0)
                warnings.push(configWarning(`the ${name} snapshot's tsconfig`, s.configErrors));
            if (s.unresolved > 0) {
                warnings.push(`${s.unresolved} internal import(s) don't resolve in the ${name} snapshot, so its graph is missing edges:\n${s.unresolvedSummary}`);
            }
        }
        return { result: { ...compareSnapshots(base, pr, input), warnings }, base, pr };
    }
    catch (e) {
        base.db.close();
        pr.db.close();
        throw e;
    }
}
/** Index both snapshots and compare them. */
export function checkCycles(input) {
    const { result, base, pr } = checkCyclesOpen(input);
    base.db.close();
    pr.db.close();
    return result;
}
//# sourceMappingURL=index.js.map