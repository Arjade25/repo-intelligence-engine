# Repository Intelligence Engine

A TypeScript repository indexing engine that builds a structural model of a codebase — symbols, imports/exports, and references — and answers precise navigation questions about it directly, instead of re-discovering structure by grepping every session.

## The problem

AI coding agents start every session with zero structural memory of a repo. Answering *"how does login work?"* means an iterative `grep → open → grep → open` cycle, repeated from scratch each time. This engine replaces that with direct queries against a pre-built index.

## What it does

The engine parses a TypeScript repo with the **TypeScript Compiler API** and stores a structural model in **SQLite**. Six queries run over that index:

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

Measured against [TypeORM](https://github.com/typeorm/typeorm) @ `04ff4dae` — 496 source files, 1,108 indexed symbols, 2,750 import edges. Nine fixed navigation tasks with pre-registered oracle answers (verified by independent grep, not engine output), run under two arms with Claude Code in headless mode:

- **baseline** — built-in tools only (Read/Grep/Glob)
- **assisted** — same tools **plus** this engine's MCP server

Protocol: fresh session per run (no cross-run contamination), 5 runs per arm per task, medians reported, metrics machine-counted from session transcripts (`tool_use` blocks and per-turn token usage), never hand-tallied. The only difference between arms is `--mcp-config`; both receive the same built-in toolset.

### Where the engine does *not* help

The original six tasks are ones a competent agent already answers in one or two well-chosen greps:

| Task | Baseline calls | Assisted calls |
|---|---|---|
| Where is class X defined? | 1 | 1 |
| Impact: who imports `Driver.ts`? † | 3 | **2** |
| Where is interface Y used? | 1 | 1 |
| Import path A → B (direct) | 2 | **1** |
| Import path A → B (2 hops) | 4 | **2** |
| Define + what does it import? | 2 | 2 |
| **Total (median calls)** | **13** | **9** |

~30% fewer calls, concentrated entirely in the path tasks. Every run in both arms located its oracle answer. A modern agent's grep baseline is strong, and single-symbol lookups have no headroom to win.

### Where it does

Three later tasks target question shapes text search should struggle with: a deep transitive path, a whole-graph property, and a name grep massively over-counts. Only the first two held up — the third is kept as a negative result (‡):

| Task | Baseline (calls / tokens) | Assisted (calls / tokens) |
|---|---|---|
| Reference count on a heavily over-grepped name ‡ | 6 / 190,226 | 5 / 174,330 |
| Import path A → B (**7 hops**) | 21 / 607,413 | **1 / 40,719** |
| Are there any runtime import cycles? | 22 / 1,242,140 | **1 / 26,661** |

The two traversal tasks cost ~15x and ~46x fewer tokens. The assisted arm answered both in exactly one tool call on all ten runs — a deterministic single query, not a favourable average; four of the five path runs landed within 15 tokens of each other.

The cycle task is the sharpest case, because the *quality* of the answer differs, not just its cost. The baseline reached the right conclusion — "no runtime cycles" — but hedged it explicitly as *"based on my sampling"*, after inspecting roughly 25 of 496 files across 22 tool calls and 1.2M tokens. Reading files cannot prove a negative about a graph. `find_circular_dependencies()` returns a deterministic Tarjan result over all 2,750 edges. Both answers agree; only one of them is verified.

**Overall reading:** this is not "faster than grep." It is roughly a wash on questions grep already handles well, and a large, repeatable win on multi-hop and whole-graph questions — the two things text search structurally cannot do. Baseline cost varies widely run to run (15–24 calls on the path task, 14–29 on the cycle task), so these ratios are measured medians, not guarantees.

**Metric caveat:** the harness also records `located_oracle`, a substring check for an oracle filename in the final answer. It is a smoke detector, not a grader. It reads `false` for a perfectly correct answer that never restates the filename — which happens when the prompt itself already names the file — and for correct answers to questions whose oracle names no file at all, like the cycle task. Treat calls and tokens as the measurements; read transcripts to judge correctness.

**† What the benchmark caught:** the first measurement of the impact task showed the assisted arm *losing* (median 5 calls vs. 3, spread up to 11). Transcripts revealed an interface bug, not a data bug: the engine's path-taking tools did exact string matching, so the Windows-style backslash and repo-relative paths agents naturally pass returned empty results — and one tool answered *"symbol not indexed"* when only the path filter had failed. Agents did the rational thing and fell back to grep, doubling the work. After fixing path resolution (normalization + unique-suffix matching + honest "filter dropped" notes), the task flipped to a win and run-to-run variance collapsed from 3–11 calls to 2–3. The raw per-run data for both measurements is in `benchmarks/results/`.

**‡ A task that failed, kept deliberately.** The reference-count task was designed as a trap: `grep -w Entity` returns 684 hits across 72 files — ~114x the 6 real references — because `Entity` is TypeORM's ubiquitous generic type-parameter name (`Repository<Entity>`, `QueryBuilder<Entity>`). Neither arm fell for it. Both immediately grepped `Entity\(` with the paren, which is highly discriminating for a callable, and collapsed 684 hits to ~7 files in a single call. The task is retained as a negative result, because it marks the boundary of the claim above: name-overcount is only grep-hostile for symbols used in *type position*, where a usage is a bare name indistinguishable from a type parameter. For functions and decorators, `Name(` and `@Name` hand grep a precise handle. An earlier N=1 measurement of this task showed the assisted arm losing badly (18 calls vs 13); at N=5 that reversed to a slight win. Both readings were mostly noise — the baseline arm alone moved from 13 calls to a median of 6 between runs, and the baseline never touches the MCP server.

## Circular dependency detection

`find_circular_dependencies()` reports strongly connected components of the import graph (Tarjan's algorithm), each with one concrete example cycle. It reports components rather than enumerating every simple cycle, because a tangled component can contain exponentially many of those — the component is the actionable unit, the example makes it concrete.

**Type-only imports are excluded by default.** `import type { X }` is erased by the TypeScript compiler, so it is a real *source* dependency but cannot produce a *runtime* cycle. The indexer records this per edge (`edges.is_type_only`), at both statement and specifier granularity — `import { type A, b }` is one statement carrying one erased edge and one real one.

That distinction turns out to dominate the result. On TypeORM, **56.8% of all import edges (1,562 of 2,750) are type-only**, and the two views disagree completely:

| Query | Result |
|---|---|
| `find_circular_dependencies()` (default, runtime edges) | **0 cycles** |
| `find_circular_dependencies({ includeTypeOnly: true })` | 2 groups — 227 files and 2 files |

TypeORM has **no runtime circular dependencies at all**. The 227-file component that a type-blind graph reports is an artifact of counting erased edges: its seed pair, `RelationLoader.ts` ↔ `DataSource.ts`, is a value import one way and `import type` the other, so the loop never closes at runtime. Using `import type` to break cycles is a deliberate practice in mature TypeScript libraries, and an analyzer that ignores it reports the opposite of the truth.

An earlier build of this tool did exactly that — it reported the 227-file group as a circular dependency. The finding was caught by checking the flagged imports by hand rather than trusting the output.

## Star re-exports

`find_symbol_references` returns a `re_exported_by` field alongside its references, listing barrel files that re-export the symbol's whole module (`export * from './X'`).

This covers a blind spot that identifier-based reference search has *by construction*: `export *` re-exports every symbol in a module without writing any of their names, so there is no identifier for a reference search to match on. TypeScript's own `findReferences` cannot see it either.

It is not a rare edge case. TypeORM's `@Entity` decorator — the library's most recognisable public API — has exactly 6 references, and all 6 are inside its own declaration file (the overload signatures referencing each other). Its one genuine use anywhere else in `src/` is line 53 of `src/index.ts`:

```ts
export * from "./decorator/entity/Entity"
```

Without `re_exported_by`, the tool reports a live public API as having zero uses outside its own file — which reads as dead code. **189 of TypeORM's 2,750 edges are star re-exports.** The indexer tags them `edge_type: 'reexport_star'`, keeping them distinguishable from the other edges that carry no symbol on one end (default, namespace, and side-effect imports).

This was found by reading benchmark transcripts, not by design review: on the reference-count task, both arms independently identified the `index.ts` re-export as the answer while the engine did not report it.

## Development

```bash
npm install
npm run build           # tsc -> dist/
npm run index -- ./tsconfig.json repo-index.db   # index a repo
npm run mcp             # start the MCP server (stdio)
npm test                # vitest
npm run bench           # benchmark harness (spawns Claude Code per run)
```

The benchmark harness needs the standalone `claude` CLI on `PATH`. If it is installed but a
shell started before it was added to `PATH` cannot see it, the harness falls back to the
standard `~/.local/bin` location; set `RIE_CLAUDE_BIN` to override explicitly. Useful flags:
`--tasks=id,id`, `--arms=baseline,assisted`, `--runs=N`, `--skip-build`.
