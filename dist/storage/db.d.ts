import Database from "better-sqlite3";
/** Row shapes mirror schema.sql. Kept here so engine/ can type its queries. */
export interface SymbolRow {
    id: number;
    name: string;
    kind: "class" | "function" | "interface" | "type" | "const" | "enum";
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
    /** 1-based line of the statement in from_file; null in indexes built before it existed. */
    line: number | null;
    /** The statement's text, whitespace-collapsed and truncated; null likewise. */
    statement: string | null;
    /** The imported/re-exported name, even when to_symbol_id is NULL; null for edges that name nothing. */
    imported_name: string | null;
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
export declare function openDb(path?: string): Database.Database;
/**
 * Drop all indexed data (used by reindex() for a full rebuild).
 * Keeps the schema; just clears rows.
 */
export declare function clearIndex(db: Database.Database): void;
