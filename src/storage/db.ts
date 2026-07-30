import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Row shapes mirror schema.sql. Kept here so engine/ can type its queries. */
export interface SymbolRow {
  id: number;
  name: string;
  kind: "class" | "function" | "interface" | "type" | "const";
  file_path: string;
  line_start: number | null;
  line_end: number | null;
}

export interface EdgeRow {
  id: number;
  from_file: string;
  to_file: string;
  to_symbol_id: number | null;
  edge_type: string;
}

export interface ReferenceRow {
  id: number;
  symbol_id: number;
  used_in_file: string;
  line: number | null;
}

/**
 * Open (or create) the index database and ensure the schema is applied.
 * Pass ":memory:" for tests. The schema is idempotent (CREATE IF NOT EXISTS).
 */
export function openDb(path = "repo-index.db"): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  // Wait for a competing writer's lock instead of failing (or, worse, letting
  // interleaved multi-process writes corrupt a shared index file - see the
  // transaction note on engine/reindex).
  db.pragma("busy_timeout = 30000");
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  return db;
}

/**
 * Drop all indexed data (used by reindex() for a full rebuild).
 * Keeps the schema; just clears rows.
 */
export function clearIndex(db: Database.Database): void {
  db.exec("DELETE FROM references_; DELETE FROM edges; DELETE FROM symbols;");
}
