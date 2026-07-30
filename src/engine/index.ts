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
  imports: string[];      // files this file imports
  imported_by: string[];  // files that import this file
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
  const imports = db
    .prepare(`SELECT DISTINCT to_file FROM edges WHERE from_file = ? ORDER BY to_file`)
    .all(filePath)
    .map((r) => (r as { to_file: string }).to_file);
  const importedBy = db
    .prepare(`SELECT DISTINCT from_file FROM edges WHERE to_file = ? ORDER BY from_file`)
    .all(filePath)
    .map((r) => (r as { from_file: string }).from_file);
  return { imports, imported_by: importedBy };
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
  const declSql = `SELECT name, kind, file_path, line_start
         FROM symbols WHERE name = ?${declaredIn ? " AND file_path = ?" : ""}
        ORDER BY file_path`;
  const declStmt = db.prepare(declSql);
  const declarations = (
    declaredIn ? declStmt.all(symbol, declaredIn) : declStmt.all(symbol)
  ) as FindModuleResult[];

  const refSql = `SELECT r.used_in_file, r.line, s.file_path AS declared_in, s.kind
         FROM references_ r
         JOIN symbols s ON s.id = r.symbol_id
        WHERE s.name = ?${declaredIn ? " AND s.file_path = ?" : ""}
        ORDER BY r.used_in_file, r.line`;
  const refStmt = db.prepare(refSql);
  const references = (declaredIn ? refStmt.all(symbol, declaredIn) : refStmt.all(symbol)) as SymbolReference[];

  const result: SymbolReferencesResult = {
    symbol_indexed: declarations.length > 0,
    declarations,
    references,
  };
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
