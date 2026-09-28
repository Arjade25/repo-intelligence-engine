# Benchmark results — raw data

The JSON files at this level each record one invocation of `benchmarks/run.ts`
(`npm run bench`, hand-written tasks). Each holds every individual run (session id,
tool calls, tokens where recorded, whether the oracle answer was located) plus the
per-arm medians. `harness/` holds the graded, generated-task runs from
`npm run harness`; see [below](#harness--generated-graded-tasks). These are the raw
numbers behind the Benchmark section of the project README. Nothing here is hand-edited.

`.log` files are the console transcript of the same runs and are gitignored — the
JSON is the record of truth.

## TypeORM (current target: 496 source files)

| File | What it measures |
|---|---|
| `2026-08-01T08-38-23-112Z.json` | Single smoke run (1 task, N=1) confirming the harness drove the assisted arm correctly before committing to the full matrix. |
| `2026-08-01T08-54-50-299Z.json` | **First full matrix** — 6 tasks × 2 arms × 5 runs. Showed `driver-impact` regressing (assisted median 5 calls vs. baseline 3, spread up to 11), which transcripts traced to the path-resolution bug. |
| `2026-08-04T18-20-51-467Z.json` | **`driver-impact` re-run after the fix** — same task, 5 runs per arm. Assisted median drops to 2 (baseline 3) and the 3–11 spread collapses to 2–3. This is the row in the README table. |

| `2026-09-10T17-58-30-016Z.json` | Single pass (3 new tasks, N=1) over the "where it does" tasks: `entity-decorator-references`, `mongofindmany-datasource-path`, `runtime-cycle-check`. The first file to record tokens. Superseded by the next file. |
| `2026-09-10T18-37-02-368Z.json` | **The same 3 tasks × 2 arms × 5 runs.** These are the README's "Where it does" rows (7-hop path 21 → 1 calls, cycle check 22 → 1 calls). |

The other five rows in the README's first TypeORM table come from the first full matrix; only
`driver-impact` changed after the fix, and it was re-measured rather than re-derived. The
2026-08 files predate token counting, so they report tool calls only.

## nest (second target: 664 source files, added 2026-09-23)

Run with `npx tsx benchmarks/run.ts --config=nest`. Task set: `benchmarks/tasks-nest.json`.

| File | What it measures |
|---|---|
| `nest-2026-09-22T19-07-13-465Z.json` | Single smoke run (1 task, N=1) confirming the harness drove the new `--config=nest` target correctly before committing to the full matrix. |
| `nest-2026-09-22T19-39-36-345Z.json` | **First full matrix** — 4 tasks × 2 arms × 5 runs. The BASELINE arm here is the record of truth. Its assisted arm is superseded: the nest index was rebuilt mid-run (the `emitDecoratorMetadata` fix), so those assisted numbers are not from a stable index. Baseline never reads the index and is unaffected. |
| `nest-2026-09-22T19-46-46-266Z.json` | **Assisted arm re-run** against the final index, 4 tasks × 5 runs. These are the assisted numbers of record. |

Pairing the baseline from the first file with the assisted from the third is deliberate
and is the only valid combination; both were run against the same target commit and the
same task prompts, and the baseline arm is independent of the index by construction.

Correctness was checked by reading final answers out of the transcripts, not from
`located_oracle`. On `runtime-cycle-check` all 5 assisted runs named 2 groups and all
four distinctive member files; 4 of 5 baseline runs reached the same answer by hand, and
one declined to answer at all. On `parseuuidpipe-exposure` all 10 runs were correct —
that task's grep-hostile premise did not hold and it is retained as a negative result
(see its oracle note in `tasks-nest.json`).

## nestjs-realworld (earlier, discarded target: 35 source files)

Kept deliberately as the record of *why* the target repo changed. This app was too
small for a meaningful comparison — the grep baseline already answered most tasks in
0–2 file-reads, leaving the engine almost no headroom, which is exactly the risk the
project plan flagged ("pick something with enough files/imports that grep-based
baseline is genuinely slow"). The 6-task matrix in
`nestjs-realworld/2026-08-01T07-52-38-034Z.json` is what prompted the move to TypeORM.

## harness/ — generated, graded tasks

Run with `npm run harness -- --config=nest --runs=5`. Each result file sits next to a
`*.tasks.json`, the exact generated task set the run used, so every grade can be
re-checked without re-running `taskgen`. Each result file records per-run transcript
metrics, the final answer text, and the grade, plus summaries by task, category and
arm. Model on every run: `claude-opus-5-5`, Claude Code 2.1.280, target
nestjs/nest @ `40d07dc6`.

| File | What it measures |
|---|---|
| `harness/nest-full-2026-09-27T10-43-36Z.json` | **First full generated-task run.** 27 tasks (8 cycle_trace, 10 runtime_type_trap, 9 change_impact) × 2 arms × 5 runs = 270 sessions, 0 crashed. Baseline 133/135 correct, rie 134/135. Tokens per correct answer: 101,543 baseline vs 112,651 rie. The rie arm called an RIE tool in only 84 of its 135 runs (13 of 45 on change_impact). |
| `harness/nest-paths-2026-09-27T14-57-18Z.json` | **dependency_path category.** 10 tasks (5 with a 12–14-hop path, 5 with no path) × 2 arms × 5 runs = 100 sessions, 0 crashed. Both arms 50/50 correct. Tokens per correct answer: 345,218 baseline vs 164,265 rie. Median tool calls 14 vs 7. |

Wrong answers across both runs (3 of 370 sessions):
- `nest-type-trap-004` baseline: gave no parseable JSON block
- `nest-change-impact-005` baseline: listed one extra file
- `nest-change-impact-007` rie: left out one file

**Provenance note:** `nest-full` records `harness_commit: 22dd96e`, but it was run from a
working tree holding the then-uncommitted changes that became `1c00fcd`. Its task set
carries the `dropped_broken_reexport` statistic, which first exists in `1c00fcd`.
`nest-paths` records `82e7f29`, the commit that added the dependency_path category.
