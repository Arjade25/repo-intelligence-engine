# The engine and its MCP server

[← RIE Check README](../README.md)

RIE began as this engine: an index that answers structural questions for AI coding agents. `rie check` is built on it. The MCP server runs as `rie mcp` (or `rie-mcp`), with `RIE_DB` and `RIE_TSCONFIG` setting the index file and the tsconfig. Diagrams: [`architecture/`](architecture/).

A TypeScript repository indexing engine that builds a structural model of a codebase — symbols, imports/exports, and references — and answers precise navigation questions about it directly, instead of re-discovering structure by grepping every session.

## The problem

AI coding agents start every session with zero structural memory of a repo. Answering *"how does login work?"* means an iterative `grep → open → grep → open` cycle, repeated from scratch each time. This engine replaces that with direct queries against a pre-built index.

## What it does

The engine parses a TypeScript repo with the **TypeScript Compiler API** and stores a structural model in **SQLite**. Six queries, plus a full rebuild, run over that index:

| Query | Answers |
|---|---|
| `find_module(name)` | Which file(s) define this symbol? |
| `find_related_files(file)` | What does this file import, and what imports it? |
| `find_symbol_references(symbol)` | Everywhere this symbol is used |
| `dependency_path(a, b)` | Is there an import path from A to B, and what is it? Each end can be a symbol name or a file path. Each hop cites its import line and says whether it is type-only; pass `runtime_only` to follow only imports that survive compilation |
| `find_circular_dependencies()` | Which files form runtime import cycles? Compact: group sizes + one example each (pass `include_files` for full member lists, `include_type_only` to count erased imports too) |
| `find_cycle_through_file(file)` | Is this file in a runtime cycle, and what is the shortest loop through it? Exhaustive when the answer is no |
| `reindex()` | Rebuild the whole index, and report any internal imports that failed to resolve |

The `engine/` functions are callable directly (CLI, tests) — the engine is the product. It also supports Claude Code and any other MCP-compatible client through an integrated MCP server.

Every path-taking query accepts absolute or repo-relative paths, with either slash style, matched case-insensitively. When a path or name matches nothing, every query says so explicitly (`file_indexed: false`, `symbol_indexed: false`, or a `note`) rather than returning a bare empty list. Agents treat an empty list as "no results" and fall back to grep, which the benchmark caught happening (see † below). `find_module` was the last to return a bare `[]`; on a miss it now also lists `similar_names` that match ignoring case. When `dependency_path` finds no path, it says how many files the search reached (`files_searched`) and that the search was exhaustive. The MCP `reindex` tool takes no arguments: every rebuild covers the whole repo.

A symbol is a top-level `class`, `function`, `interface`, `type`, `const` or `enum` declaration. Methods, properties, enum members, namespaces, non-`const` variables and locals are not indexed, and a miss on one of those says so rather than implying the name is unused. Enums were added late. Before that, `find_symbol_references("HttpStatus")` on nest answered "not in the index", which reads as unused; it now returns 141 references across 38 files. A `const enum` is indexed the same way: its members are inlined at emit, but every use is still a reference the type checker resolves.

## Architecture

```
  Repository (.ts/.tsx)
          │
          ▼
  ┌───────────────────┐   TS Compiler API, two modes:
  │      Indexer      │   • ts.Program        → symbols + import edges (batch)
  │  src/indexer/     │   • ts.LanguageService → findReferences (separate pass)
  └───────────────────┘   plus erasure.ts (is this import erased at emit?)
          │               and resolution.ts (which internal imports don't resolve?)
          ▼
  ┌───────────────────┐   symbols     (name, kind, file, line)
  │  Index (SQLite)   │   edges       (from_file → to_file, file-level,
  │  src/storage/     │                is_type_only, imports | reexport_star)
  └───────────────────┘   references_ (symbol → use site)
          │
          ▼
  ┌───────────────────┐   pure functions over the index —
  │   Query Engine    │   find_module, find_related_files,
  │  src/engine/      │   find_symbol_references, dependency_path,
  └───────────────────┘   find_circular_dependencies,
                          find_cycle_through_file, reindex
          │
          ▼
  ┌───────────────────┐   thin adapter: parse args → call engine.
  │    MCP Server     │   No query logic lives here.
  │  src/mcp-server/  │
  └───────────────────┘
          │
          ▼
  Claude Code / any MCP-compatible client
```

Two design decisions worth calling out:

- **Edges are file-level, not symbol-level.** An import statement lives at file scope — no single symbol "owns" it — and barrel re-exports, side-effect imports (`import './styles'`), and namespace imports have no symbol on one end at all. Storing `from_file → to_file` represents all of them cleanly. `symbols.file_path` bridges back to symbols for free, so `dependency_path` resolves each end to a file and runs a BFS over the edge table. An end can be a symbol name or a file path; an argument with a slash or a source-file extension is treated as a path. File ends make a barrel like `index.ts`, which declares no symbol of its own, a valid endpoint. The BFS follows every edge, type-only ones included, because the question is about imports, not runtime.
- **The MCP server is an adapter, not the product.** Everything is callable without MCP in the loop, which is what keeps the core testable — a test asserts that an MCP call and the equivalent direct engine call return identical results.
