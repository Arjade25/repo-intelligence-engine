import type Database from "better-sqlite3";
import type { SymbolRow } from "../storage/db.js";
import { indexRepository, loadTsconfig } from "../indexer/index.js";
import { createLanguageService, indexReferences } from "../indexer/references.js";

/**
 * Query engine (plan §5): pure functions over the SQLite index. This is the
 * product. The MCP server is a thin adapter over these — step 5's Done-when is
 * that an MCP call and the matching call here return identical results, so keep
 * ALL logic in this file, none in mcp-server/.
 */

export interface FindModuleResult {
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
  declarations: FindModuleResult[]; // every indexed declaration of this name
  references: SymbolReference[];
  note?: string;                    // set when symbol_indexed is false: explains why
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
}

/** find_module(name): locate which file(s) define a symbol. */
export function findModule(db: Database.Database, name: string): FindModuleResult[] {
  return db
    .prepare(
      `SELECT name, kind, file_path, line_start
         FROM symbols WHERE name = ? ORDER BY file_path`
    )
    .all(name) as FindModuleResult[];
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
        : db.prepare(declSql).all(symbol)) as FindModuleResult[],
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
  if (note !== undefined) result.note = note;
  if (!result.symbol_indexed) {
    result.note =
      `"${symbol}" is not in the index. Only top-level declarations (class/function/` +
      `interface/type/const) are indexed - methods, properties, and locals are not. ` +
      `An empty reference list here does NOT mean the name is unused.`;
  }
  return result;
}

/**
 * dependency_path(a, b): resolve each symbol to its file, then BFS the file-level
 * edges (plan §7 — the one tool with real traversal, directed by `from_file ->
 * to_file`). Returns the shortest file chain, or found:false if no directed path
 * exists (imports are one-way, so a->b connected does not imply b->a connected).
 */
export function dependencyPath(db: Database.Database, symbolA: string, symbolB: string): DependencyPath {
  const candidatesA = filesOfSymbol(db, symbolA);
  const candidatesB = filesOfSymbol(db, symbolB);
  const fileA = candidatesA[0];
  const fileB = candidatesB[0];

  // Disclose multi-declaration names instead of silently tie-breaking. The chosen
  // file is the alphabetically first candidate - deterministic, unlike the
  // unordered LIMIT 1 this replaced, which picked by insertion order.
  const ambiguity: DependencyPath["ambiguity"] = {};
  if (candidatesA.length > 1) ambiguity.symbol_a = { chosen: fileA, candidates: candidatesA };
  if (candidatesB.length > 1) ambiguity.symbol_b = { chosen: fileB, candidates: candidatesB };
  const withAmbiguity = (result: DependencyPath): DependencyPath =>
    ambiguity.symbol_a || ambiguity.symbol_b ? { ...result, ambiguity } : result;

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

  return withAmbiguity({ found: false, chain: [] });
}

export interface CircularDependency {
  /** Every file in the mutually-entangled group, sorted (a strongly connected component). */
  files: string[];
  /** One concrete cycle through that group, e.g. [a, b, c, a] — the first and last entries are the same file. */
  example_cycle: string[];
}

/**
 * find_circular_dependencies(): every import cycle in the repo (plan §9 stretch 1).
 *
 * Reports strongly connected components rather than enumerating every simple
 * cycle: a tangled component can contain exponentially many simple cycles, so
 * listing them all is neither computable nor useful. Each SCC of 2+ files is one
 * genuine circular-dependency group, plus self-imports (a 1-file SCC with an edge
 * to itself). Each group carries one concrete example cycle so the result is
 * actionable rather than just a set membership claim.
 *
 * Groups are ordered largest first — the biggest tangle is usually the one worth
 * breaking. Uses Tarjan's algorithm over the file-level edges. Recursion depth is
 * bounded by the longest import chain (tens, in real codebases), not file count.
 */
export function findCircularDependencies(db: Database.Database): CircularDependency[] {
  const edges = db.prepare(`SELECT DISTINCT from_file, to_file FROM edges`).all() as {
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
export function reindex(db: Database.Database, tsconfigPath: string): void {
  const run = db.transaction(() => {
    indexRepository(db, tsconfigPath);
    const { fileNames, options } = loadTsconfig(tsconfigPath);
    const service = createLanguageService(fileNames, options);
    indexReferences(db, service);
  });
  run();
}
