# Repository Intelligence Engine

A TypeScript repository indexing engine that builds a structural model of a codebase — symbols, imports/exports, and references — and answers precise navigation questions about it directly, instead of re-discovering structure by grepping every session.

## The problem

AI coding agents start every session with zero structural memory of a repo. Answering *"how does login work?"* means an iterative `grep → open → grep → open` cycle, repeated from scratch each time. This engine replaces that with direct queries against a pre-built index.

## What it does

The engine parses a TypeScript repo with the **TypeScript Compiler API** and stores a structural model in **SQLite**. Five queries run over that index:

| Query | Answers |
|---|---|
| `find_module(name)` | Which file(s) define this symbol? |
| `find_related_files(file)` | What does this file import, and what imports it? |
| `find_symbol_references(symbol)` | Everywhere this symbol is used |
| `dependency_path(a, b)` | Is there an import path between two symbols, and what is it? |
| `reindex(path?)` | Rebuild the index |

The `engine/` functions are callable directly (CLI, tests) — the engine is the product. It also supports Claude Code and any other MCP-compatible client through an integrated MCP server.

## Status

Early scaffold. Core is being built in the order in the [project plan](../repository-intelligence-engine-plan.md):
indexer → storage + basic queries → references → `dependency_path`/`reindex` → MCP server → benchmark harness → docs.

## Benchmark

_Before/after table lands here once the harness (step 6) runs against a real repo — median file-reads and tool-calls per task, baseline vs. MCP-assisted._

## Development

```bash
npm install
npm run build           # tsc -> dist/
npm run index -- ./tsconfig.json repo-index.db   # index a repo
npm run mcp             # start the MCP server (stdio)
npm test                # vitest
```
