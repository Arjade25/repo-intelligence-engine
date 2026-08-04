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
| `find_circular_dependencies()` | Which files form import cycles? |
| `reindex(path?)` | Rebuild the index |

The `engine/` functions are callable directly (CLI, tests) — the engine is the product. It also supports Claude Code and any other MCP-compatible client through an integrated MCP server.

## Architecture

```
  Repository (.ts/.tsx)
          │
          ▼
  ┌───────────────────┐   TS Compiler API, two modes:
  │      Indexer      │   • ts.Program        → symbols + import edges (batch)
  │  src/indexer/     │   • ts.LanguageService → findReferences (separate pass)
  └───────────────────┘
          │
          ▼
  ┌───────────────────┐   symbols     (name, kind, file, line)
  │  Index (SQLite)   │   edges       (from_file → to_file, file-level)
  │  src/storage/     │   references_ (symbol → use site)
  └───────────────────┘
          │
          ▼
  ┌───────────────────┐   pure functions over the index —
  │   Query Engine    │   find_module, find_related_files,
  │  src/engine/      │   find_symbol_references, dependency_path, reindex
  └───────────────────┘
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

- **Edges are file-level, not symbol-level.** An import statement lives at file scope — no single symbol "owns" it — and barrel re-exports, side-effect imports (`import './styles'`), and namespace imports have no symbol on one end at all. Storing `from_file → to_file` represents all of them cleanly; `symbols.file_path` bridges back to symbols for free, so `dependency_path` still answers symbol-to-symbol questions by resolving each end to its file and running a BFS over the edge table.
- **The MCP server is an adapter, not the product.** Everything is callable without MCP in the loop, which is what keeps the core testable — a test asserts that an MCP call and the equivalent direct engine call return identical results.

## Benchmark

Measured against [TypeORM](https://github.com/typeorm/typeorm) @ `04ff4dae` — 496 source files, 1,108 indexed symbols, 2,750 import edges. Six fixed navigation tasks with pre-registered oracle answers (verified by independent grep, not engine output), run under two arms with Claude Code in headless mode:

- **baseline** — built-in tools only (Read/Grep/Glob)
- **assisted** — same tools **plus** this engine's MCP server

Protocol: fresh session per run (no cross-run contamination), 5 runs per arm per task, medians reported, metrics machine-counted from session transcripts (`tool_use` blocks), never hand-tallied. Every run in both arms located its oracle answer.

| Task | Baseline (reads / calls) | Assisted (reads / calls) |
|---|---|---|
| Where is class X defined? | 0 / 1 | 0 / 1 |
| Impact: who imports `Driver.ts`? † | 0 / 3 | 0 / **2** |
| Where is interface Y used? | 0 / 1 | 0 / 1 |
| Import path A → B (direct) | 0 / 2 | 0 / **1** |
| Import path A → B (multi-hop) | 0 / 4 | 0 / **2** |
| Define + what does it import? | 0 / 2 | 0 / 2 |
| **Total (median calls)** | **13** | **9** |

**Honest reading:** the engine wins on multi-hop and structural queries (dependency paths halved; impact analysis −1 call) and ties on tasks a good grep already answers in 1–2 calls — a modern agent's baseline is strong, and single-symbol lookups have little headroom. ~30% fewer tool-calls overall.

**† What the benchmark caught:** the first measurement of the impact task showed the assisted arm *losing* (median 5 calls vs. 3, spread up to 11). Transcripts revealed an interface bug, not a data bug: the engine's path-taking tools did exact string matching, so the Windows-style backslash and repo-relative paths agents naturally pass returned empty results — and one tool answered *"symbol not indexed"* when only the path filter had failed. Agents did the rational thing and fell back to grep, doubling the work. After fixing path resolution (normalization + unique-suffix matching + honest "filter dropped" notes), the task flipped to a win and run-to-run variance collapsed from 3–11 calls to 2–3. The raw per-run data for both measurements is in `benchmarks/results/`.

## Circular dependency detection

`find_circular_dependencies()` reports strongly connected components of the import graph (Tarjan's algorithm), each with one concrete example cycle. It reports components rather than enumerating every simple cycle, because a tangled component can contain exponentially many of those — the component is the actionable unit, the example makes it concrete.

On TypeORM it finds 2 groups in ~60 ms: a 2-file cycle (`Brackets.ts` ↔ `WhereExpressionBuilder.ts`) and one 227-file component seeded by `DataSource.ts` ↔ `RelationLoader.ts`. Both were confirmed by reading the imports directly, not taken on the engine's word.

**Known limitation — type-only imports are counted.** v1's `edges` table does not distinguish `import type { X }` from `import { X }`. TypeScript erases type-only imports at compile time, so they create no runtime cycle. Sampling the cycle-forming imports above, 3 of 4 were type-only — meaning the 227-file component substantially overstates what is a *runtime* circular dependency, even though every edge it reports is a real import statement in the source. Distinguishing the two (an `is_type_only` column, set from the AST during indexing) is the obvious next improvement and would make this tool's output directly actionable. Until then, treat the results as "files that reference each other," not "runtime cycles."

## Development

```bash
npm install
npm run build           # tsc -> dist/
npm run index -- ./tsconfig.json repo-index.db   # index a repo
npm run mcp             # start the MCP server (stdio)
npm test                # vitest
```
