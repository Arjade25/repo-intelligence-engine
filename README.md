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
| `dependency_path(a, b)` | Is there an import path from A to B, and what is it? Each end can be a symbol name or a file path |
| `find_circular_dependencies()` | Which files form runtime import cycles? Compact: group sizes + one example each (pass `include_files` for full member lists, `include_type_only` to count erased imports too) |
| `find_cycle_through_file(file)` | Is this file in a runtime cycle, and what is the shortest loop through it? Exhaustive when the answer is no |
| `reindex()` | Rebuild the whole index, and report any internal imports that failed to resolve |

The `engine/` functions are callable directly (CLI, tests) — the engine is the product. It also supports Claude Code and any other MCP-compatible client through an integrated MCP server.

Every path-taking query accepts absolute or repo-relative paths, with either slash style, matched case-insensitively. When a path or name matches nothing, every query says so explicitly (`file_indexed: false`, `symbol_indexed: false`, or a `note`) rather than returning a bare empty list. Agents treat an empty list as "no results" and fall back to grep, which the benchmark caught happening (see † below). `find_module` was the last to return a bare `[]`; on a miss it now also lists `similar_names` that match ignoring case. When `dependency_path` finds no path, it says how many files the search reached (`files_searched`) and that the search was exhaustive. The MCP `reindex` tool takes no arguments: every rebuild covers the whole repo.

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

## Benchmark

Every measurement below runs Claude Code in headless mode under two arms:

- **baseline**: built-in tools only (Read/Grep/Glob)
- **assisted** (called `rie` in the generated-task harness): the same tools **plus** this engine's MCP server
- **bash-madge** (long-loop cycle tasks only): the same tools **plus** Bash, with [madge](https://github.com/pahen/madge), the common circular-dependency CLI, on PATH. This is what a developer with a shell would reach for, so it is the fair competitor. See [benchmarks/tools.json](benchmarks/tools.json).

Protocol: a fresh session for every run, so no run sees another's context. 5 runs per arm per task, with medians reported. Metrics are machine-counted from session transcripts (`tool_use` blocks and per-turn token usage), never hand-tallied. The only difference between the arms is `--mcp-config`; both get the same built-in toolset.

There are two harnesses. They answer different questions:

| | `npm run bench` (`benchmarks/run.ts`) | `npm run harness` (`benchmarks/harness/`) |
|---|---|---|
| Tasks | Hand-written, with pre-registered oracle answers verified by independent grep | Generated from compiler ground truth (`npm run taskgen`), never from RIE's index |
| Correctness | `located_oracle` substring check, plus reading transcripts by hand | Graded: the last JSON block of each answer is scored by the task's validator |
| Targets | TypeORM, nest | nest, directus, element-web |
| Raw data | `benchmarks/results/*.json` | `benchmarks/results/harness/*.json`, with the exact task set alongside as `*.tasks.json` |

### At a glance

| Target · task set | Tasks × runs per arm | Baseline | Assisted | Takeaway |
|---|---|---|---|---|
| TypeORM · simple lookups | 6 × 5 | 13 calls total | 9 calls total | Roughly a wash; the savings come from the path tasks |
| TypeORM · 7-hop import path | 1 × 5 | 21 calls / 607K tokens | **1 / 40.7K** | ~15× fewer tokens |
| TypeORM · runtime cycle check | 1 × 5 | 22 calls / 1.24M tokens | **1 / 26.7K** | ~46× fewer tokens |
| nest · hand-written (4 tasks) | 4 × 5 | see [below](#hand-written-tasks-nest) | | 2 wins (one ~107×), 2 losses |
| nest · generated cycle / trap / impact | 27 × 5 | 133/135 correct, 101.5K tokens per correct | 134/135, 112.7K | Tie on accuracy; assisted **~11% more expensive** |
| nest · generated dependency paths | 10 × 5 | 50/50 correct, 345K tokens per correct | **50/50, 164K** | ~2.1× cheaper, half the tool calls |
| directus · generated cycle tracing (long loops) | 10 × 5 | 50/50, $0.157 / 36 s per session | **50/50, $0.039 / 15 s** | ~4× cheaper in dollars, ~2.4× faster |
| element-web · generated cycle tracing (long loops) | 10 × 5 | 50/50, $0.374 / 81 s per session | **50/50, $0.045 / 16 s** | ~8× cheaper in dollars, ~5× faster |
| directus · cycle tracing vs **Bash + madge** | 10 × 5 | 50/50, $0.099 / 69 s per session | **50/50, $0.037 / 13 s** | ~2.7× cheaper in dollars, ~5× faster than the fair competitor |
| element-web · cycle tracing vs **Bash + madge** | 10 × 5 | 49/50, $0.117 / 78 s per session | **50/50, $0.047 / 14 s** | ~2.5× cheaper in dollars, ~5.6× faster |

### Hand-written tasks: TypeORM

Measured against [TypeORM](https://github.com/typeorm/typeorm) @ `04ff4dae`: 496 source files, 1,108 indexed symbols, 2,750 import edges. Nine fixed navigation tasks (`benchmarks/tasks.json`). These counts were re-verified on 2026-09-28 by re-indexing with the now-committed `benchmarks/tsconfig.rie.typeorm.json`. That also gives 1,565 erased edges, 189 star re-exports and 13,517 references, 0 unresolved imports, and 0 runtime cycles (227 + 2 files with type-only edges counted). The benchmark runs below used that index. Since then, the indexer also records bare `require()` calls and matches the compiler's erasure in three more cases (see [Checking it edge by edge](#checking-it-edge-by-edge)). The current index has 2,751 edges, 1,568 of them erased; the symbols, star re-exports and cycle results are unchanged.

#### Where the engine does *not* help

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

#### Where it does

Three later tasks target question shapes text search should struggle with: a deep transitive path, a whole-graph property, and a name grep massively over-counts. Only the first two held up — the third is kept as a negative result (‡):

| Task | Baseline (calls / tokens) | Assisted (calls / tokens) |
|---|---|---|
| Reference count on a heavily over-grepped name ‡ | 6 / 190,226 | 5 / 174,330 |
| Import path A → B (**7 hops**) | 21 / 607,413 | **1 / 40,719** |
| Are there any runtime import cycles? | 22 / 1,242,140 | **1 / 26,661** |

The two traversal tasks cost ~15x and ~46x fewer tokens. The assisted arm answered both in exactly one tool call on all ten runs — a deterministic single query, not a favourable average; four of the five path runs landed within 15 tokens of each other.

The cycle task is the sharpest case, because the *quality* of the answer differs, not just its cost. The baseline reached the right conclusion — "no runtime cycles" — but hedged it explicitly as *"based on my sampling"*, after inspecting roughly 25 of 496 files across 22 tool calls and 1.2M tokens. Reading files cannot prove a negative about a graph. `find_circular_dependencies()` returns a deterministic Tarjan result over all 2,750 edges. Both answers agree; only one of them is verified.

Baseline cost varies widely from run to run (15–24 calls on the path task, 14–29 on the cycle task), so these ratios are measured medians, not guarantees.

**Metric caveat:** the harness also records `located_oracle`, a substring check for an oracle filename in the final answer. It is a smoke detector, not a grader. It reads `false` for a perfectly correct answer that never restates the filename — which happens when the prompt itself already names the file — and for correct answers to questions whose oracle names no file at all, like the cycle task. Treat calls and tokens as the measurements; read transcripts to judge correctness.

**† What the benchmark caught:** the first measurement of the impact task showed the assisted arm *losing* (median 5 calls vs. 3, spread up to 11). Transcripts revealed an interface bug, not a data bug: the engine's path-taking tools did exact string matching, so the Windows-style backslash and repo-relative paths agents naturally pass returned empty results — and one tool answered *"symbol not indexed"* when only the path filter had failed. Agents did the rational thing and fell back to grep, doubling the work. After fixing path resolution (normalization + unique-suffix matching + honest "filter dropped" notes), the task flipped to a win and run-to-run variance collapsed from 3–11 calls to 2–3. The raw per-run data for both measurements is in `benchmarks/results/`.

**‡ A task that failed, kept deliberately.** The reference-count task was designed as a trap: `grep -w Entity` returns 684 hits across 72 files — ~114x the 6 real references — because `Entity` is TypeORM's ubiquitous generic type-parameter name (`Repository<Entity>`, `QueryBuilder<Entity>`). Neither arm fell for it. Both immediately grepped `Entity\(` with the paren, which is highly discriminating for a callable, and collapsed 684 hits to ~7 files in a single call. The task is retained as a negative result, because it marks the boundary of the claim above: name-overcount is only grep-hostile for symbols used in *type position*, where a usage is a bare name indistinguishable from a type parameter. For functions and decorators, `Name(` and `@Name` hand grep a precise handle. An earlier N=1 measurement of this task showed the assisted arm losing badly (18 calls vs 13); at N=5 that reversed to a slight win. Both readings were mostly noise — the baseline arm alone moved from 13 calls to a median of 6 between runs, and the baseline never touches the MCP server.

### Hand-written tasks: nest

Measured against [nestjs/nest](https://github.com/nestjs/nest) @ `40d07dc6`: 664 non-spec source files, 1,473 indexed symbols, 3,442 file-level edges. Four tasks (`benchmarks/tasks-nest.json`), 5 runs per arm. Medians:

| Task | Baseline (calls / tokens) | Assisted (calls / tokens) | |
|---|---|---|---|
| Impact: who imports `Injector`? | **5 / 82,321** | 5 / 120,202 | Assisted uses ~46% more tokens |
| Import path `ClientProxyFactory` → `NestContainer` | 10 / 156,786 | **6 / 79,238** | ~2× fewer tokens |
| Is `ParseUUIDPipe` public API, and how? | **4 / 40,497** | 5 / 68,074 | Negative result, kept |
| Are there any runtime import cycles? | 44 / 6,317,943 | **3 / 58,832** | ~107× fewer tokens |

The cycle question again separates the two arms most. It also separates them on answer quality, not just cost. All 5 assisted runs named both 4-file runtime cycle groups and all four distinctive member files. The baseline read its way to the same answer in 4 of 5 runs, spending 6.3M tokens per run at the median; in the fifth run it declined to answer. The two import-impact and public-API questions went the other way: a grep for the class name or its import line answers them directly, and the MCP arm paid for tool calls that added nothing. On `ParseUUIDPipe`, all 10 runs were correct, and the task's grep-hostile premise did not hold (see its oracle note in `tasks-nest.json`).

The baseline figures are from `nest-2026-09-22T19-39-36-345Z.json`. The assisted figures are from the re-run `nest-2026-09-22T19-46-46-266Z.json`, because the nest index was rebuilt partway through the first run. [`benchmarks/results/README.md`](benchmarks/results/README.md) explains the pairing.

### Generated, graded tasks: nest

The hand-written tasks each have a single answer that a person picked. The generated set removes that selection step. `npm run taskgen` derives tasks and their answers from the real `tsc` emit and a re-type-check of nest. `npm run harness` then grades every answer, so accuracy is measured rather than judged. Model: `claude-opus-5-5` on every run. Claude Code 2.1.280. 5 runs per arm per task, with arm order rotated. Neither run had a crashed session.

**Run 1: cycle tracing, runtime-vs-type traps, change impact** (27 tasks, 270 sessions, `nest-full-2026-09-27T10-43-36Z.json`)

| Category | Tasks | Baseline correct | Assisted correct | Tokens per correct (baseline → assisted) | Median tokens [IQR] (baseline → assisted) | Median calls |
|---|---|---|---|---|---|---|
| cycle_trace | 8 | 40/40 | 40/40 | 60,469 → 70,881 | 56,003 [46,113–79,901] → 67,393 [63,759–75,215] | 5 → 5 |
| runtime_type_trap | 10 | 49/50 | 50/50 | 91,955 → 92,941 | 69,359 [52,769–117,436] → 74,297 [64,503–103,923] | 5 → 5 |
| change_impact | 9 | 44/45 | 44/45 | 149,559 → 173,021 | 134,325 [116,912–158,620] → 154,546 [125,704–188,434] | 6 → 6 |
| **All** | **27** | **133/135** | **134/135** | **101,543 → 112,651** | 82,377 → 85,179 | 5 → 5 |

On these tasks the engine did not pay for itself. Accuracy is at the ceiling in both arms: 3 wrong answers out of 270 runs. The baseline missed one because it gave no parseable JSON block, and another because it listed one extra file. The assisted arm missed one by leaving out one file. Tokens per correct answer are ~11% higher with the engine loaded, and the assisted arm had the lower median on only 9 of the 27 tasks. Two things explain most of this:

- **Grep already reaches the answer.** nest has only two runtime cycles, 4 files each, and the shortest loop through any member is 3 files. That is why nest's task file lowers `--min-path` to 3. A 3-file loop leaves little traversal for an index to save. The change-impact sets are large (7–50 files, median 35), but the question "which files use this export?" starts from a name, and a name search finds those files: the baseline got 44 of 45 right with a median of 6 calls.
- **The assisted arm often didn't use the engine.** It called an RIE tool in all 40 cycle-trace runs, 31 of 50 trap runs and only 13 of 45 change-impact runs. Across the change-impact runs it made 195 Grep calls and 13 RIE calls. It solved those tasks the same way the baseline did.

**Run 2: dependency paths** (10 tasks, 100 sessions, `nest-paths-2026-09-27T14-57-18Z.json`)

"Can you get from file A to file B by following imports?" Five tasks have a path, and the shortest one is 12–14 hops long; any valid chain is accepted. Five have no path, even though A transitively imports at least 25 files.

| Subset | Baseline correct | Assisted correct | Tokens per correct (baseline → assisted) | Median tokens (baseline → assisted) | Median calls |
|---|---|---|---|---|---|
| Path exists (5 tasks) | 25/25 | 25/25 | 423,378 → **122,454** | 400,621 → **124,859** | 17 → 6 |
| No path (5 tasks) | 25/25 | 25/25 | 267,059 → **206,076** | 232,812 → **205,072** | 12 → 9 |
| **All** | **50/50** | **50/50** | **345,218 → 164,265** | 319,582 [232,335–449,270] → 135,195 [101,106–208,889] | 14 → 7 |

Both arms answered all 100 runs correctly. The assisted arm got there with ~2.1× fewer tokens per correct answer, half the tool calls, and a median wall time of 29 s against 47 s. It had the lower median on 9 of the 10 tasks, and it used `dependency_path` or `find_related_files` in all 50 of its runs.

The saving is concentrated where the claim predicts. When a path exists, `dependency_path` returns the whole 12–14-hop chain in one query: ~3.2× fewer tokens by median, with 25 RIE calls across 25 runs. Proving that *no* path exists saved much less, ~1.1× by median. In those runs the agent did not accept `found: false` on its own. It followed up with 38 `find_related_files` calls and 30 file reads (against 7 reads when a path existed), walking the import graph by hand to confirm the negative. A `found: false` result now carries `files_searched` and a note saying the search was exhaustive. Whether that changes agent behavior hasn't been measured yet: the numbers above predate it.

### Generated, graded tasks: long-loop repos (directus, element-web)

nest's runtime cycles are two 4-file groups, too short to test the claim that long loops are where reading files gets expensive. `npm run screen` ranks candidate repos by the shortest runtime loop through each cycle member. Two came out with long loops, and both were **chosen for that reason**, so everything below is conditional on long loops:
- **directus** (`api/`, 837 files): a 157-file runtime group, where 57% of members have no loop shorter than 6 files.
- **element-web** (`apps/web`): a 115-file group, with loops up to 17 files.

Each task names a file and asks for a runtime import chain that leads back to it (shortest loops of 6–12 files). The validator accepts any valid loop. Model `claude-opus-5-5`, 5 runs per arm per task, arm order rotated.

| Run | Arm | Correct | Cost per session | Median wall time | Median calls | Tokens per correct | Median tokens [IQR] |
|---|---|---|---|---|---|---|---|
| directus, 09-29 (first version) | baseline | 50/50 | $0.147 | 39 s | 10 | 223K | 188K [150–249K] |
| | rie | 50/50 | $0.228 | 36 s | 10 | 373K | 357K [299–397K] |
| directus, 09-30 (`find_cycle_through_file`) | baseline | 50/50 | $0.157 | 36 s | 11 | 235K | 196K [162–282K] |
| | rie | 50/50 | $0.080 | 24 s | 5.5 | 107K | 109K [78–129K] |
| directus, 09-30 (+ per-hop evidence) | rie | 50/50 | **$0.039** | **15 s** | **1** | 30K | 26K [26–28K] |
| element-web, 09-30 | baseline | 50/50 | $0.374 | 81 s | 21.5 | 841K | 628K [366K–1.2M] |
| | rie | 50/50 | **$0.045** | **16 s** | **1** | 27K | 28K [18–29K] |
| directus, 10-01 (vs a shell) | bash-madge | 50/50 | $0.099 | 69 s | 4 | 98K | 92K [69–110K] |
| | rie | 50/50 | **$0.037** | **13 s** | **1** | 27K | 26K [26–27K] |
| element-web, 10-06 (vs a shell) | bash-madge | 49/50 | $0.117 | 78 s | 4 | 102K | 98K [68–124K] |
| | rie | 50/50 | **$0.047** | **14 s** | **1** | 30K | 28K [27–36K] |

Result files are in `benchmarks/results/harness/`, named `directus-2026-09-29T10-12-50-834Z`, `directus-2026-09-30T07-10-55-765Z`, `directus-2026-09-30T10-30-32-403Z`, `element-web-2026-09-30T11-27-14-790Z`, `directus-2026-10-01T06-18-36-796Z` and `element-web-2026-10-06T06-17-30-224Z`. The madge runs used Claude Code 2.1.285 (directus) and 2.1.289 (element-web), with the rie arm interleaved in each. The earlier runs used 2.1.283–2.1.284.

**The first version lost.** On 09-29 the engine cost ~1.6× the baseline. Its cycle report ran to ~25K characters and stayed in context for the rest of the session. It also couldn't answer "a loop through file X", so agents grepped anyway. [Circular dependency detection](#circular-dependency-detection) describes the fixes, and each one was re-measured:
- `find_cycle_through_file` brought it to ~2× cheaper.
- Adding each hop's import statement brought it to ~4× cheaper. After that, 40 of 50 sessions answered with that single tool call.

The final directus rie run reuses that morning's baseline, which has the same model, CLI and tasks, and the baseline was stable across days.

**element-web had longer loops, and the gap grew.** Baseline cost rose with loop length: the median ranged from 251K tokens on the easiest task to 1.9M on the hardest, and one session needed 38 tool calls. The engine's answer took one call on every task, at 17–49K tokens. It was cheaper on all 10 tasks.

**Against a shell and madge, the margin narrows but holds.** The Read/Grep baseline above is a weak competitor: with no shell, it can't run the tool a developer would use. The bash-madge arm adds Bash and madge 8.0.0, configured to skip `import type`, and a one-line system note saying it's available. That note does the job MCP tool descriptions do for the rie arm. Its agents used madge well:
1. They exported madge's whole import graph with `madge --json`.
2. They wrote a short Node script to find the loop through the target file.
3. They grepped each hop to confirm it.

That is 4 calls at $0.099 per session, cheaper than the Read/Grep baseline's $0.157, but the slowest arm at 69 s, because each madge pass over 837 files takes tens of seconds. The engine was ~2.7× cheaper and ~5× faster, at equal accuracy. Answer quality also differed slightly: 15 of 50 madge answers gave a longer loop than necessary, and the engine always gave the shortest.

madge is also not a runtime-cycle oracle. It has no type checker, so a plain `import { T }` used only as a type still counts as an edge. Offline on directus, it placed 40 files in cycles that the emit-verified runtime graph does not have. The agents' habit of checking each hop kept that from producing a wrong answer. The rie arm ran in the same session, interleaved, so the CLI version change between runs doesn't affect this comparison.

**On element-web the result held: ~2.5× cheaper and ~5.6× faster.** madge's cost didn't grow with loop length. It stayed at $0.07–0.17 per task for loops of 6 to 12 files, because exporting the whole graph and searching it costs about the same however long the loop is. That's why it gets far closer to the engine than the Read/Grep baseline does, which climbed past $1 on the longest loops. 20 of its 50 answers were longer than the shortest loop.

The one wrong madge answer is partly the task's fault. The agent followed a dynamic `import("../stores/room-list-v3/RoomListStoreV3")` in `StoresApi.ts`. element-web's developers added it there, by their own comment, "to prevent circular dependency issues": it loads lazily, after the importing file has finished loading, so it isn't a load-time cycle, and the grader is right to reject it. But the cycle-task prompt never said dynamic `import()` calls don't count, while the path-task prompt did. madge includes them in its graph, so the ambiguity worked against it. Strictly, that's 49/50; with this ambiguity excluded, it's 50/50. Newly generated cycle and trap prompts now state the rule. The grader also used to blame the wrong step here (`EventTileFactory → Api`, a real import), because it only knows the start file's cycle group. It now reports that `src/modules/Api.ts` is outside the group instead.

**How to read these numbers:**
- **Dollars and wall time are the headline, not tokens.** Most of the baseline's tokens are its growing context re-read from cache on every turn, and cache reads are cheap. The token ratios (~8× on directus, ~31× on element-web) overstate the real saving by 2–4×.
- **The baseline has Read, Grep and Glob only.** It has no shell, so it can't run `madge --circular` or `tsc`, which a developer would reach for. Against that baseline the engine is ~4–8× cheaper. Against the bash-madge arm it is ~2.7× cheaper on directus and ~2.5× on element-web, and ~5× faster on both. Those are the numbers to quote.
- **No session reached the answers.** Target repos sit inside this project, a few folders below the generated tasks and their expected answers. `npm run audit` scans every session's tool calls for paths outside the target checkout, or any reference to the answer files. It found nothing in all 550 long-loop sessions, and each results file carries its `meta.audit` record.
- **The tasks fit the tool.** `find_cycle_through_file` was built after these tasks exposed the gap, and it answers exactly their question. Path and runtime-vs-type trap tasks on the same repos haven't been run yet.
- **The one-time index build isn't counted.** It takes a few minutes on element-web, before any session starts.

### Overall reading

This is not "faster than grep." Where a name search can answer the question directly, the engine is a wash or a cost:
- TypeORM's single-symbol lookups
- nest's generated cycle, trap and impact tasks, where the assisted arm spent ~11% more tokens per correct answer
- nest's hand-written impact and public-API questions, where it spent ~46% and ~68% more tokens

The large, repeatable wins all come from multi-hop and whole-graph questions, the two things text search structurally cannot do:
- long import paths: ~15× fewer tokens on TypeORM, and ~3.2× on nest paths that exist
- runtime-cycle detection over a whole repo: ~46× fewer tokens on TypeORM, and ~107× on nest
- tracing a cycle through a given file in repos with long loops: ~4× cheaper in dollars on directus and ~8× on element-web than a Read/Grep agent. Against an agent with a shell and madge it was ~2.5–2.7× cheaper and ~5× faster on both repos. All at equal or better accuracy (see the caveats [above](#generated-graded-tasks-long-loop-repos-directus-element-web)).

In the 370 graded nest sessions, accuracy was essentially the same in both arms (183/185 baseline, 184/185 assisted). In the 550 long-loop sessions, every arm answered every cycle task correctly except one bash-madge session, which followed a dynamic `import()` that the cycle prompt hadn't yet ruled out. On these tasks, the engine changes what a correct answer costs, not whether the agent finds it.

## Circular dependency detection

`find_circular_dependencies()` reports strongly connected components of the import graph (Tarjan's algorithm), each with one concrete example cycle. It reports components rather than enumerating every simple cycle, because a tangled component can contain exponentially many of those — the component is the actionable unit, the example makes it concrete.

**Output is kept small, and the per-file question has its own tool.** The first long-loop benchmark run (directus, a 157-file runtime group) had the RIE arm spending ~1.6x the baseline's tokens per correct answer. Agents called this tool in all 50 runs; its output was ~25K characters (absolute paths, every member of every group), which stayed in context and was re-read on every later turn. It also didn't answer the question those tasks asked, "give a loop through file X", so agents grepped anyway. The MCP tool now returns paths relative to the repo, member lists only for groups of 8 files or fewer, and a pointer to `find_cycle_through_file`, which BFSes from the file back to itself and returns the shortest loop through it (or `in_cycle: false`, with `files_searched` and `type_only_cycle_exists`). On directus that is 2.5K characters instead of 24.8K, and `find_cycle_through_file` returns a chain the task validator accepts on 10/10 cycle tasks, each at the oracle's minimum length. The engine's `findCircularDependencies` still returns the full form, which the oracle comparison uses.

With that change the rie arm went from ~1.6x more to **~2.2x fewer tokens per correct answer** than the baseline on the same 10 directus tasks (107K vs 235K, both 50/50 correct; `benchmarks/results/harness/directus-2026-09-30T07-10-55-765Z.json`). Every rie session still grepped, though, to confirm each step of the loop was a real, non-erased import. So `find_cycle_through_file` now also returns `hops`: for each step, the statement's `file:line`, its text, and `runtime_names`, meaning the imported names the type checker saw used as values. That comes from three columns the indexer now records per edge (`line`, `statement`, `imported_name`). Re-measured on the same 10 tasks (rie arm only, 50 sessions, `directus-2026-09-30T10-30-32-403Z.json`): 50/50 correct at **30K tokens per correct answer**, down from 107K and about 7.8x below the baseline's 235K. The median session made 1 tool call, 40 of 50 sessions made no other call, and Grep/Read calls fell from 268/13 to 11/4. The baseline figure comes from the earlier run the same day, with the same model, CLI and tasks.

All three directus result files were re-graded (`npm run regrade`, recorded in each file's `meta.regraded`) after a grader fix. The prompt asks for paths "relative to the repository root", and in a monorepo package that can mean the git root. The grader now accepts `api/src/...` when the path only exists without that prefix. Each two-arm run had exactly one baseline answer that found the correct loop but was marked wrong for this prefix. The baseline is now 50/50 in both runs, at 223K (09-29) and 235K (09-30) tokens per correct answer.

Running the emitted-JS oracle on directus and element-web while building this turned up three erasure gaps. Each one hid a runtime edge, and each was checked against real `tsc` emit before it was fixed. They didn't change any cycle group on either repo:
- `import { type X } from` under `verbatimModuleSyntax` compiles to `import {} from`, which still loads the module. RIE had treated it as erased (2 edges on directus).
- An instantiation expression (`Dialog<Props>` passed as a value) was read as a type position (1 edge on element-web).
- In a statement with both a default import and named imports, the default binding's verdict was applied to every name.

After the fixes, the oracle reports 0 hidden runtime edges on all four benchmark repos: TypeORM 1144 edges agree, nest 1440 agree with 2 safe over-reports, directus 2237 agree, element-web 6467 agree.

**Erased imports are excluded by default.** An import that TypeScript erases is a real *source* dependency but cannot produce a *runtime* cycle. The indexer records this per edge (`edges.is_type_only`), at both statement and specifier granularity — `import { type A, b }` is one statement carrying one erased edge and one real one.

Crucially, the test is **whether the compiler erases the import, not whether the source wrote the `type` keyword**. TypeScript erases any import whose bindings are only ever used in type position, keyword or not, so the indexer walks each file and asks the emitter's question: is this binding ever referenced from a value position? (`src/indexer/erasure.ts`.) The keyword remains authoritative when present; the analysis catches what it misses. Three cases decide most of it: `typeof X` is a type query and erases; `class C extends B` is the one heritage position that survives, because `B` becomes the prototype, while `implements` and an interface's own `extends` do not; and `export { A } from './x'` binds no local name, so it is decided by whether `A` has a value meaning in its source module.

This is not a hypothetical refinement — it is the difference between the right answer and the wrong one on real codebases, and the section below on nest measures exactly how much.

That distinction turns out to dominate the result. On TypeORM, **57% of all import edges (1,568 of 2,751) are erased**, and the two views disagree completely:

| Query | Result |
|---|---|
| `find_circular_dependencies()` (default, runtime edges) | **0 cycles** |
| `find_circular_dependencies({ includeTypeOnly: true })` | 2 groups — 227 files and 2 files |

TypeORM has **no runtime circular dependencies at all**. The 227-file component that a type-blind graph reports is an artifact of counting erased edges: its seed pair, `RelationLoader.ts` ↔ `DataSource.ts`, is a value import one way and `import type` the other, so the loop never closes at runtime. Using `import type` to break cycles is a deliberate practice in mature TypeScript libraries, and an analyzer that ignores it reports the opposite of the truth.

An earlier build of this tool did exactly that — it reported the 227-file group as a circular dependency. The finding was caught by checking the flagged imports by hand rather than trusting the output.

### Why keyword detection was not enough

TypeORM passes this test for a reason that does not generalize: its authors write `import type`. nestjs/nest, added as a second benchmark target, writes plain `import { Foo }` even for pure types — 218 `import type` statements against 1,698 plain ones. Against a keyword-only check, nest's erased edges all counted as runtime edges:

| | nest |
|---|---|
| keyword detection only | 7 cycle groups — 69, 54, 27, 9, 6, 2, 2 files |
| value-position analysis | **2 groups — 4 and 4 files** |
| emit-verified ground truth | **2 groups — 4 and 4 files**, same members |

Ground truth here is not the engine's own output. It comes from `benchmarks/oracle/emitted-edges.ts`, which builds a real `ts.Program` and emits every file. It then reads which imports survive into the emitted JavaScript, as `require()` calls or retained ESM `import`/`export` statements, and runs its own Tarjan on those. An import the compiler elides cannot cause a runtime cycle; one it keeps can. The oracle leaves the repo's `module` and `moduleResolution` settings alone. An earlier version forced `module: CommonJS`, and TypeScript rejects that combination (TS5110) under the `Node16` resolution that nest uses. TypeORM re-measured against the same oracle is unchanged at 0 runtime cycles.

Edge by edge, TypeORM (re-run 2026-09-28) has **1,144 runtime pairs on each side, all agreeing: 0 safe over-reports and 0 hidden edges**, and `npm run oracle` exits 0. The last over-report was `src/driver/mongodb/typings.ts`, whose `declare class … extends Readable` looked like the one heritage position that survives. A `declare` class emits no code, so the indexer now treats everything in an ambient context as erased. Until that re-run, one real runtime edge was hidden: `src/cli-ts-node-esm.ts` loads `./cli` with a bare `require("./cli")` call inside an `if`. That is a function call, not an import declaration, and the indexer walked only `import`, `export … from` and `import x = require()` statements, while the emitted JavaScript keeps the `require()`. It didn't change TypeORM's answer, since neither side found a cycle, but it was a gap in the dangerous direction. The indexer now records every top-level `require("literal")` call as a runtime edge (`edge_type: 'require'`). It uses the oracle's rule: a `require()` nested inside a function is a lazy load and not an edge. The unresolved-import check covers these calls too.

**Re-verified 2026-09-28** at nest @ `40d07dc6`, with the committed `benchmarks/tsconfig.rie.nest.json`. The oracle covered 664 files. `src/indexer/resolution.ts` reports **0 unresolved internal imports** under the compiler's own ESM/CJS resolution mode (see [Unresolved imports](#unresolved-imports)). RIE and the oracle both find 2 runtime groups of 4 files each. Counting type-only edges as well, RIE reports 69, 54, 27, 10, 6, 2 and 2.

Two traps surfaced while building that oracle, both of which produced a clean-looking wrong number:

- A dynamic `import()` downlevels to `Promise.resolve().then(() => require(X))`. Counting raw `require(` matches turns every optional peer-dependency load into a hard edge, inventing a 22-file cross-package component that is not an initialization cycle at all. Lazy asynchronous loads are correctly absent from a static import graph.
- Deriving the oracle's source root by guessing `packages/` versus `src/` produced an *empty* graph for TypeORM — which still reported a tidy "0 cycles" and agreed with the engine for entirely the wrong reason. TypeORM has its own `packages/` directory. The root is now derived from the tsconfig's own file list, and the script prints its file count so an empty graph cannot masquerade as agreement.

### Checking it edge by edge

Component counts are a coarse check — two graphs can agree on cycles and still disagree about hundreds of edges. So every one of nest's 2,182 distinct file-pairs was compared against the emitted output directly, asking of each: does the compiled JavaScript actually `require` this?

| | pairs |
|---|---|
| agree with emitted output | 2,180 |
| erased by the compiler, reported as runtime | 2 |
| real runtime edge, reported as erased | **0** |

`npm run oracle` reproduces this table. The 2026-09-28 re-run found RIE marking 1,442 distinct pairs as runtime. Of those, 1,440 agree with the oracle's 1,440 runtime pairs and 2 are safe over-reports; the other 740 pairs agree as erased; and none are hidden. Earlier the same day the split was 2,153 / 29 / 0. The 27 closed since are covered below.

The two directions are not equally serious. Reporting a runtime edge that the compiler erases can only ever *over*-report a cycle; missing a real one can *hide* one. The first pass of this analysis had 3 of the dangerous kind, all `@Injectable()` classes taking a constructor dependency: `emitDecoratorMetadata` re-emits a decorated declaration's parameter and property types as `design:paramtypes`/`design:type`, so those imports survive despite appearing only in type position. The indexer now treats metadata positions as value uses when the option is on, which takes that column to zero.

The 29 safe over-reports came down to two causes, and both now follow the compiler's own rules. The `fixtures/const-enum-repo` and `fixtures/decorator-metadata-repo` fixtures check each rule against real emit:

- **`const enum`** (20 pairs). The compiler inlines a const enum's members, so the import disappears even though the source uses it as a value. A value use keeps the import only under `isolatedModules`. An export (`export { E }`, `export { E } from`) keeps it under `isolatedModules` or `preserveConstEnums`.
- **Decorator metadata that serializes to a global** (7 pairs). `emitDecoratorMetadata` emits one name per annotated type, and only a class survives as a reference. An interface or type alias serializes to `Object`. So does a union of different types, or `X | null` under `strictNullChecks`. In `Promise<X>`, only `Promise` is emitted. Previously, any name anywhere in a decorated annotation counted.

**Known limit**, in the safe direction: the last 2 pairs are regular enums whose member initializers reference another module's enum (`PAYLOAD = RouteParamtypes.BODY`). The compiler constant-folds those values and drops the import. The indexer counts the edge. A namespace that holds only const enums is also still treated as a value.

### `verbatimModuleSyntax` and `import x = require(...)`

Two more dangerous-direction gaps, closed after nest's edge-by-edge check above: neither showed up as a wrong *count* on nest (nest uses neither), only as a wrong *answer* on a repo that does.

`verbatimModuleSyntax` (and its deprecated predecessors `importsNotUsedAsValues: "preserve"|"error"` and `preserveValueImports`) turn off the compiler's usage-based elision entirely — everything is kept except what's explicitly marked `type`. Running value-position analysis anyway would erase a plain `import { Foo }` that the compiler actually emits, hiding a real cycle. Confirmed against a real `tsc` emit: under `verbatimModuleSyntax`, a plain import used only in type position keeps its `import` statement; only the explicit `import type` form drops it. `src/indexer/erasure.ts`'s `isErasureDisabledByFlag` gates both the import-side walk and re-export elision on these flags.

`import x = require("./mod")` (`ImportEqualsDeclaration`) is a separate AST shape from `import { x } from "..."`, and the edge walk didn't visit it at all — every such statement produced **zero edges**, not a miscounted one. Emit-verified before fixing: a value-used binding keeps its `require()`; one used only in type position, or explicitly `import type x = require(...)`, drops it entirely, same as a regular import.

`export * from` was checked too, as the third item on the same list: a module whose declarations are *all* type-only (an interface-only file) still keeps its `require()`/`__exportStar` call when re-exported with `export *` — the star-export transform can't prove the target has zero runtime exports, so it never elides. The existing always-runtime treatment of star re-exports was already correct here; this just locks it in with a fixture.

## Star re-exports

`find_symbol_references` returns a `re_exported_by` field alongside its references, listing barrel files that re-export the symbol's whole module (`export * from './X'`).

This covers a blind spot that identifier-based reference search has *by construction*: `export *` re-exports every symbol in a module without writing any of their names, so there is no identifier for a reference search to match on. TypeScript's own `findReferences` cannot see it either.

It is not a rare edge case. TypeORM's `@Entity` decorator — the library's most recognisable public API — has exactly 6 references, and all 6 are inside its own declaration file (the overload signatures referencing each other). Its one genuine use anywhere else in `src/` is line 53 of `src/index.ts`:

```ts
export * from "./decorator/entity/Entity"
```

Without `re_exported_by`, the tool reports a live public API as having zero uses outside its own file — which reads as dead code. **189 of TypeORM's 2,751 edges are star re-exports.** The indexer tags them `edge_type: 'reexport_star'`, keeping them distinguishable from the other edges that carry no symbol on one end (default, namespace, and side-effect imports).

This was found by reading benchmark transcripts, not by design review: on the reference-count task, both arms independently identified the `index.ts` re-export as the answer while the engine did not report it.

## Unresolved imports

An internal import that the compiler can't resolve doesn't fail loudly anywhere. The edge extractor drops it, and the type-checker reports TS2307 and treats the binding as an error type. As a result, every downstream answer that depends on it is wrong without any sign of it: edges, references, and compile impact.

This happened on nest. Every nest package is `"type": "module"`, so under `module: Node16` its imports resolve in ESM mode. In ESM mode, a `paths` alias that points at a *directory* never resolves. **556 cross-package imports** were unresolved and nothing said so. A plain `ts.resolveModuleName` call, which is what the edge extractor makes, defaults to CJS mode and resolved every one of them. So the edges looked complete, and the damage showed up only in answers that go through the type-checker: references and change impact.

`src/indexer/resolution.ts` now checks every relative or `paths`-alias import using the per-import resolution mode the compiler itself uses. The result is reported, not thrown, since a partial index is still useful as long as it is known to be partial:

| Caller | Does |
|---|---|
| `reindex()` (engine) | Returns `unresolved_internal_imports` |
| `npm run index` | Prints a `WARNING` with examples |
| MCP `reindex` tool | Adds a `warning` field to its result |
| `npm run harness` | Refuses to benchmark against a partial index |
| `npm run taskgen` | Refuses to generate, unless given `--allow-unresolved` |

The fix for nest was to point the aliases at files (`"@nestjs/common": ["./packages/common/index.ts"]`), which is what the committed `benchmarks/tsconfig.rie.nest.json` does. With it, nest has 0 unresolved imports.

## Test suite

`npm test` runs **188 tests in 12 files, all passing** (vitest, 2026-09-29). The tests run against small fixture repos under `fixtures/`: sample, type-only, decorator-metadata, verbatim-module-syntax, const-enum, esm-alias and taskgen. They don't need a cloned benchmark target.

| File | Covers | Tests |
|---|---|---|
| `src/engine/index.test.ts` | All six queries, explicit not-found results, path normalization and suffix matching, ambiguity notes, runtime vs type-only cycles, file-path `dependency_path` | 41 |
| `src/indexer/index.test.ts` | Symbols, file-level edges, NULL-symbol edges, per-edge erasure, bare `require()`, const enums, decorator metadata | 40 |
| `benchmarks/oracle/emitted-edges.test.ts` | Emit-based ground truth, including dynamic `import()`, NodeNext, bare `require()`, const enums, decorator metadata, unresolved internal imports | 33 |
| `benchmarks/taskgen/generate.test.ts` | Every task category, `--min-path`, broken re-export filter, determinism for a given seed, trap direction grading | 23 |
| `benchmarks/harness/harness.test.ts` | Prompt building, answer parsing, grading, summaries (stub agent) | 11 |
| `src/mcp-server/index.test.ts` | Each MCP tool's result equals the direct engine call; `reindex` takes no arguments | 9 |
| `src/indexer/erasure.test.ts` | Value-position analysis, `verbatimModuleSyntax` gate | 8 |
| `benchmarks/oracle/tarjan.test.ts` | Independent SCC implementation | 6 |
| `benchmarks/oracle/loops.test.ts` | Shortest loop through each cycle member (`npm run screen`) | 6 |
| `src/indexer/resolution.test.ts` | Unresolved internal import detection (ESM directory aliases, bare `require()`, asset imports ignored) | 5 |
| `src/indexer/references.test.ts` | `findReferences` union across alias groups | 4 |
| `src/engine/reindex.test.ts` | A full rebuild is idempotent and reflects added and removed files | 2 |

## Development

```bash
npm install
npm run build           # tsc -> dist/
npm run index -- ./tsconfig.json repo-index.db   # index a repo
npm run mcp             # start the MCP server (stdio)
npm test                # vitest
npm run bench           # benchmark harness (spawns Claude Code per run)
npm run oracle -- <path-to-tsconfig.json>   # diff RIE's runtime edges against a real tsc emit
npm run screen -- <path-to-tsconfig.json>   # how hard would this repo's cycle tasks be? (no agents, no index)
npm run taskgen -- --config=nest            # generate graded tasks -> benchmarks/generated/nest.json
npm run harness -- --config=nest --runs=5   # run them per tool arm, grade, and summarize
```

`npm run harness` runs every generated task as a fresh headless Claude Code session per tool arm, with the identical prompt, model, repo checkout and built-in Read/Grep/Glob. Arms differ only in the one MCP server they load, listed in `benchmarks/tools.json` (`baseline` loads none). Each prompt ends with a fixed instruction to answer in a JSON block. Only that block is graded, by the task's validator, and a reply without one is scored wrong rather than guessed at. Arm order rotates across runs, and a crashed run counts as a wrong answer, not a missing one. Reported per task, category and arm: accuracy, **tokens per correct answer** (all tokens spent ÷ correct answers), median tokens with IQR, tool calls and wall time. Tokens are the primary cost measure rather than dollars, because the token count doesn't depend on cache hits. Results keep every run's transcript metrics, final text and grade in `benchmarks/results/harness/`. `--dry-run` prints the exact agent commands without launching anything. Claude Code exposes no temperature setting, so variance between runs is measured rather than controlled.

`npm run taskgen` builds benchmark tasks from compiler ground truth, never from RIE's index: cycle tracing (graded by a validator that accepts any runtime cycle through the start file), dependency paths ("can you get from A to B by following imports?": half are chains of at least `--min-hops` hops, default 5, and any valid chain is accepted; half have no path, even though A transitively imports at least `--min-closure` files, default 25, and B sits next door and usually reaches A; answering "no" means ruling out that whole set), runtime-vs-type traps (yes/no pairs, where every "no" is a cycle that only closes through an erased import, and a "no" must also name the direction with no runtime path; on a repo with no runtime cycles every trap is a "no", so yes/no alone would give a blanket "no" full marks), and change impact (the answer comes from actually removing the export in memory and re-type-checking). A task is dropped when it hinges on fewer than `--min-path` files (default 4; a task file can set `taskgen.min_path`, and nest uses 3 because its only runtime cycles are 3-file loops). A change-impact task is also dropped when a broken named re-export (`export { X } from`) shields importers: TypeScript's error recovery still resolves `X` through the broken line, so those importers compile, which no reader of the source would predict. Every prompt states its scope (only the files the tsconfig includes), since the ground truth covers nothing else. Generation refuses to run if any internal import fails to resolve under the compiler's own ESM/CJS resolution mode (`--allow-unresolved` overrides): such an import is a baseline type error, so the impact oracle can't see anything break through it. On nest, directory-style `paths` aliases in `"type": "module"` packages caused exactly this, hiding every cross-package file. `reindex` reports the same check, and the harness won't benchmark against a partial index. Each task carries difficulty tags (SCC size, path length, barrels, aliases, type-only distractors) and the tsconfig flags it was generated under. Output is deterministic for a given `--seed`.

`npm run oracle` is the reusable form of the manual validation described above under "Checking it edge by edge": it compiles the target repo for real (`benchmarks/oracle/emitted-edges.ts`), reads which imports actually survive into emitted output, and diffs that against RIE's own index — printing the same agree / safe-over-report / dangerous-hidden-edge breakdown, plus an SCC comparison. The ground-truth side (`emitted-edges.ts` and its own `tarjan.ts`) shares no code with `src/indexer` or `src/engine`, by design: it's the check that would catch a bug in either. Only the comparison script, `compare.ts`, imports the engine, because the engine is what it diffs against. It exits 1 if any real runtime edge is reported as erased.

`npm run screen` decides whether a repo is worth benchmarking before any agent runs. It compiles the repo with the oracle and reports, for each runtime cycle group, the shortest loop back to each file. A cycle-trace task accepts any loop through its start file, so that shortest loop, not the group's size, is what makes the task hard. The TypeScript compiler shows the difference: a 73-file group in which 69 files loop back through one barrel in 2 steps. It also flags internal imports that don't resolve, since those make a repo look less tangled than it is. Ten candidate repos were screened on 2026-09-29. Two have long loops: directus (a 157-file group, 57% of whose files have no loop shorter than 6) and element-web (115 files, 50%). The full table, configs and caveats are in [`benchmarks/candidates-config/`](benchmarks/candidates-config/README.md).

### Setting up a benchmark target

The target repos are not committed. Each one is reproducible from its task file's `repo.url` and `repo.commit`. For nest, which the checked-in `.mcp.json` points at:

```bash
git clone https://github.com/nestjs/nest.git benchmarks/target-repo-nest
git -C benchmarks/target-repo-nest checkout 40d07dc62ccb41686859b804f8523ae0e2dd1984
cp benchmarks/tsconfig.rie.nest.json benchmarks/target-repo-nest/tsconfig.rie.json
npm run build
npm run index -- benchmarks/target-repo-nest/tsconfig.rie.json benchmarks/nest-index.db
```

The index takes about 40 s: 1,473 symbols, 3,442 edges and 10,082 references. Until it exists, the MCP server in `.mcp.json` opens an empty database and every query returns nothing. TypeORM works the same way, from `benchmarks/tasks.json`:

```bash
git clone https://github.com/typeorm/typeorm.git benchmarks/target-repo
git -C benchmarks/target-repo checkout 04ff4daedcf60fa4ffd0d5d33bbafaac1a9bbc96
cp benchmarks/tsconfig.rie.typeorm.json benchmarks/target-repo/tsconfig.rie.json
npm run index -- benchmarks/target-repo/tsconfig.rie.json benchmarks/typeorm-index.db
```

TypeORM's own `tsconfig.json` extends `@tsconfig/node20`, which resolves only after TypeORM's `node_modules` is installed. `tsconfig.rie.typeorm.json` inlines those base options and keeps TypeORM's own compiler options unchanged, including `emitDecoratorMetadata`, which decides which imports are erased. It also narrows `include` to `src/`. Indexing with it reproduces the published counts exactly.

The benchmark harness needs the standalone `claude` CLI on `PATH`. If it is installed but a
shell started before it was added to `PATH` cannot see it, the harness falls back to the
standard `~/.local/bin` location; set `RIE_CLAUDE_BIN` to override explicitly. Useful flags:
`npm run bench` takes `--config=nest`, `--tasks=id,id`, `--arms=baseline,assisted`, `--runs=N`, `--skip-build`;
`npm run harness` takes `--config=nest`, `--tools=baseline,rie`, `--category=…`, `--task-ids=id,id`, `--limit=N`, `--runs=N`, `--dry-run`, `--skip-build`.
