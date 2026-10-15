import { indexRepository, loadTsconfig } from "../indexer/index.js";
import { createLanguageService, indexReferences } from "../indexer/references.js";
/** find_module(name): locate which file(s) define a symbol. */
export function findModule(db, name) {
    const declarations = db
        .prepare(`SELECT name, kind, file_path, line_start
         FROM symbols WHERE name = ? ORDER BY file_path`)
        .all(name);
    if (declarations.length > 0)
        return { symbol_indexed: true, declarations };
    // Names are matched exactly (case-sensitive, like the language), so the likeliest
    // near miss is a casing slip - `userService` for `UserService`.
    const similar = db
        .prepare(`SELECT DISTINCT name FROM symbols WHERE name = ? COLLATE NOCASE ORDER BY name LIMIT 10`)
        .all(name).map((r) => r.name);
    return {
        symbol_indexed: false,
        declarations: [],
        ...(similar.length > 0 && { similar_names: similar }),
        note: `No top-level declaration named "${name}" is indexed. Only top-level class/function/` +
            `interface/type/const/enum declarations are - methods, properties, enum members, namespaces, ` +
            `non-const variables and locals are not, so this does NOT mean the name is absent from the repo.`,
    };
}
/** find_related_files(file_path): both directions, via the file-level edges table. */
export function findRelatedFiles(db, filePath) {
    const { resolved, candidates } = resolveIndexedPath(db, filePath);
    if (!resolved) {
        return {
            file_indexed: false,
            resolved_path: null,
            imports: [],
            imported_by: [],
            note: candidates.length > 1
                ? `"${filePath}" matches ${candidates.length} indexed files - give a longer path. Candidates: ${candidates.join(", ")}`
                : `"${filePath}" is not in the index (not a .ts/.tsx file under the indexed tsconfig, or the index is stale - try reindex).`,
        };
    }
    const imports = db
        .prepare(`SELECT DISTINCT to_file FROM edges WHERE from_file = ? ORDER BY to_file`)
        .all(resolved)
        .map((r) => r.to_file);
    const importedBy = db
        .prepare(`SELECT DISTINCT from_file FROM edges WHERE to_file = ? ORDER BY from_file`)
        .all(resolved)
        .map((r) => r.from_file);
    return { file_indexed: true, resolved_path: resolved, imports, imported_by: importedBy };
}
/**
 * Resolve a caller-supplied path to the exact string the index stores (absolute,
 * forward-slash — see indexer). Callers on Windows naturally pass backslash paths
 * (that's what Read/Grep hand an agent) and often repo-relative ones; exact string
 * equality made all of those silently return empty results, which benchmark
 * transcripts showed sends agents straight back to grep (the driver-impact
 * regression). Matching is case-insensitive because Windows filesystems are.
 * Resolution order: exact match, then unique suffix match on a '/' boundary.
 * Returns resolved:null with the candidate list when nothing (or too much) matches.
 */
function resolveIndexedPath(db, givenPath) {
    const normalized = givenPath.replace(/\\/g, "/");
    const lower = normalized.toLowerCase();
    const allFiles = db
        .prepare(`SELECT file_path AS f FROM symbols
         UNION SELECT from_file FROM edges
         UNION SELECT to_file FROM edges`)
        .all().map((r) => r.f);
    const exact = allFiles.filter((f) => f.toLowerCase() === lower);
    if (exact.length === 1)
        return { resolved: exact[0], candidates: exact };
    const bySuffix = allFiles.filter((f) => f.toLowerCase().endsWith(`/${lower}`)).sort();
    if (bySuffix.length === 1)
        return { resolved: bySuffix[0], candidates: bySuffix };
    return { resolved: null, candidates: bySuffix };
}
/**
 * find_symbol_references(symbol): everywhere a symbol is used (from references_).
 * Each reference carries the declaring file + kind, because a bare name can match
 * several distinct symbols (e.g. a `Comment` entity class AND a `Comment`
 * interface in the same repo) - without the declaration attached, those merge
 * into one undifferentiated list. Pass declaredIn to scope to one declaration.
 *
 * The result distinguishes "indexed but unreferenced" (symbol_indexed: true,
 * references: []) from "not in the index at all" (symbol_indexed: false + note) -
 * previously both returned a bare [], which silently misled for names the index
 * never records, like class methods.
 *
 * `re_exported_by` covers the blind spot that identifier-based reference search
 * has by construction: `export * from './X'` re-exports X's symbols without
 * writing any of their names, so no reference search can see it. Measured on
 * TypeORM, the @Entity decorator's only use outside its own file was exactly
 * such a barrel re-export, and reporting 0 external references without it read
 * as "dead code".
 */
export function findSymbolReferences(db, symbol, declaredIn) {
    const queryBoth = (path) => {
        const declSql = `SELECT name, kind, file_path, line_start
         FROM symbols WHERE name = ?${path ? " AND file_path = ?" : ""}
        ORDER BY file_path`;
        const refSql = `SELECT r.used_in_file, r.line, s.file_path AS declared_in, s.kind
         FROM references_ r
         JOIN symbols s ON s.id = r.symbol_id
        WHERE s.name = ?${path ? " AND s.file_path = ?" : ""}
        ORDER BY r.used_in_file, r.line`;
        return {
            declarations: (path
                ? db.prepare(declSql).all(symbol, path)
                : db.prepare(declSql).all(symbol)),
            references: (path
                ? db.prepare(refSql).all(symbol, path)
                : db.prepare(refSql).all(symbol)),
        };
    };
    // Resolve the path filter to the index's canonical form before comparing: a
    // backslash or repo-relative declaredIn used to fail string equality and made
    // this function claim the symbol wasn't indexed at all (see resolveIndexedPath).
    // An unresolvable filter is dropped (with a note), never silently applied.
    let note;
    let filterPath;
    if (declaredIn !== undefined) {
        const { resolved, candidates } = resolveIndexedPath(db, declaredIn);
        if (resolved) {
            filterPath = resolved;
        }
        else {
            note =
                candidates.length > 1
                    ? `file_path "${declaredIn}" matches ${candidates.length} indexed files (${candidates.join(", ")}) - ignoring the filter and showing every declaration of "${symbol}".`
                    : `file_path "${declaredIn}" is not in the index - ignoring the filter and showing every declaration of "${symbol}".`;
        }
    }
    let { declarations, references } = queryBoth(filterPath);
    // A path that resolves but declares no symbol of this name must not read as
    // "name not indexed" either: drop the filter and say exactly what happened.
    if (declarations.length === 0 && filterPath !== undefined) {
        const unfiltered = queryBoth(undefined);
        if (unfiltered.declarations.length > 0) {
            declarations = unfiltered.declarations;
            references = unfiltered.references;
            note = `"${symbol}" has no declaration in ${filterPath} - ignoring the filter. It is declared in: ${declarations.map((d) => d.file_path).join(", ")}.`;
        }
    }
    const result = {
        symbol_indexed: declarations.length > 0,
        declarations,
        references,
    };
    const declFiles = [...new Set(declarations.map((d) => d.file_path))];
    if (declFiles.length > 0) {
        const placeholders = declFiles.map(() => "?").join(", ");
        const reExporters = db
            .prepare(`SELECT DISTINCT from_file FROM edges
          WHERE edge_type = 'reexport_star' AND to_file IN (${placeholders})
          ORDER BY from_file`)
            .all(...declFiles);
        if (reExporters.length > 0)
            result.re_exported_by = reExporters.map((r) => r.from_file);
    }
    if (note !== undefined)
        result.note = note;
    if (!result.symbol_indexed) {
        result.note =
            `"${symbol}" is not in the index. Only top-level declarations (class/function/` +
                `interface/type/const/enum) are indexed - methods, properties, enum members, and locals are not. ` +
                `An empty reference list here does NOT mean the name is unused.`;
    }
    return result;
}
/** A path-looking argument (has a separator or a source-file extension) names a file, anything else a symbol. */
function looksLikeFilePath(arg) {
    return /[\\/]/.test(arg) || /\.[cm]?[jt]sx?$/i.test(arg);
}
/**
 * edges (plan §7 — the one tool with real traversal, directed by `from_file ->
 * to_file`). Returns the shortest file chain, or found:false if no directed path
 * exists (imports are one-way, so a->b connected does not imply b->a connected).
 *
 * Each end is a symbol name OR a file path. Symbol-only ends made file-to-file
 * questions unanswerable - a barrel like `index.ts` declares nothing to name - so
 * an agent asked "does file A import file B?" had to fall back to grep.
 *
 * runtimeOnly follows only imports that survive compilation. Without it, trap tasks
 * ("can each file reach the other at runtime?") cost ~1.4x the bash+madge arm: the
 * agent got a chain that might run through erased imports and read files to check
 * each hop.
 */
export function dependencyPath(db, a, b, options = {}) {
    const rel = relativizer(options.root);
    const runtimeOnly = options.runtimeOnly ?? false;
    const path_type = runtimeOnly ? "runtime" : "runtime_and_type_only";
    const notes = [];
    const endpoint = (arg) => {
        if (!looksLikeFilePath(arg)) {
            const files = filesOfSymbol(db, arg);
            if (files.length === 0) {
                notes.push(`"${arg}" is not an indexed symbol (only top-level class/function/interface/type/const/enum ` +
                    `declarations are), so no path was searched. Pass a file path instead.`);
            }
            return files;
        }
        const { resolved, candidates } = resolveIndexedPath(db, arg);
        if (resolved)
            return [resolved];
        notes.push(candidates.length > 1
            ? `"${arg}" matches ${candidates.length} indexed files - pass a longer path: ${candidates.map(rel).join(", ")}`
            : `"${arg}" is not an indexed file.`);
        return [];
    };
    const candidatesA = endpoint(a);
    const candidatesB = endpoint(b);
    const fileA = candidatesA[0];
    const fileB = candidatesB[0];
    // Disclose multi-declaration names instead of silently tie-breaking. The chosen
    // file is the alphabetically first candidate - deterministic, unlike the
    // unordered LIMIT 1 this replaced, which picked by insertion order.
    const ambiguity = {};
    if (candidatesA.length > 1)
        ambiguity.symbol_a = { chosen: rel(fileA), candidates: candidatesA.map(rel) };
    if (candidatesB.length > 1)
        ambiguity.symbol_b = { chosen: rel(fileB), candidates: candidatesB.map(rel) };
    const withAmbiguity = (result) => ({
        ...result,
        ...((ambiguity.symbol_a || ambiguity.symbol_b) && { ambiguity }),
        ...(notes.length > 0 && { note: notes.join(" ") }),
    });
    if (!fileA || !fileB)
        return withAmbiguity({ found: false, chain: [], path_type });
    if (fileA === fileB)
        return withAmbiguity({ found: true, chain: [rel(fileA)], path_type });
    const found = shortestPath(db, fileA, fileB, runtimeOnly);
    if (found.chain) {
        return withAmbiguity({
            found: true,
            chain: found.chain.map(rel),
            path_type,
            hops: cycleHops(db, found.chain, !runtimeOnly, rel),
        });
    }
    const result = { found: false, chain: [], path_type, files_searched: found.searched };
    if (runtimeOnly)
        result.type_only_path_exists = shortestPath(db, fileA, fileB, false).chain !== null;
    result.note =
        `No ${runtimeOnly ? "runtime " : ""}import path from ${rel(fileA)} to ${rel(fileB)}. The search was exhaustive: it followed every ` +
            `static import and re-export (${runtimeOnly ? "type-only excluded - they are erased at compile time" : "type-only included"}) ` +
            `from ${rel(fileA)} and reached ${found.searched} file(s), none of which is ${rel(fileB)}. Reading files will not find a path ` +
            `this missed - only a dynamic import() or a require() inside a function would, and neither is an import edge.` +
            (result.type_only_path_exists ? " A path does exist once type-only imports are counted, but it cannot run." : "");
    return withAmbiguity(result);
}
/** BFS a shortest directed file chain from `from` to `to`; searched = files reached when there is none. */
function shortestPath(db, from, to, runtimeOnly) {
    const neighborsOf = db.prepare(runtimeOnly
        ? `SELECT DISTINCT to_file FROM edges WHERE from_file = ? AND is_type_only = 0`
        : `SELECT DISTINCT to_file FROM edges WHERE from_file = ?`);
    const parent = new Map();
    const visited = new Set([from]);
    const queue = [from];
    while (queue.length > 0) {
        const current = queue.shift();
        for (const { to_file } of neighborsOf.all(current)) {
            if (visited.has(to_file))
                continue;
            visited.add(to_file);
            parent.set(to_file, current);
            if (to_file === to) {
                const chain = [to];
                let node = to;
                while (node !== from) {
                    node = parent.get(node);
                    chain.unshift(node);
                }
                return { chain, searched: visited.size };
            }
            queue.push(to_file);
        }
    }
    return { chain: null, searched: visited.size };
}
/**
 * find_circular_dependencies(): import cycles in the repo (plan §9 stretch 1).
 *
 * Reports strongly connected components rather than enumerating every simple
 * cycle: a tangled component can contain exponentially many simple cycles, so
 * listing them all is neither computable nor useful. Each SCC of 2+ files is one
 * genuine circular-dependency group, plus self-imports (a 1-file SCC with an edge
 * to itself). Each group carries one concrete example cycle so the result is
 * actionable rather than just a set membership claim.
 *
 * By default only runtime edges count — see CircularDependencyOptions.
 *
 * Groups are ordered largest first — the biggest tangle is usually the one worth
 * breaking. Uses Tarjan's algorithm over the file-level edges. Recursion depth is
 * bounded by the longest import chain (tens, in real codebases), not file count.
 */
export function findCircularDependencies(db, options = {}) {
    // DISTINCT is applied after filtering, so a file pair joined by both a type-only
    // and a value import correctly survives as a runtime edge.
    const sql = options.includeTypeOnly
        ? `SELECT DISTINCT from_file, to_file FROM edges`
        : `SELECT DISTINCT from_file, to_file FROM edges WHERE is_type_only = 0`;
    const edges = db.prepare(sql).all();
    const adjacency = new Map();
    const selfImports = new Set();
    for (const { from_file, to_file } of edges) {
        if (!adjacency.has(from_file))
            adjacency.set(from_file, []);
        adjacency.get(from_file).push(to_file);
        if (!adjacency.has(to_file))
            adjacency.set(to_file, []);
        if (from_file === to_file)
            selfImports.add(from_file);
    }
    let counter = 0;
    const index = new Map();
    const lowlink = new Map();
    const onStack = new Set();
    const stack = [];
    const components = [];
    const strongConnect = (v) => {
        index.set(v, counter);
        lowlink.set(v, counter);
        counter++;
        stack.push(v);
        onStack.add(v);
        for (const w of adjacency.get(v) ?? []) {
            if (!index.has(w)) {
                strongConnect(w);
                lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
            }
            else if (onStack.has(w)) {
                lowlink.set(v, Math.min(lowlink.get(v), index.get(w)));
            }
        }
        if (lowlink.get(v) === index.get(v)) {
            const component = [];
            let w;
            do {
                w = stack.pop();
                onStack.delete(w);
                component.push(w);
            } while (w !== v);
            components.push(component);
        }
    };
    for (const file of adjacency.keys()) {
        if (!index.has(file))
            strongConnect(file);
    }
    const cycles = [];
    for (const component of components) {
        const isCycle = component.length > 1 || selfImports.has(component[0]);
        if (!isCycle)
            continue;
        const members = new Set(component);
        cycles.push({
            files: [...component].sort(),
            example_cycle: shortestCycleThrough(component[0], members, adjacency),
        });
    }
    // Largest tangle first; file list breaks ties so the output is deterministic.
    return cycles.sort((a, b) => b.files.length - a.files.length || a.files[0].localeCompare(b.files[0]));
}
/** Member lists are printed inline for groups up to this size; larger ones need include_files. */
const INLINE_GROUP_FILES = 8;
/**
 * The MCP-facing form of findCircularDependencies: same groups, compact output.
 * The full form (absolute paths, every member of every group) measured ~25K chars
 * on directus - 5 groups, one of 157 files - and agents called it in 50/50 runs,
 * so it sat in context and was re-read on every later turn; the rie arm spent
 * ~1.6x the baseline's tokens per correct answer. It also didn't answer the
 * question those tasks asked ("a loop through file X": the example covers one
 * member), so agents grepped anyway. Here: relative paths, large groups
 * summarized, and a pointer to findCycleThroughFile for the per-file question.
 */
export function circularDependencyReport(db, options = {}) {
    const rel = relativizer(options.root);
    const cycles = findCircularDependencies(db, options);
    const groups = cycles.map((c) => ({
        size: c.files.length,
        example_cycle: c.example_cycle.map(rel),
        ...((options.includeFiles || c.files.length <= INLINE_GROUP_FILES) && { files: c.files.map(rel) }),
    }));
    const report = {
        cycle_type: options.includeTypeOnly ? "runtime_and_type_only" : "runtime",
        groups,
        files_in_cycles: groups.reduce((n, g) => n + g.size, 0),
    };
    const notes = [];
    if (groups.some((g) => !g.files)) {
        notes.push(`Member lists are omitted for groups over ${INLINE_GROUP_FILES} files (pass include_files to list them).`);
    }
    if (groups.length > 0) {
        notes.push("example_cycle is one loop per group, not a loop through any particular file - " +
            "for a specific file, call find_cycle_through_file: it returns the shortest loop through that file, or proves there is none.");
    }
    if (notes.length > 0)
        report.note = notes.join(" ");
    return report;
}
/**
 * find_cycle_through_file(file): the shortest import loop that starts and ends at
 * this file (BFS over outgoing edges until one leads back). Any such loop lies
 * inside the file's SCC, so this is exactly "is this file in a cycle, and via
 * which chain" - the question the directus cycle tasks asked, which
 * find_circular_dependencies' one-example-per-group output could not answer.
 */
export function findCycleThroughFile(db, filePath, options = {}) {
    const rel = relativizer(options.root);
    const cycle_type = options.includeTypeOnly ? "runtime_and_type_only" : "runtime";
    const { resolved, candidates } = resolveIndexedPath(db, filePath);
    if (!resolved) {
        return {
            file_indexed: false,
            resolved_path: null,
            cycle_type,
            in_cycle: false,
            cycle: [],
            loop_length: 0,
            note: candidates.length > 1
                ? `"${filePath}" matches ${candidates.length} indexed files - give a longer path. Candidates: ${candidates.map(rel).join(", ")}`
                : `"${filePath}" is not in the index (not a .ts/.tsx file under the indexed tsconfig, or the index is stale - try reindex).`,
        };
    }
    const found = shortestLoopFrom(db, resolved, options.includeTypeOnly ?? false);
    if (found.cycle) {
        return {
            file_indexed: true,
            resolved_path: rel(resolved),
            cycle_type,
            in_cycle: true,
            cycle: found.cycle.map(rel),
            loop_length: found.cycle.length - 1,
            hops: cycleHops(db, found.cycle, options.includeTypeOnly ?? false, rel),
        };
    }
    const result = {
        file_indexed: true,
        resolved_path: rel(resolved),
        cycle_type,
        in_cycle: false,
        cycle: [],
        loop_length: 0,
        files_searched: found.searched,
    };
    if (!options.includeTypeOnly) {
        result.type_only_cycle_exists = shortestLoopFrom(db, resolved, true).cycle !== null;
    }
    result.note =
        `No ${options.includeTypeOnly ? "" : "runtime "}import path leads from ${rel(resolved)} back to itself. ` +
            `The search was exhaustive over the ${found.searched} file(s) it transitively imports` +
            (options.includeTypeOnly ? "" : " (type-only imports excluded - they are erased at compile time)") +
            `.` +
            (result.type_only_cycle_exists ? " A loop does exist once type-only imports are counted, but it cannot run." : "");
    return result;
}
/**
 * The evidence for each step of a loop or path. Benchmark agents given only the file chain
 * grepped every hop (all 50 directus runs did) to confirm it was a real, non-type
 * import; this hands them the statement and the checker's runtime verdict instead.
 * When a pair is joined by several statements, the first runtime one is cited.
 * Also used by rie check (src/check) for the evidence behind each finding.
 */
export function cycleHops(db, cycle, includeTypeOnly, rel) {
    const rowsOf = db.prepare(`SELECT line, statement, is_type_only, imported_name AS name
       FROM edges
      WHERE from_file = ? AND to_file = ?${includeTypeOnly ? "" : " AND is_type_only = 0"}
      ORDER BY is_type_only, line`);
    const hops = [];
    for (let i = 0; i + 1 < cycle.length; i++) {
        const rows = rowsOf.all(cycle[i], cycle[i + 1]);
        const first = rows[0];
        const sameStatement = rows.filter((r) => r.line === first.line);
        const names = [
            ...new Set(sameStatement.filter((r) => !r.is_type_only && r.name !== null).map((r) => r.name)),
        ];
        hops.push({
            at: first.line === null ? rel(cycle[i]) : `${rel(cycle[i])}:${first.line}`,
            statement: first.statement,
            ...(names.length > 0 && { runtime_names: names }),
            ...(includeTypeOnly && { type_only: first.is_type_only === 1 }),
        });
    }
    return hops;
}
/** BFS from `start` over outgoing edges until one returns to it. */
function shortestLoopFrom(db, start, includeTypeOnly) {
    const neighborsOf = db.prepare(includeTypeOnly
        ? `SELECT DISTINCT to_file FROM edges WHERE from_file = ?`
        : `SELECT DISTINCT to_file FROM edges WHERE from_file = ? AND is_type_only = 0`);
    const parent = new Map();
    const visited = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
        const current = queue.shift();
        for (const { to_file } of neighborsOf.all(current)) {
            if (to_file === start) {
                const cycle = [current];
                let node = current;
                while (node !== start) {
                    node = parent.get(node);
                    cycle.unshift(node);
                }
                return { cycle: [...cycle, start], searched: visited.size };
            }
            if (visited.has(to_file))
                continue;
            visited.add(to_file);
            parent.set(to_file, current);
            queue.push(to_file);
        }
    }
    return { cycle: null, searched: visited.size };
}
/** Path -> path relative to root when it lies under root (case-insensitive, like resolveIndexedPath); identity without a root. */
function relativizer(root) {
    if (!root)
        return (p) => p;
    const prefix = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    const lowerPrefix = prefix.toLowerCase();
    return (p) => (p.toLowerCase().startsWith(lowerPrefix) ? p.slice(prefix.length) : p);
}
/** BFS a shortest path from `start` back to itself, never leaving the component. */
function shortestCycleThrough(start, members, adjacency) {
    const parent = new Map();
    const queue = [start];
    const seen = new Set();
    while (queue.length > 0) {
        const current = queue.shift();
        for (const next of adjacency.get(current) ?? []) {
            if (!members.has(next))
                continue;
            if (next === start) {
                const cycle = [current];
                let node = current;
                while (node !== start) {
                    node = parent.get(node);
                    cycle.unshift(node);
                }
                return [...cycle, start];
            }
            if (seen.has(next))
                continue;
            seen.add(next);
            parent.set(next, current);
            queue.push(next);
        }
    }
    return [start, start]; // only reachable for a self-import
}
/** Every file declaring a symbol of this name, alphabetically (deterministic). */
function filesOfSymbol(db, name) {
    const rows = db
        .prepare(`SELECT DISTINCT file_path FROM symbols WHERE name = ? ORDER BY file_path`)
        .all(name);
    return rows.map((r) => r.file_path);
}
export function reindex(db, tsconfigPath) {
    const run = db.transaction(() => {
        const { unresolved, configErrors } = indexRepository(db, tsconfigPath);
        const { fileNames, options } = loadTsconfig(tsconfigPath);
        const service = createLanguageService(fileNames, options);
        indexReferences(db, service);
        return { unresolved_internal_imports: unresolved, config_errors: configErrors };
    });
    return run();
}
//# sourceMappingURL=index.js.map