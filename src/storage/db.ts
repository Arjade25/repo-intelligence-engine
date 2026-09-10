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
  /** 1 for type-only imports/re-exports, which TypeScript erases at compile time. */
  is_type_only: number;
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
  migrate(db);
  return db;
}

/**
 * Bring an index file created by an older build up to the current schema.
 *
 * `CREATE TABLE IF NOT EXISTS` silently leaves an existing table's columns alone,
 * so a pre-existing repo-index.db would otherwise fail every query mentioning a
 * newly added column. Migrations here must be additive and idempotent.
 *
 * NOTE: adding a column backfills the SQL default, not real data — an index built
 * before `is_type_only` existed reports every edge as a value import until it is
 * rebuilt. The index is a derived artifact (a full reindex of a 496-file repo
 * takes ~20s), so `reindex` is the intended fix rather than a data migration.
 */
function migrate(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(edges)`).all() as { name: string }[];
  if (!columns.some((c) => c.name === "is_type_only")) {
    db.exec(`ALTER TABLE edges ADD COLUMN is_type_only INTEGER NOT NULL DEFAULT 0`);
  }
}

/**
 * Drop all indexed data (used by reindex() for a full rebuild).
 * Keeps the schema; just clears rows.
 */
export function clearIndex(db: Database.Database): void {
  db.exec("DELETE FROM references_; DELETE FROM edges; DELETE FROM symbols;");
}
