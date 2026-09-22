# Benchmark results — raw data

Each JSON is one invocation of `benchmarks/run.ts`, recording every individual run
(session id, file-reads, tool-calls, whether the oracle answer was located) plus the
per-arm medians. These are the raw numbers behind the before/after table in the
project README. Nothing here is hand-edited.

`.log` files are the console transcript of the same runs and are gitignored — the
JSON is the record of truth.

## TypeORM (current target: 496 source files)

| File | What it measures |
|---|---|
| `2026-08-01T08-38-23-112Z.json` | Single smoke run (1 task, N=1) confirming the harness drove the assisted arm correctly before committing to the full matrix. |
| `2026-08-01T08-54-50-299Z.json` | **First full matrix** — 6 tasks × 2 arms × 5 runs. Showed `driver-impact` regressing (assisted median 5 calls vs. baseline 3, spread up to 11), which transcripts traced to the path-resolution bug. |
| `2026-08-04T18-20-51-467Z.json` | **`driver-impact` re-run after the fix** — same task, 5 runs per arm. Assisted median drops to 2 (baseline 3) and the 3–11 spread collapses to 2–3. This is the row in the README table. |

The README's other five rows come from the first full matrix; only `driver-impact`
changed after the fix, and it was re-measured rather than re-derived.

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
baseline is genuinely slow"). The 6-task matrix here
(`2026-08-01T07-52-38-034Z.json`) is what prompted the move to TypeORM.
