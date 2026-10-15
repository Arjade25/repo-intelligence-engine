# Benchmark: does the engine help coding agents?

[← RIE Check README](../README.md)

The project's first question, measured before `rie check` existed: does a coding agent with the engine's MCP tools answer import-graph questions more cheaply than one using Read/Grep or madge? The answer depended on the task. The detection work this forced is in [runtime-cycles.md](runtime-cycles.md).


Every measurement below runs Claude Code in headless mode under two arms:

- **baseline**: built-in tools only (Read/Grep/Glob)
- **assisted** (called `rie` in the generated-task harness): the same tools **plus** this engine's MCP server
- **bash-madge** (long-loop cycle tasks only): the same tools **plus** Bash, with [madge](https://github.com/pahen/madge), the common circular-dependency CLI, on PATH. This is what a developer with a shell would reach for, so it is the fair competitor. See [benchmarks/tools.json](../benchmarks/tools.json).

Protocol: a fresh session for every run, so no run sees another's context. 5 runs per arm per task, with medians reported. Metrics are machine-counted from session transcripts (`tool_use` blocks and per-turn token usage), never hand-tallied. The only difference between the arms is `--mcp-config`; both get the same built-in toolset.

There are two harnesses. They answer different questions:

| | `npm run bench` (`benchmarks/run.ts`) | `npm run harness` (`benchmarks/harness/`) |
|---|---|---|
| Tasks | Hand-written, with pre-registered oracle answers verified by independent grep | Generated from compiler ground truth (`npm run taskgen`), never from RIE's index |
| Correctness | `located_oracle` substring check, plus reading transcripts by hand | Graded: the last JSON block of each answer is scored by the task's validator |
| Targets | TypeORM, nest | nest, directus, element-web |
| Raw data | `benchmarks/results/*.json` | `benchmarks/results/harness/*.json`, with the exact task set alongside as `*.tasks.json` |

## At a glance

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
| directus · runtime-vs-type traps vs **Bash + madge** | 10 × 5 | 50/50, $0.139 / 66 s per session | **50/50, $0.058 / 16 s** | ~2.4× cheaper in dollars, ~4× faster; RIE cost more before its runtime-only `dependency_path` |

## Hand-written tasks: TypeORM

Measured against [TypeORM](https://github.com/typeorm/typeorm) @ `04ff4dae`: 496 source files, 1,108 indexed symbols, 2,750 import edges. Nine fixed navigation tasks (`benchmarks/tasks.json`). These counts were re-verified on 2026-09-28 by re-indexing with the now-committed `benchmarks/tsconfig.rie.typeorm.json`. That also gives 1,565 erased edges, 189 star re-exports and 13,517 references, 0 unresolved imports, and 0 runtime cycles (227 + 2 files with type-only edges counted). The benchmark runs below used that index. Since then, the indexer also records bare `require()` calls and matches the compiler's erasure in three more cases (see [Checking it edge by edge](runtime-cycles.md#checking-it-edge-by-edge)). The current index has 2,751 edges, 1,568 of them erased; the star re-exports and cycle results are unchanged. Indexing enums as symbols (see [What it does](engine.md#what-it-does)) later added 1 symbol and raised references to 13,655; edges are unaffected.

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

Baseline cost varies widely from run to run (15–24 calls on the path task, 14–29 on the cycle task), so these ratios are measured medians, not guarantees.

**Metric caveat:** the harness also records `located_oracle`, a substring check for an oracle filename in the final answer. It is a smoke detector, not a grader. It reads `false` for a perfectly correct answer that never restates the filename — which happens when the prompt itself already names the file — and for correct answers to questions whose oracle names no file at all, like the cycle task. Treat calls and tokens as the measurements; read transcripts to judge correctness.

**† What the benchmark caught:** the first measurement of the impact task showed the assisted arm *losing* (median 5 calls vs. 3, spread up to 11). Transcripts revealed an interface bug, not a data bug: the engine's path-taking tools did exact string matching, so the Windows-style backslash and repo-relative paths agents naturally pass returned empty results — and one tool answered *"symbol not indexed"* when only the path filter had failed. Agents did the rational thing and fell back to grep, doubling the work. After fixing path resolution (normalization + unique-suffix matching + honest "filter dropped" notes), the task flipped to a win and run-to-run variance collapsed from 3–11 calls to 2–3. The raw per-run data for both measurements is in `benchmarks/results/`.

**‡ A task that failed, kept deliberately.** The reference-count task was designed as a trap: `grep -w Entity` returns 684 hits across 72 files — ~114x the 6 real references — because `Entity` is TypeORM's ubiquitous generic type-parameter name (`Repository<Entity>`, `QueryBuilder<Entity>`). Neither arm fell for it. Both immediately grepped `Entity\(` with the paren, which is highly discriminating for a callable, and collapsed 684 hits to ~7 files in a single call. The task is retained as a negative result, because it marks the boundary of the claim above: name-overcount is only grep-hostile for symbols used in *type position*, where a usage is a bare name indistinguishable from a type parameter. For functions and decorators, `Name(` and `@Name` hand grep a precise handle. An earlier N=1 measurement of this task showed the assisted arm losing badly (18 calls vs 13); at N=5 that reversed to a slight win. Both readings were mostly noise — the baseline arm alone moved from 13 calls to a median of 6 between runs, and the baseline never touches the MCP server.

## Hand-written tasks: nest

Measured against [nestjs/nest](https://github.com/nestjs/nest) @ `40d07dc6`: 664 non-spec source files, 1,473 indexed symbols, 3,442 file-level edges. (Indexing enums later raised the symbol count to 1,507; the edges are unchanged.) Four tasks (`benchmarks/tasks-nest.json`), 5 runs per arm. Medians:

| Task | Baseline (calls / tokens) | Assisted (calls / tokens) | |
|---|---|---|---|
| Impact: who imports `Injector`? | **5 / 82,321** | 5 / 120,202 | Assisted uses ~46% more tokens |
| Import path `ClientProxyFactory` → `NestContainer` | 10 / 156,786 | **6 / 79,238** | ~2× fewer tokens |
| Is `ParseUUIDPipe` public API, and how? | **4 / 40,497** | 5 / 68,074 | Negative result, kept |
| Are there any runtime import cycles? | 44 / 6,317,943 | **3 / 58,832** | ~107× fewer tokens |

The cycle question again separates the two arms most. It also separates them on answer quality, not just cost. All 5 assisted runs named both 4-file runtime cycle groups and all four distinctive member files. The baseline read its way to the same answer in 4 of 5 runs, spending 6.3M tokens per run at the median; in the fifth run it declined to answer. The two import-impact and public-API questions went the other way: a grep for the class name or its import line answers them directly, and the MCP arm paid for tool calls that added nothing. On `ParseUUIDPipe`, all 10 runs were correct, and the task's grep-hostile premise did not hold (see its oracle note in `tasks-nest.json`).

The baseline figures are from `nest-2026-09-22T19-39-36-345Z.json`. The assisted figures are from the re-run `nest-2026-09-22T19-46-46-266Z.json`, because the nest index was rebuilt partway through the first run. [`benchmarks/results/README.md`](../benchmarks/results/README.md) explains the pairing.

## Generated, graded tasks: nest

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

## Generated, graded tasks: long-loop repos (directus, element-web)

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

**The first version lost.** On 09-29 the engine cost ~1.6× the baseline. Its cycle report ran to ~25K characters and stayed in context for the rest of the session. It also couldn't answer "a loop through file X", so agents grepped anyway. [Circular dependency detection](runtime-cycles.md#circular-dependency-detection) describes the fixes, and each one was re-measured:
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

The one wrong madge answer is partly the task's fault. The agent followed a dynamic `import("../stores/room-list-v3/RoomListStoreV3")` in `StoresApi.ts`. element-web's developers added it there, by their own comment, "to prevent circular dependency issues": it loads lazily, after the importing file has finished loading, so it isn't a load-time cycle, and the grader is right to reject it. But the cycle-task prompt never said dynamic `import()` calls don't count, while the path-task prompt did. madge includes them in its graph, so the ambiguity worked against it. Scored strictly, madge got 49/50, or 50/50 if this ambiguous task is excluded. Newly generated cycle and trap prompts now state the rule. The grader also used to blame the wrong step here (`EventTileFactory → Api`, a real import), because it only knows the start file's cycle group. It now reports that `src/modules/Api.ts` is outside the group instead.

**Runtime-vs-type traps on directus: RIE lost, then won once `dependency_path` went runtime-only.** Each trap task names two files in the 192-file type-inclusive group and asks whether each reaches the other through runtime imports. The answer is no in at least one direction, because the obvious chain runs through an import TypeScript erases.

| Run | Arm | Correct | Cost per session | Median wall time | Median calls | Tokens per correct | Median tokens [IQR] |
|---|---|---|---|---|---|---|---|
| directus, 10-07 (before) | bash-madge | 20/20 | $0.133 | | | | |
| | rie | 20/20 | $0.190 | | | | |
| directus, 10-09 (runtime-only `dependency_path`) | bash-madge | 50/50 | $0.139 | 66 s | 5 | 148K | 121K [83–186K] |
| | rie | 50/50 | **$0.058** | **16 s** | **3** | 56K | 57K [37–68K] |

On 10-07, `dependency_path` had no runtime-only mode and no per-hop evidence, so RIE agents had to check each hop by hand, and RIE cost ~1.4× madge. That run (`directus-2026-10-07T06-39-49-828Z`) also had dependency-path tasks. It stopped when the usage limit ran out, and only 20 of each arm's 50 trap sessions launched, so its row compares those 20. The fix added `runtime_only`, which follows only imports that survive compilation and reports `type_only_path_exists` when the runtime path is missing. Every hop now carries its import line, statement and runtime names. The 10-09 rerun (`directus-2026-10-09T07-44-00-492Z`, Claude Code 2.1.295) ran only the trap tasks, RIE and bash-madge interleaved. Its audit flagged 4 bash-madge sessions that loaded the TypeScript compiler from this project's `node_modules`, since the directus checkout has none installed. None touched an answer file, and all 4 answered correctly.

**How to read these numbers:**
- **Dollars and wall time are the headline, not tokens.** Most of the baseline's tokens are its growing context re-read from cache on every turn, and cache reads are cheap. The token ratios (~8× on directus, ~31× on element-web) overstate the real saving by 2–4×.
- **The baseline has Read, Grep and Glob only.** It has no shell, so it can't run `madge --circular` or `tsc`, which a developer would reach for. Against that baseline the engine is ~4–8× cheaper. Against the bash-madge arm it is ~2.7× cheaper on directus and ~2.5× on element-web, and ~5× faster on both. Those are the numbers to quote.
- **No session reached the answers.** Target repos sit inside this project, a few folders below the generated tasks and their expected answers. `npm run audit` scans every session's tool calls for paths outside the target checkout, or any reference to the answer files. It found nothing in all 550 long-loop sessions, and each results file carries its `meta.audit` record.
- **The tasks fit the tool.** `find_cycle_through_file` was built after these tasks exposed the gap, and it answers exactly their question. The trap tasks above are the first other category run on these repos, and only on directus. The directus dependency-path tasks are still incomplete: the 10-07 run stopped before half of its sessions launched.
- **The one-time index build isn't counted.** It takes a few minutes on element-web, before any session starts.

## Overall reading

This is not "faster than grep." Where a name search can answer the question directly, the engine is a wash or a cost:
- TypeORM's single-symbol lookups
- nest's generated cycle, trap and impact tasks, where the assisted arm spent ~11% more tokens per correct answer
- nest's hand-written impact and public-API questions, where it spent ~46% and ~68% more tokens

The large, repeatable wins all come from multi-hop and whole-graph questions, the two things text search structurally cannot do:
- long import paths: ~15× fewer tokens on TypeORM, and ~3.2× on nest paths that exist
- runtime-cycle detection over a whole repo: ~46× fewer tokens on TypeORM, and ~107× on nest
- tracing a cycle through a given file in repos with long loops: ~4× cheaper in dollars on directus and ~8× on element-web than a Read/Grep agent. Against an agent with a shell and madge it was ~2.5–2.7× cheaper and ~5× faster on both repos. All at equal or better accuracy (see the caveats [above](#generated-graded-tasks-long-loop-repos-directus-element-web)).

In the 370 graded nest sessions, accuracy was essentially the same in both arms (183/185 baseline, 184/185 assisted). In the 550 long-loop sessions, every arm answered every cycle task correctly except one bash-madge session, which followed a dynamic `import()` that the cycle prompt hadn't yet ruled out. On these tasks, the engine changes what a correct answer costs, not whether the agent finds it.
