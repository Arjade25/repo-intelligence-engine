import type Database from "better-sqlite3";
import type { SymbolRow } from "../storage/db.js";
import { indexRepository, loadTsconfig } from "../indexer/index.js";
import { createLanguageService, indexReferences } from "../indexer/references.js";
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
  resolved_path: string | null; // the canonical stored path actually queried
  imports: string[];      // files this file imports
  imported_by: string[];  // files that import this file
  note?: string;          // set when the path failed to resolve or was ambiguous
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
  note?: string;          // set when symbol_indexed is false: explains what IS indexed
}

export interface SymbolReference {
  used_in_file: string;
  line: number | null;
  declared_in: string;    // file declaring the symbol this reference resolves to
  kind: string;           // that declaration's kind
}

export interface SymbolReferencesResult {
  /**
   * false = the name is not in the index AT ALL, which is very different from
   * "indexed but unreferenced". Without this flag, both cases returned [] - and
   * a bare [] for a method name like `generateJWT` (methods are never indexed;
   * only top-level declarations are) reads as "no callers, safe to delete".
   */
  symbol_indexed: boolean;
  declarations: SymbolDeclaration[]; // every indexed declaration of this name
  references: SymbolReference[];
  note?: string;                    // set when symbol_indexed is false: explains why
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
  chain: string[];        // file path chain from a's file to b's file, [] if none
  // Present only when a symbol name matched declarations in more than one file:
  // discloses every candidate and which one the path actually used, instead of
  // silently tie-breaking (the v1 behavior this replaced).
  ambiguity?: { symbol_a?: SymbolResolution; symbol_b?: SymbolResolution };
  /**
   * Set when both ends resolved but no path exists: how many files the search
   * reached from A (A itself plus everything it transitively imports). A bare
   * found:false saved only ~1.1x on no-path tasks, because agents re-walked the
   * import graph by hand to confirm the negative; this states the search was
   * exhaustive, and how large it was.
   */
  files_searched?: number;
  note?: string;          // why there's no chain: an end matched nothing, or the search came up empty
}

/** find_module(name): locate which file(s) define a symbol. */
export function findModule(db: Database.Database, name: string): FindModuleResult {
  const declarations = db
    .prepare(
      `SELECT name, kind, file_path, line_start
         FROM symbols WHERE name = ? ORDER BY file_path`
    )
    .all(name) as SymbolDeclaration[];
  if (declarations.length > 0) return { symbol_indexed: true, declarations };

  // Names are matched exactly (case-sensitive, like the language), so the likeliest
  // near miss is a casing slip - `userService` for `UserService`.
  const similar = (
    db
      .prepare(`SELECT DISTINCT name FROM symbols WHERE name = ? COLLATE NOCASE ORDER BY name LIMIT 10`)
      .all(name) as { name: string }[]
  ).map((r) => r.name);

  return {
    symbol_indexed: false,
    declarations: [],
    ...(similar.length > 0 && { similar_names: similar }),
    note:
      `No top-level declaration named "${name}" is indexed. Only top-level class/function/` +
      `interface/type/const/enum declarations are - methods, properties, enum members, namespaces, ` +
      `non-const variables and locals are not, so this does NOT mean the name is absent from the repo.`,
  };
}

/** find_related_files(file_path): both directions, via the file-level edges table. */
export function findRelatedFiles(db: Database.Database, filePath: string): RelatedFiles {
  const { resolved, candidates } = resolveIndexedPath(db, filePath);
  if (!resolved) {
    return {
      file_indexed: false,
      resolved_path: null,
      imports: [],
      imported_by: [],
      note:
        candidates.length > 1
          ? `"${filePath}" matches ${candidates.length} indexed files - give a longer path. Candidates: ${candidates.join(", ")}`
          : `"${filePath}" is not in the index (not a .ts/.tsx file under the indexed tsconfig, or the index is stale - try reindex).`,
    };
  }

  const imports = db
    .prepare(`SELECT DISTINCT to_file FROM edges WHERE from_file = ? ORDER BY to_file`)
    .all(resolved)
    .map((r) => (r as { to_file: string }).to_file);
  const importedBy = db
    .prepare(`SELECT DISTINCT from_file FROM edges WHERE to_file = ? ORDER BY from_file`)
    .all(resolved)
    .map((r) => (r as { from_file: string }).from_file);
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
function resolveIndexedPath(
  db: Database.Database,
  givenPath: string
): { resolved: string | null; candidates: string[] } {
  const normalized = givenPath.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();

  const allFiles = (
    db
      .prepare(
        `SELECT file_path AS f FROM symbols
         UNION SELECT from_file FROM edges
         UNION SELECT to_file FROM edges`
      )
      .all() as { f: string }[]
  ).map((r) => r.f);

  const exact = allFiles.filter((f) => f.toLowerCase() === lower);
  if (exact.length === 1) return { resolved: exact[0], candidates: exact };

  const bySuffix = allFiles.filter((f) => f.toLowerCase().endsWith(`/${lower}`)).sort();
  if (bySuffix.length === 1) return { resolved: bySuffix[0], candidates: bySuffix };

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
export function findSymbolReferences(
  db: Database.Database,
  symbol: string,
  declaredIn?: string
): SymbolReferencesResult {
  const queryBoth = (path?: string) => {
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
        : db.prepare(declSql).all(symbol)) as SymbolDeclaration[],
      references: (path
        ? db.prepare(refSql).all(symbol, path)
        : db.prepare(refSql).all(symbol)) as SymbolReference[],
    };
  };

  // Resolve the path filter to the index's canonical form before comparing: a
  // backslash or repo-relative declaredIn used to fail string equality and made
  // this function claim the symbol wasn't indexed at all (see resolveIndexedPath).
  // An unresolvable filter is dropped (with a note), never silently applied.
  let note: string | undefined;
  let filterPath: string | undefined;
  if (declaredIn !== undefined) {
    const { resolved, candidates } = resolveIndexedPath(db, declaredIn);
    if (resolved) {
      filterPath = resolved;
    } else {
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

  const result: SymbolReferencesResult = {
    symbol_indexed: declarations.length > 0,
    declarations,
    references,
  };

  const declFiles = [...new Set(declarations.map((d) => d.file_path))];
  if (declFiles.length > 0) {
    const placeholders = declFiles.map(() => "?").join(", ");
    const reExporters = db
      .prepare(
        `SELECT DISTINCT from_file FROM edges
          WHERE edge_type = 'reexport_star' AND to_file IN (${placeholders})
          ORDER BY from_file`
      )
      .all(...declFiles) as { from_file: string }[];
    if (reExporters.length > 0) result.re_exported_by = reExporters.map((r) => r.from_file);
  }

  if (note !== undefined) result.note = note;
  if (!result.symbol_indexed) {
    result.note =
      `"${symbol}" is not in the index. Only top-level declarations (class/function/` +
      `interface/type/const/enum) are indexed - methods, properties, enum members, and locals are not. ` +
      `An empty reference list here does NOT mean the name is unused.`;
  }
  return result;
}

/** A path-looking argument (has a separator or a source-file extension) names a file, anything else a symbol. */
function looksLikeFilePath(arg: string): boolean {
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
 */
export function dependencyPath(db: Database.Database, a: string, b: string): DependencyPath {
  const notes: string[] = [];
  const endpoint = (arg: string): string[] => {
    if (!looksLikeFilePath(arg)) {
      const files = filesOfSymbol(db, arg);
      if (files.length === 0) {
        notes.push(
          `"${arg}" is not an indexed symbol (only top-level class/function/interface/type/const/enum ` +
            `declarations are), so no path was searched. Pass a file path instead.`
        );
      }
      return files;
    }
    const { resolved, candidates } = resolveIndexedPath(db, arg);
    if (resolved) return [resolved];
    notes.push(
      candidates.length > 1
        ? `"${arg}" matches ${candidates.length} indexed files - pass a longer path: ${candidates.join(", ")}`
        : `"${arg}" is not an indexed file.`
    );
    return [];
  };
  const candidatesA = endpoint(a);
  const candidatesB = endpoint(b);
  const fileA = candidatesA[0];
  const fileB = candidatesB[0];

  // Disclose multi-declaration names instead of silently tie-breaking. The chosen
  // file is the alphabetically first candidate - deterministic, unlike the
  // unordered LIMIT 1 this replaced, which picked by insertion order.
  const ambiguity: DependencyPath["ambiguity"] = {};
  if (candidatesA.length > 1) ambiguity.symbol_a = { chosen: fileA, candidates: candidatesA };
  if (candidatesB.length > 1) ambiguity.symbol_b = { chosen: fileB, candidates: candidatesB };
  const withAmbiguity = (result: DependencyPath): DependencyPath => ({
    ...result,
    ...((ambiguity.symbol_a || ambiguity.symbol_b) && { ambiguity }),
    ...(notes.length > 0 && { note: notes.join(" ") }),
  });

  if (!fileA || !fileB) return withAmbiguity({ found: false, chain: [] });
  if (fileA === fileB) return withAmbiguity({ found: true, chain: [fileA] });

  const neighborsOf = db.prepare(`SELECT DISTINCT to_file FROM edges WHERE from_file = ?`);

  const parent = new Map<string, string>();
  const visited = new Set<string>([fileA]);
  const queue: string[] = [fileA];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = neighborsOf.all(current) as { to_file: string }[];
    for (const { to_file } of neighbors) {
      if (visited.has(to_file)) continue;
      visited.add(to_file);
      parent.set(to_file, current);

      if (to_file === fileB) {
        const chain = [fileB];
        let node = fileB;
        while (node !== fileA) {
          node = parent.get(node)!;
          chain.unshift(node);
        }
        return withAmbiguity({ found: true, chain });
      }
      queue.push(to_file);
    }
  }

  return withAmbiguity({
    found: false,
    chain: [],
    files_searched: visited.size,
    note:
      `No import path from ${fileA} to ${fileB}. The search was exhaustive: it followed every ` +
      `static import and re-export (type-only included) from ${fileA} and reached ${visited.size} ` +
      `file(s), none of which is ${fileB}. Reading files will not find a path this missed - only a ` +
      `dynamic import() or a require() inside a function would, and neither is an import edge.`,
  });
}

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
export function findCircularDependencies(
  db: Database.Database,
  options: CircularDependencyOptions = {}
): CircularDependency[] {
  // DISTINCT is applied after filtering, so a file pair joined by both a type-only
  // and a value import correctly survives as a runtime edge.
  const sql = options.includeTypeOnly
    ? `SELECT DISTINCT from_file, to_file FROM edges`
    : `SELECT DISTINCT from_file, to_file FROM edges WHERE is_type_only = 0`;
  const edges = db.prepare(sql).all() as {
    from_file: string;
    to_file: string;
  }[];

  const adjacency = new Map<string, string[]>();
  const selfImports = new Set<string>();
  for (const { from_file, to_file } of edges) {
    if (!adjacency.has(from_file)) adjacency.set(from_file, []);
    adjacency.get(from_file)!.push(to_file);
    if (!adjacency.has(to_file)) adjacency.set(to_file, []);
    if (from_file === to_file) selfImports.add(from_file);
  }

  let counter = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const strongConnect = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!index.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  };

  for (const file of adjacency.keys()) {
    if (!index.has(file)) strongConnect(file);
  }

  const cycles: CircularDependency[] = [];
  for (const component of components) {
    const isCycle = component.length > 1 || selfImports.has(component[0]);
    if (!isCycle) continue;
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
export function circularDependencyReport(
  db: Database.Database,
  options: CircularDependencyReportOptions = {}
): CircularDependencyReport {
  const rel = relativizer(options.root);
  const cycles = findCircularDependencies(db, options);
  const groups = cycles.map((c): CycleGroupSummary => ({
    size: c.files.length,
    example_cycle: c.example_cycle.map(rel),
    ...((options.includeFiles || c.files.length <= INLINE_GROUP_FILES) && { files: c.files.map(rel) }),
  }));
  const report: CircularDependencyReport = {
    cycle_type: options.includeTypeOnly ? "runtime_and_type_only" : "runtime",
    groups,
    files_in_cycles: groups.reduce((n, g) => n + g.size, 0),
  };
  const notes: string[] = [];
  if (groups.some((g) => !g.files)) {
    notes.push(`Member lists are omitted for groups over ${INLINE_GROUP_FILES} files (pass include_files to list them).`);
  }
  if (groups.length > 0) {
    notes.push(
      "example_cycle is one loop per group, not a loop through any particular file - " +
        "for a specific file, call find_cycle_through_file: it returns the shortest loop through that file, or proves there is none."
    );
  }
  if (notes.length > 0) report.note = notes.join(" ");
  return report;
}

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
export function findCycleThroughFile(
  db: Database.Database,
  filePath: string,
  options: { includeTypeOnly?: boolean; root?: string } = {}
): CycleThroughFile {
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
      note:
        candidates.length > 1
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

  const result: CycleThroughFile = {
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
 * The evidence for each step of a loop. Benchmark agents given only the file chain
 * grepped every hop (all 50 directus runs did) to confirm it was a real, non-type
 * import; this hands them the statement and the checker's runtime verdict instead.
 * When a pair is joined by several statements, the first runtime one is cited.
 */
function cycleHops(
  db: Database.Database,
  cycle: string[],
  includeTypeOnly: boolean,
  rel: (p: string) => string
): CycleHop[] {
  const rowsOf = db.prepare(
    `SELECT line, statement, is_type_only, imported_name AS name
       FROM edges
      WHERE from_file = ? AND to_file = ?${includeTypeOnly ? "" : " AND is_type_only = 0"}
      ORDER BY is_type_only, line`
  );
  const hops: CycleHop[] = [];
  for (let i = 0; i + 1 < cycle.length; i++) {
    const rows = rowsOf.all(cycle[i], cycle[i + 1]) as {
      line: number | null;
      statement: string | null;
      is_type_only: number;
      name: string | null;
    }[];
    const first = rows[0];
    const sameStatement = rows.filter((r) => r.line === first.line);
    const names = [
      ...new Set(sameStatement.filter((r) => !r.is_type_only && r.name !== null).map((r) => r.name!)),
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
function shortestLoopFrom(
  db: Database.Database,
  start: string,
  includeTypeOnly: boolean
): { cycle: string[] | null; searched: number } {
  const neighborsOf = db.prepare(
    includeTypeOnly
      ? `SELECT DISTINCT to_file FROM edges WHERE from_file = ?`
      : `SELECT DISTINCT to_file FROM edges WHERE from_file = ? AND is_type_only = 0`
  );
  const parent = new Map<string, string>();
  const visited = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const { to_file } of neighborsOf.all(current) as { to_file: string }[]) {
      if (to_file === start) {
        const cycle = [current];
        let node = current;
        while (node !== start) {
          node = parent.get(node)!;
          cycle.unshift(node);
        }
        return { cycle: [...cycle, start], searched: visited.size };
      }
      if (visited.has(to_file)) continue;
      visited.add(to_file);
      parent.set(to_file, current);
      queue.push(to_file);
    }
  }
  return { cycle: null, searched: visited.size };
}

/** Path -> path relative to root when it lies under root (case-insensitive, like resolveIndexedPath); identity without a root. */
function relativizer(root: string | undefined): (path: string) => string {
  if (!root) return (p) => p;
  const prefix = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  const lowerPrefix = prefix.toLowerCase();
  return (p) => (p.toLowerCase().startsWith(lowerPrefix) ? p.slice(prefix.length) : p);
}

/** BFS a shortest path from `start` back to itself, never leaving the component. */
function shortestCycleThrough(
  start: string,
  members: Set<string>,
  adjacency: Map<string, string[]>
): string[] {
  const parent = new Map<string, string>();
  const queue: string[] = [start];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (!members.has(next)) continue;
      if (next === start) {
        const cycle = [current];
        let node = current;
        while (node !== start) {
          node = parent.get(node)!;
          cycle.unshift(node);
        }
        return [...cycle, start];
      }
      if (seen.has(next)) continue;
      seen.add(next);
      parent.set(next, current);
      queue.push(next);
    }
  }
  return [start, start]; // only reachable for a self-import
}

/** Every file declaring a symbol of this name, alphabetically (deterministic). */
function filesOfSymbol(db: Database.Database, name: string): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT file_path FROM symbols WHERE name = ? ORDER BY file_path`)
    .all(name) as Pick<SymbolRow, "file_path">[];
  return rows.map((r) => r.file_path);
}

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
}

export function reindex(db: Database.Database, tsconfigPath: string): ReindexResult {
  const run = db.transaction(() => {
    const { unresolved } = indexRepository(db, tsconfigPath);
    const { fileNames, options } = loadTsconfig(tsconfigPath);
    const service = createLanguageService(fileNames, options);
    indexReferences(db, service);
    return { unresolved_internal_imports: unresolved };
  });
  return run();
}
