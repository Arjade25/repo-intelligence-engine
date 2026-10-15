import type Database from "better-sqlite3";
import type { UnresolvedImport } from "../indexer/resolution.js";
/**
 * Query engine (plan §5): pure functions over the SQLite index. This is the
 * product. The MCP server is a thin adapter over these — step 5's Done-when is
 * that an MCP call and the matching call here return identical results, so keep
 * ALL logic in this file, none in mcp-server/.
 */
export interface SymbolDeclaration {
    name: string;
    kind: string;
    file_path: string;
    line_start: number | null;
}
export interface RelatedFiles {
    /**
     * false = the given path resolved to no indexed file. Without this flag an
     * unresolvable path silently returned two empty arrays — indistinguishable from
     * "indexed, but genuinely unconnected", which sent benchmark agents back to grep.
     */
    file_indexed: boolean;
    resolved_path: string | null;
    imports: string[];
    imported_by: string[];
    note?: string;
}
export interface FindModuleResult {
    /**
     * false = no top-level declaration has this exact name. find_module used to
     * return a bare [] here - the one tool left doing so after the others gained
     * explicit not-found results - and benchmark agents read an empty list as
     * "no results" and fell back to grep. Mirrors find_symbol_references' flag.
     */
    symbol_indexed: boolean;
    declarations: SymbolDeclaration[];
    /** Indexed names equal to the query ignoring case - set only on a miss, omitted when none. */
    similar_names?: string[];
    note?: string;
}
export interface SymbolReference {
    used_in_file: string;
    line: number | null;
    declared_in: string;
    kind: string;
}
export interface SymbolReferencesResult {
    /**
     * false = the name is not in the index AT ALL, which is very different from
     * "indexed but unreferenced". Without this flag, both cases returned [] - and
     * a bare [] for a method name like `generateJWT` (methods are never indexed;
     * only top-level declarations are) reads as "no callers, safe to delete".
     */
    symbol_indexed: boolean;
    declarations: SymbolDeclaration[];
    references: SymbolReference[];
    note?: string;
    /**
     * Files that re-export the declaring module wholesale (`export * from './X'`).
     * These never appear in `references`: a star re-export names no identifier, so
     * TypeScript's findReferences has nothing to match on - yet a barrel file is
     * exactly what someone asking "where is this used?" wants to know about, and
     * it is often a symbol's ONLY non-self reference. Omitted when empty.
     */
    re_exported_by?: string[];
}
/** How an ambiguous symbol name was resolved to a file (candidates > 1 = ambiguous). */
export interface SymbolResolution {
    chosen: string;
    candidates: string[];
}
export interface DependencyPath {
    found: boolean;
    chain: string[];
    ambiguity?: {
        symbol_a?: SymbolResolution;
        symbol_b?: SymbolResolution;
    };
    /**
     * Set when both ends resolved but no path exists: how many files the search
     * reached from A (A itself plus everything it transitively imports). A bare
     * found:false saved only ~1.1x on no-path tasks, because agents re-walked the
     * import graph by hand to confirm the negative; this states the search was
     * exhaustive, and how large it was.
     */
    files_searched?: number;
    /** "runtime" when only imports that survive compilation were followed (runtimeOnly). */
    path_type: "runtime" | "runtime_and_type_only";
    /**
     * The import behind each step: hops[i] is chain[i] -> chain[i+1]. Present when the
     * chain has 2+ files. In the default mode each hop says whether it is type_only.
     */
    hops?: CycleHop[];
    /**
     * runtimeOnly queries only, when no runtime path exists: whether one appears once
     * erased imports count. The "no" half of a runtime-vs-type trap.
     */
    type_only_path_exists?: boolean;
    note?: string;
}
/** find_module(name): locate which file(s) define a symbol. */
export declare function findModule(db: Database.Database, name: string): FindModuleResult;
/** find_related_files(file_path): both directions, via the file-level edges table. */
export declare function findRelatedFiles(db: Database.Database, filePath: string): RelatedFiles;
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
export declare function findSymbolReferences(db: Database.Database, symbol: string, declaredIn?: string): SymbolReferencesResult;
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
export declare function dependencyPath(db: Database.Database, a: string, b: string, options?: {
    runtimeOnly?: boolean;
    root?: string;
}): DependencyPath;
export interface CircularDependency {
    /** Every file in the mutually-entangled group, sorted (a strongly connected component). */
    files: string[];
    /** One concrete cycle through that group, e.g. [a, b, c, a] — the first and last entries are the same file. */
    example_cycle: string[];
}
export interface CircularDependencyOptions {
    /**
     * Count `import type` edges, which TypeScript erases at compile time. Default
     * false — a type-only cycle is not a runtime cycle, and including them reported
     * a 227-file "circular dependency" on TypeORM that largely disappears once the
     * erased edges are dropped. Set true to see source-level entanglement instead.
     */
    includeTypeOnly?: boolean;
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
export declare function findCircularDependencies(db: Database.Database, options?: CircularDependencyOptions): CircularDependency[];
export interface CycleGroupSummary {
    size: number;
    /** One shortest cycle through the group, first and last entries the same file. */
    example_cycle: string[];
    /** Every member, sorted - present for small groups, or all groups with includeFiles. */
    files?: string[];
}
export interface CircularDependencyReport {
    cycle_type: "runtime" | "runtime_and_type_only";
    /** Largest group first. Empty = no cycles of this type. */
    groups: CycleGroupSummary[];
    files_in_cycles: number;
    note?: string;
}
export interface CircularDependencyReportOptions extends CircularDependencyOptions {
    /** List members of every group, not just groups of <= INLINE_GROUP_FILES files. */
    includeFiles?: boolean;
    /** Paths under this directory are reported relative to it (the MCP server passes the tsconfig's dir). */
    root?: string;
}
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
export declare function circularDependencyReport(db: Database.Database, options?: CircularDependencyReportOptions): CircularDependencyReport;
export interface CycleThroughFile {
    /** false = the path matched no indexed file (see note). */
    file_indexed: boolean;
    resolved_path: string | null;
    cycle_type: "runtime" | "runtime_and_type_only";
    in_cycle: boolean;
    /** Shortest import loop through the file, starting and ending with it; [] when none. */
    cycle: string[];
    /** Files on the loop (cycle.length - 1), 0 when none. */
    loop_length: number;
    /** The import behind each step of the loop: hops[i] is cycle[i] -> cycle[i+1]. Present when in_cycle. */
    hops?: CycleHop[];
    /** Set when in_cycle is false: files reachable from this one, all checked. */
    files_searched?: number;
    /**
     * Runtime queries only, when no runtime loop exists: whether one appears once
     * erased (type-only) imports count. Separates "genuinely acyclic" from "only a
     * type-level cycle" - the distinction trap tasks turn on.
     */
    type_only_cycle_exists?: boolean;
    note?: string;
}
export interface CycleHop {
    /** "file:line" of the statement that creates this step (file only, for an index built before lines were recorded). */
    at: string;
    /** That statement's text, whitespace-collapsed. */
    statement: string | null;
    /**
     * Names this statement imports that survive compilation - the checker's verdict,
     * which catches what the statement's text can't show: a plain `import { A }`
     * whose A is only ever used as a type is erased. Omitted for statements that
     * name nothing (namespace/default/side-effect imports, `export *`, require).
     */
    runtime_names?: string[];
    /** Only with includeTypeOnly: true when this step exists only through erased imports. */
    type_only?: boolean;
}
/**
 * find_cycle_through_file(file): the shortest import loop that starts and ends at
 * this file (BFS over outgoing edges until one leads back). Any such loop lies
 * inside the file's SCC, so this is exactly "is this file in a cycle, and via
 * which chain" - the question the directus cycle tasks asked, which
 * find_circular_dependencies' one-example-per-group output could not answer.
 */
export declare function findCycleThroughFile(db: Database.Database, filePath: string, options?: {
    includeTypeOnly?: boolean;
    root?: string;
}): CycleThroughFile;
/**
 * The evidence for each step of a loop or path. Benchmark agents given only the file chain
 * grepped every hop (all 50 directus runs did) to confirm it was a real, non-type
 * import; this hands them the statement and the checker's runtime verdict instead.
 * When a pair is joined by several statements, the first runtime one is cited.
 * Also used by rie check (src/check) for the evidence behind each finding.
 */
export declare function cycleHops(db: Database.Database, cycle: string[], includeTypeOnly: boolean, rel: (p: string) => string): CycleHop[];
/**
 * reindex(tsconfigPath): full rebuild of symbols, edges, AND references (plan §7 —
 * the MCP `reindex` tool needs all three, not just the batch pass). v1 is always a
 * full rebuild, not incremental (plan §non-goals: not live/watching) — clearIndex
 * inside indexRepository already empties every table before repopulating them, so
 * re-running against an unchanged repo reproduces the same rows and re-running
 * against a changed repo (file added/removed) reflects that change.
 *
 * Wrapped in a single db.transaction: two separate processes can share one index
 * db (e.g. a CLI reindex and a running MCP server both pointed at the same file),
 * and without this, their clear+repopulate sequences can interleave - each
 * individual .run() is its own implicit transaction otherwise, so a second
 * process's clearIndex() can wipe the table mid-way through the first process's
 * inserts. This was caught for real: a live index ended up with symbols/edges
 * mixing absolute and relative file paths from two overlapping reindex runs.
 * The transaction plus openDb's busy_timeout pragma make the whole operation
 * atomic and serialize concurrent writers instead of corrupting the data.
 */
export interface ReindexResult {
    /** Internal imports the compiler cannot resolve - non-empty means the index is partial. */
    unresolved_internal_imports: UnresolvedImport[];
    /** The tsconfig's own errors (say, an `extends` that isn't installed): its options may be incomplete. */
    config_errors: string[];
}
export declare function reindex(db: Database.Database, tsconfigPath: string): ReindexResult;
