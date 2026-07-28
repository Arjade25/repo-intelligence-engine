import type Database from "better-sqlite3";
import type { SymbolRow } from "../storage/db.js";

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
}

export interface DependencyPath {
  found: boolean;
  chain: string[];        // file path chain from a's file to b's file, [] if none
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

/** find_symbol_references(symbol): everywhere a symbol is used (from references_). */
export function findSymbolReferences(db: Database.Database, symbol: string): SymbolReference[] {
  return db
    .prepare(
      `SELECT r.used_in_file, r.line
         FROM references_ r
         JOIN symbols s ON s.id = r.symbol_id
        WHERE s.name = ?
        ORDER BY r.used_in_file, r.line`
    )
    .all(symbol) as SymbolReference[];
}

/**
 * dependency_path(a, b): resolve each symbol to its file, then BFS the file-level
 * edges (plan §7 — the one tool with real traversal). Returns the file chain.
 * TODO(step 4): implement the BFS; the resolve-to-file lookups are below.
 */
export function dependencyPath(db: Database.Database, symbolA: string, symbolB: string): DependencyPath {
  const fileA = fileOfSymbol(db, symbolA);
  const fileB = fileOfSymbol(db, symbolB);
  if (!fileA || !fileB) return { found: false, chain: [] };
  // TODO: BFS from fileA to fileB over edges(from_file -> to_file); return the path.
  return { found: false, chain: [] };
}

function fileOfSymbol(db: Database.Database, name: string): string | null {
  const row = db.prepare(`SELECT file_path FROM symbols WHERE name = ? LIMIT 1`).get(name) as
    | Pick<SymbolRow, "file_path">
    | undefined;
  return row?.file_path ?? null;
}
