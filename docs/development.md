# Development

[← RIE Check README](../README.md)

## Test suite

`npm test` runs **418 tests in 23 files, all passing, plus 22 skipped** (vitest, 2026-10-14). The skipped ones are oracle checks that apply only to some cycle event cases. The tests run against small fixture repos under `fixtures/`: sample, type-only, decorator-metadata, verbatim-module-syntax, const-enum, esm-alias and taskgen. The cycle event cases and the git test write their own repos to a temp directory. None of the tests needs a cloned benchmark target.

| File | Covers | Tests |
|---|---|---|
| `src/engine/index.test.ts` | All six queries, explicit not-found results, path normalization and suffix matching, ambiguity notes, runtime vs type-only cycles, file-path and runtime-only `dependency_path`, `find_cycle_through_file` and per-hop evidence for both | 55 |
| `src/indexer/index.test.ts` | Symbols, file-level edges, NULL-symbol edges, per-edge erasure, bare `require()`, const enums, decorator metadata; tsconfigs that are missing, malformed, solution-style or have their own errors | 58 |
| `benchmarks/oracle/emitted-edges.test.ts` | Emit-based ground truth, including dynamic `import()`, NodeNext, bare `require()`, const enums, decorator metadata (incl. parameter decorators on an undecorated class or method, and shorthand properties), unresolved internal imports | 38 |
| `benchmarks/taskgen/generate.test.ts` | Every task category, `--min-path`, broken re-export filter, determinism for a given seed, trap direction grading | 25 |
| `benchmarks/oracle/cycle-events.test.ts` | The `rie check` cycle event cases against tsc emit: groups, traps, evidence lines, shortest loops, every new edge cited | 90 (+22 that don't apply to every case) |
| `benchmarks/harness/harness.test.ts` | Prompt building, answer parsing, grading (incl. monorepo git-root paths), summaries, `--resume`, the spend stop, the consecutive-failure stop, turn-capped sessions, cost estimates, arm reuse, per-arm CLI settings for bash-madge, answer-leakage audit (stub agent) | 29 |
| `src/check/cycle-events.test.ts` | `rie check` against every cycle event case: events, outcome and evidence (incl. which hops the PR added); per-repo outcome overrides | 17 |
| `src/agent/finding.test.ts` | The investigation agent's finding format: facts from a `rie check` event, refusals (a suggestion marked verified, extra fields, loops that don't chain or close, non-JSON) | 4 |
| `src/agent/verify.test.ts` | The verifier: every real `rie check` finding verifies (incl. renames and barrels); fabricated facts are refused with a reason (wrong line, misquoted statement, missing import, a loop through a type-only import labelled either way, a wrong added-in-PR claim, a loop the PR didn't touch, wrong event, unknown file) | 16 |
| `src/agent/runtime.test.ts` | The agent runtime, with the SDK's `query` stubbed (no model): the tool gate (read-only rie tools, Read only on the finding's and diff's files, the tool-call cap), the session's isolation and caps, the finding schema it asks for, that every draft is verified (verified, rejected with reasons, spend stop, incl. one the SDK raises, time stop), long diffs trimmed to the finding's files, and the revise loop (one retry in the same session with the verifier's reasons, inside what's left of the caps; a second rejection or no draft falls back to rie check's own facts) | 16 |
| `src/agent/pr.test.ts` | The agent on a PR: only fail and warn findings are explained, up to the limit; an agent that throws leaves the check's facts; the comment puts the check's loops first, then "Explanation (verified facts)", then "Suggestions (not verified)", shows none of the agent's text without a verified finding, and escapes HTML and @-mentions | 8 |
| `benchmarks/agent-eval/score.test.ts` | Agent evaluation scoring: hops re-checked against the emit oracle (missing imports, wrong added-in-PR, renames), usefulness by file name, trap citations, the summary counts | 6 |
| `src/check/git.test.ts` | `--base-ref`: merge base, renames from git, worktree and link cleanup; relative tsconfig paths; runtime names in the report | 3 |
| `src/check/report.test.ts` | The PR comment: marker, event table strictest first, loops for fail and warn only, caps on long lists | 3 |
| `benchmarks/replay/replay.test.ts` | Replay on a 4-commit repo: three-way comparison, unchanged commits, dynamic `import()` (madge disagrees), scoring; seeded cases of all three kinds; dpdm and `no-cycle` (scored by added reports) merged into an earlier run's records | 5 |
| `benchmarks/replay/mine.test.ts` | Mining finds exactly the cycle-changing commits without computing every commit | 1 |
| `src/mcp-server/index.test.ts` | Each MCP tool's result equals the direct engine call; `reindex` takes no arguments | 10 |
| `src/indexer/erasure.test.ts` | Value-position analysis, `verbatimModuleSyntax` gate | 8 |
| `benchmarks/oracle/tarjan.test.ts` | Independent SCC implementation | 6 |
| `benchmarks/oracle/loops.test.ts` | Shortest loop through each cycle member (`npm run screen`) | 6 |
| `src/indexer/resolution.test.ts` | Unresolved internal import detection (ESM directory aliases, bare `require()`, asset imports ignored) | 5 |
| `src/indexer/references.test.ts` | `findReferences` union across alias groups; regular and `const` enums as symbols, with every use and re-export | 7 |
| `src/engine/reindex.test.ts` | A full rebuild is idempotent and reflects added and removed files | 2 |

## Development

```bash
npm install
npm run build           # tsc -> dist/
npm run index -- ./tsconfig.json repo-index.db   # index a repo
npm run mcp             # start the MCP server (stdio)
npm run check -- --pr=tsconfig.json --base-ref=origin/main   # rie check: does this branch make import cycles worse?
npm test                # vitest
npm run bench           # benchmark harness (spawns Claude Code per run)
npm run oracle -- <path-to-tsconfig.json>   # diff RIE's runtime edges against a real tsc emit
npm run screen -- <path-to-tsconfig.json>   # how hard would this repo's cycle tasks be? (no agents, no index)
npm run taskgen -- --config=nest            # generate graded tasks -> benchmarks/generated/nest.json
npm run harness -- --config=nest --runs=5   # run them per tool arm, grade, and summarize
```

The npm package is `rie-check`: `npx rie-check --pr=tsconfig.json --base-ref=origin/main` runs the check. Installed, the same commands are one `rie` command: `rie check`, `rie index`, `rie mcp` (also `rie-check` and `rie-mcp`). It needs Node 22 or later; `better-sqlite3` has prebuilt binaries for Node 22 to 26, so installing compiles nothing.

**Releases.** Bump `version` in `package.json`, then push a matching tag (`git tag v0.2.0 && git push origin v0.2.0`). `.github/workflows/release.yml` tests and builds it, pushes Action refs with `dist/` built in (`v0.2.0-action`, and `v0`, which moves to the latest 0.x release), and publishes to npm by trusted publishing: no token is stored, npm trusts this workflow through GitHub's OIDC identity (set on the package's npmjs.com settings), and the package gets provenance. A version already on npm is skipped. An Action ref with `dist/` installs only runtime dependencies, and the Agent SDK only when `explain` is on.

`npm run harness` runs every generated task as a fresh headless Claude Code session per tool arm, with the identical prompt, model, repo checkout and built-in Read/Grep/Glob. Arms differ only in the one MCP server they load, listed in `benchmarks/tools.json` (`baseline` loads none). Each prompt ends with a fixed instruction to answer in a JSON block. Only that block is graded, by the task's validator, and a reply without one is scored wrong rather than guessed at. Arm order rotates across runs, and a crashed run counts as a wrong answer, not a missing one. Reported per task, category and arm: accuracy, **tokens per correct answer** (all tokens spent ÷ correct answers), median tokens with IQR, tool calls and wall time. Tokens are the primary cost measure rather than dollars, because the token count doesn't depend on cache hits. Results keep every run's transcript metrics, final text and grade in `benchmarks/results/harness/`. `--dry-run` prints the exact agent commands without launching anything. Claude Code exposes no temperature setting, so variance between runs is measured rather than controlled.

`npm run taskgen` builds benchmark tasks from compiler ground truth, never from RIE's index: cycle tracing (graded by a validator that accepts any runtime cycle through the start file), dependency paths ("can you get from A to B by following imports?": half are chains of at least `--min-hops` hops, default 5, and any valid chain is accepted; half have no path, even though A transitively imports at least `--min-closure` files, default 25, and B sits next door and usually reaches A; answering "no" means ruling out that whole set), runtime-vs-type traps (yes/no pairs, where every "no" is a cycle that only closes through an erased import, and a "no" must also name the direction with no runtime path; on a repo with no runtime cycles every trap is a "no", so yes/no alone would give a blanket "no" full marks), and change impact (the answer comes from actually removing the export in memory and re-type-checking). A task is dropped when it hinges on fewer than `--min-path` files (default 4; a task file can set `taskgen.min_path`, and nest uses 3 because its only runtime cycles are 3-file loops). A change-impact task is also dropped when a broken named re-export (`export { X } from`) shields importers: TypeScript's error recovery still resolves `X` through the broken line, so those importers compile, which no reader of the source would predict. Every prompt states its scope (only the files the tsconfig includes), since the ground truth covers nothing else. Generation refuses to run if any internal import fails to resolve under the compiler's own ESM/CJS resolution mode (`--allow-unresolved` overrides): such an import is a baseline type error, so the impact oracle can't see anything break through it. On nest, directory-style `paths` aliases in `"type": "module"` packages caused exactly this, hiding every cross-package file. `reindex` reports the same check, and the harness won't benchmark against a partial index. Each task carries difficulty tags (SCC size, path length, barrels, aliases, type-only distractors) and the tsconfig flags it was generated under. Output is deterministic for a given `--seed`.

`npm run oracle` is the reusable form of the manual validation described above under "Checking it edge by edge": it compiles the target repo for real (`benchmarks/oracle/emitted-edges.ts`), reads which imports actually survive into emitted output, and diffs that against RIE's own index — printing the same agree / safe-over-report / dangerous-hidden-edge breakdown, plus an SCC comparison. The ground-truth side (`emitted-edges.ts` and its own `tarjan.ts`) shares no code with `src/indexer` or `src/engine`, by design: it's the check that would catch a bug in either. Only the comparison script, `compare.ts`, imports the engine, because the engine is what it diffs against. It exits 1 if any real runtime edge is reported as erased.

`npm run screen` decides whether a repo is worth benchmarking before any agent runs. It compiles the repo with the oracle and reports, for each runtime cycle group, the shortest loop back to each file. A cycle-trace task accepts any loop through its start file, so that shortest loop, not the group's size, is what makes the task hard. The TypeScript compiler shows the difference: a 73-file group in which 69 files loop back through one barrel in 2 steps. It also flags internal imports that don't resolve, since those make a repo look less tangled than it is. Ten candidate repos were screened on 2026-09-29. Two have long loops: directus (a 157-file group, 57% of whose files have no loop shorter than 6) and element-web (115 files, 50%). The full table, configs and caveats are in [`benchmarks/candidates-config/`](../benchmarks/candidates-config/README.md).

### Setting up a benchmark target

The target repos are not committed. Each one is reproducible from its task file's `repo.url` and `repo.commit`. For nest, which the checked-in `.mcp.json` points at:

```bash
git clone https://github.com/nestjs/nest.git benchmarks/target-repo-nest
git -C benchmarks/target-repo-nest checkout 40d07dc62ccb41686859b804f8523ae0e2dd1984
cp benchmarks/tsconfig.rie.nest.json benchmarks/target-repo-nest/tsconfig.rie.json
npm run build
npm run index -- benchmarks/target-repo-nest/tsconfig.rie.json benchmarks/nest-index.db
```

The index takes about 40 s: 1,507 symbols, 3,442 edges and 10,857 references. Until it exists, the MCP server in `.mcp.json` opens an empty database and every query returns nothing. TypeORM works the same way, from `benchmarks/tasks.json`:

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
`npm run harness` takes `--config=nest`, `--tools=baseline,rie`, `--category=…`, `--task-ids=id,id`, `--limit=N`, `--runs=N`, `--dry-run`, `--skip-build`, `--resume=<results>`.

Spending controls for the harness. Before launching, it prints an estimated cost per arm from the mean cost of past sessions on the same repo and category.

- `--max-spend=USD` stops launching once this invocation has spent that much. The results file is marked `stopped_early`, and `--resume` finishes it.
- `--max-failures=N` (default 3, `0` turns it off) stops after N failed sessions in a row, with the reason `consecutive_failures`. Spend can't detect a usage limit, because every launch then exits 1 at no cost. On 10-07 that recorded 167 failed sessions before anything noticed. A failed launch now also reports whatever the CLI printed on stdout.
- `--pilot` runs each task once, to catch a prompt or grader bug before the full run. Its results are named `<repo>-pilot-*`. The default is 3 runs per task; use `--runs=5` only for numbers you publish.
- `--reuse=baseline=<results.json>` uses an unchanged arm's sessions from an earlier run instead of paying for new ones. It is refused if any session is missing or any task's prompt changed since that run, and `meta.reused` records the source and its CLI version.
- `--max-turns=N` caps each session (default 150, about twice the most any session has used; `0` turns it off). A capped session counts as wrong and is reported in its own `capped` column, so a cap that is too tight shows up instead of quietly favoring the cheaper arm.
