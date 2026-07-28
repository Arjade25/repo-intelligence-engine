-- Repository Intelligence Engine — SQLite schema
-- See plan §6. This file is the single source of truth for the data model;
-- storage/db.ts applies it on init.

-- One row per exported/top-level symbol.
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,        -- 'class' | 'function' | 'interface' | 'type' | 'const'
  file_path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER
);

-- Import/export relationships. FILE-LEVEL (plan §6/A): an import's source side is
-- a module, not a symbol (import statements live at file scope), so edges connect
-- file paths. This cleanly represents barrel re-exports, side-effect imports
-- (`import './styles'`), and namespace imports (`import * as ns`) — all of which
-- have no symbol on one end. `to_symbol_id` is an optional refinement: populated
-- for named imports (`import { Foo }`), NULL otherwise. Symbol->file mapping for
-- the other end comes for free from symbols.file_path, so all five v1 tools
-- (including dependency_path, via file-level BFS) work without symbol-level edges.
--
-- NOTE (plan §12): to_file must be a RESOLVED absolute path. The indexer runs TS
-- module resolution at index time to turn './foo' / '@app/foo' into a path before
-- writing the edge. Wrong resolution => wrong edges.
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY,
  from_file TEXT NOT NULL,                       -- the importing module
  to_file TEXT NOT NULL,                         -- the imported module (resolved)
  to_symbol_id INTEGER REFERENCES symbols(id),   -- nullable: the specific named import, if any
  edge_type TEXT NOT NULL                         -- 'imports' for v1; extensible later
);

-- Where a symbol is used (from the LanguageService's findReferences — plan §4).
-- Table name has a trailing underscore because REFERENCES is a SQL reserved word;
-- `references_` sidesteps it. Deliberate, not a typo.
CREATE TABLE IF NOT EXISTS references_ (
  id INTEGER PRIMARY KEY,
  symbol_id INTEGER REFERENCES symbols(id),
  used_in_file TEXT NOT NULL,
  line INTEGER
);

-- Indexes for the hot lookups (find_module by name, edge traversal by either end).
CREATE INDEX IF NOT EXISTS idx_symbols_name    ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file    ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_edges_from      ON edges(from_file);
CREATE INDEX IF NOT EXISTS idx_edges_to        ON edges(to_file);
CREATE INDEX IF NOT EXISTS idx_refs_symbol     ON references_(symbol_id);
