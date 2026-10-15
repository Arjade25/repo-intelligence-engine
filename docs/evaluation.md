# Evaluating rie check

[← RIE Check README](../README.md)

How `rie check` was tested: replayed against real history with compiler-backed labels, compared with madge, dpdm and eslint-plugin-import's `no-cycle`, and run on other repos.

## History replay: element-web and directus

`npm run replay` replays real history the way `rie check` sees a PR. It compares each commit with its first parent three ways: RIE, madge (configured as in the bash-madge arm, restricted to the tsconfig's files), and the emit oracle, which compiles both snapshots and supplies the labels. The same event rules apply to all three graphs, so any disagreement comes from the graph. Measured on element-web `apps/web` on 2026-10-11, between the `apps/web` move (`91a3cb03c1`, 2026-02-24) and the benchmark commit `3af3cbec`. That stretch is 1,555 first-parent commits.

- **Finding the positives.** Most commits change no runtime cycle. `--mine` compares the oracle's cycle signature (groups and each member's shortest loop) every 25 commits and bisects wherever two differ. It found the **40 commits that change runtime cycles**, using 207 oracle runs instead of 1,555. It uses only the oracle, so which commits were picked owes nothing to RIE. 32 of the 40 fire an event; the other 8 only lengthen a loop or rename a member.
- **Negatives.** These are 20 random commits from the same stretch (seed 1) and the 20 commits before `3af3cbec`.
- **Seeds.** `--seed` adds one-line "PRs" at `3af3cbec` on 10 file pairs picked from the oracle's graph. Each pair gets three kinds: a runtime import that closes a loop, an `import type` of the same file, and a plain import used only as a type.

| | Commits | Label fail/warn | RIE caught | madge caught | RIE false alarms | madge false alarms | Exact events, RIE | Exact events, madge |
|---|---|---|---|---|---|---|---|---|
| History (mined + random + recent) | 59 compared, 21 unchanged | 21 | **21** | 20 | 0 | 0 | **59 of 59** | 35 of 59 |
| Seeds: import closing a loop | 10 | 10 | **10** | **10** | 0 | 0 | **10 of 10** | 5 of 10 |
| Seeds: `import type` | 10 | 0 | – | – | 0 | 0 | 10 of 10 | 10 of 10 |
| Seeds: import used only as a type | 10 | 0 | – | – | **0** | **10** | 10 of 10 | 0 of 10 |

The labelled events in history were 16 `cycle_grown`, 8 `cycle_shrunk`, 7 `cycle_resolved`, 2 `cycles_merged`, 2 `loop_shortened`, 1 `cycle_split` and 1 `new_cycle`. RIE's runtime edges matched the oracle's exactly at every compared commit: none were extra and none were missing. No commit was skipped.

**What madge gets wrong, and why.** madge counts dynamic `import()` and imports used only in type positions, so its runtime groups are inflated. Its largest element-web group has 158 files, where the compiled code has 115. In one seeded merge it reported a 423-file group where the real one has 93. It usually still names the right event, which is why it caught 30 of 31 regressions overall. But its file lists are wrong in 24 of 59 history commits, and it raised false alarms on all 10 imports used only as types.

**The commit madge missed is the best demo.** `StoresApi.ts` loads the room-list store with a dynamic `import()`, "to prevent circular dependency issues". Its developers kept those files out of the cycle on purpose. Commit `526b4b8c33`, "Room list: remove usage of old room list store…", adds a static `import RoomListStoreV3` at `InviteDialog.tsx:29`. That pulls 10 room-list-v3 files into the runtime cycle, which grows from 126 to 136 files. RIE and the oracle report `cycle_grown`, and RIE gives the loop: `InviteDialog` → `RoomListStoreV3` → `SpaceStore` → `LegacyRoomList` → `utils/space` → `RoomInvite` → `InviteDialog`, with the line of each import. madge reports no change, because it had counted the dynamic import all along.

`npm run demo` reruns this one commit as a PR. It checks out `526b4b8c33` and its parent into temporary worktrees of the element-web clone and runs all three tools on the pair. It writes the `rie check` report, the PR comment the Action would post and a JSON summary to `benchmarks/results/demo/element-web-526b4b8c33/`. On the 2026-10-12 run, RIE and the oracle both reported `cycle_grown` (126 → 136 files). madge passed: all 10 files that joined were already in its 195-file group on the parent. `--repo`, `--commit` and `--tsconfig` point it at any other commit.

**directus** (`api/`, the 1,500 first-parent commits up to the benchmark commit `1694b190`, from 2024-08-30 to 2026-09-25) was replayed the same way. Mining found **26 commits that change runtime cycles**, using 178 oracle runs, and the replay added 20 random commits and the 20 most recent. directus compiles with `verbatimModuleSyntax`, which keeps a plain import even when it's used only as a type. So here the third kind of seed is a real runtime import, and the oracle labels it fail.

| directus | Commits | Label fail/warn | RIE caught | madge caught | RIE false alarms | madge false alarms | Exact events, RIE | Exact events, madge |
|---|---|---|---|---|---|---|---|---|
| History (mined + random + recent) | 40 compared, 26 unchanged | 23 | **23** | 23 (one as warn) | 0 | 0 | **40 of 40** | 19 of 40 |
| Seeds: import closing a loop | 10 | 10 | **10** | 9 | 0 | 0 | **10 of 10** | 5 of 10 |
| Seeds: `import type` | 10 | 0 | – | – | 0 | 0 | 10 of 10 | 10 of 10 |
| Seeds: plain import used only as a type (kept under `verbatimModuleSyntax`) | 10 | 10 | **10** | 9 | 0 | 0 | **10 of 10** | 5 of 10 |

The labelled events were 20 `cycle_grown`, 2 `new_cycle`, 1 `cycle_shrunk` and 1 `loop_shortened`. RIE's runtime edges again matched the oracle's exactly at every compared commit. madge's largest directus group has 224 files, where the compiled code has 157, and that gap explains both of its misses:
- **A seed it missed.** `services/tus/data-store.ts` is already inside madge's inflated group, so a real import that pulls it into the cycle (157 → 158 files) reads to madge as no change.
- **A failure it downgraded.** Commit `dfc8797d5f` grows the real cycle, which is a fail. madge reports only `loop_shortened`, a warn.

**Run time.** Each repo's 20 most recent commits ran with nothing else on the machine:

| Repo | RIE (median per commit) | madge (median per commit) | Oracle (per snapshot) |
|---|---|---|---|
| element-web | 11.3 s | 23.0 s | about 33 s |
| directus | 6.0 s | 10.9 s | about 15 s |

The other runs shared the CPU between two checkouts, so their timings aren't comparable.

**dpdm and eslint-plugin-import's `no-cycle`** were run on the same element-web commits on 2026-10-13 (`--tools=dpdm,eslint`; `--summarize` merges them into the earlier runs' records):
- **dpdm** runs with `-T`, as its README suggests: it transpiles each file first, so type-only imports drop out. Dynamic `import()` still counts, which is its default. It gives a graph, so it's scored like madge.
- **`no-cycle`** runs with the TypeScript resolver on the same tsconfig, and inline `eslint-disable` comments are ignored (`benchmarks/replay/eslint-no-cycle.config.mjs`). It doesn't give a graph. The rule shares one set of visited modules across all the imports of a file. Once one import's search has visited a module, the file's later imports skip it, so only some of a file's imports into a cycle are reported, and which ones depends on import order. At element-web's benchmark commit it reported 252 imports across at most 26 files, where the compiled code has 115 in its largest cycle. So it is scored the way a team would gate a PR with it: the PR fails when it has a reported import that the base didn't. It has no warn level and no groups, so there is no exact-events score for it.

| element-web | Commits | RIE caught | madge caught | dpdm caught | no-cycle caught | False alarms (RIE / madge / dpdm / no-cycle) | Exact events (RIE / madge / dpdm) |
|---|---|---|---|---|---|---|---|
| History (mined + random + recent) | 59 compared (58 for dpdm and no-cycle) | **21 of 21** | 20 | 20 | 21 | **0** / 0 / 2 / 8 | **59 of 59** / 35 of 59 / 30 of 58 |

- **dpdm** missed `a26eb9f578` and reported `526b4b8c33`, the demo commit, as a warn instead of a fail. It raised false alarms on `1c66f0ba01` and `1963f268aa`, where the compiled code's cycles don't change. Its largest group has 146 to 529 files, where the compiled code has 103 to 137. Of its 28 inexact commits, 20 have the right event with the wrong files, 4 the wrong event and 4 the wrong outcome. (madge: 22, 1 and 1.)
- **`no-cycle`** caught every regression, `526b4b8c33` included. It failed 6 commits whose runtime cycles didn't get worse, for example `3e77974fa0`, where the cycle shrank. Those commits only moved which imports get reported. It also failed 2 `loop_shortened` commits that the label marks as a warn.
- **Run time**, median per commit in this run: dpdm 37 s, `no-cycle` 101 s.

The last pilot commit, `3af3cbec98`, has no parent in the shallow benchmark clone, so dpdm and `no-cycle` skipped it. Its label is no change. The element-web seeds and directus weren't run with dpdm and `no-cycle`.

**Limits.** Dependencies aren't installed at each commit, the same as in the benchmark runs: workspace packages and `matrix-js-sdk` count as external on all three sides. On directus the same `tsconfig.rie.json` is used at every commit, including the older ones. The miner can miss a change that is undone within 25 commits. The labels come from the same event rules applied to the oracle's graph, so the event rules themselves are checked separately by the 16 fixture cases. The whole replay calls no model and costs no tokens. Results are in `benchmarks/results/replay/`. To summarize them, run `npm run replay -- --summarize=<files>`.

## Other repos: each one's own tsconfig

On 2026-10-14, `rie check` in single-snapshot mode ran on 9 tsconfigs from 8 repos outside the replay, each the repo's own config, not one written for the benchmark. The clones are sparse and shallow, and no dependencies were installed, so imports of packages, generated files and files outside the checkout don't resolve. The warning names each one.

| tsconfig | Files | What it tests | Time | Cycle groups | Unresolved internal imports |
|---|---|---|---|---|---|
| outline `tsconfig.json` | 2,221 | path aliases | 49 s | 7 | 1 (outside the checkout) |
| immich `server/tsconfig.json` | 677 | path aliases | 16 s | 4 | 0 |
| joplin `packages/lib/tsconfig.json` | 727 | `extends` a local file | 11 s | 6 | 2 (outside the checkout) |
| pixijs `tsconfig.json` | 946 | path aliases | 24 s | 0 | 74 (a test-utils alias outside the checkout) |
| n8n `packages/cli/tsconfig.json` | 3,898 | `extends` 2 configs from an uninstalled package; project references | 137 s | 1 | 1 (a JSON import) |
| TypeScript `src/compiler/tsconfig.json` | 77 | project references; one large namespace barrel | 15 s | 1 | 1 (a generated file) |
| TypeScript `src/tsconfig.json` | 0 | solution-style: `files: []` plus 13 references | – | – | – |
| babylon `tsconfig.json` | 4,650 | 67 path aliases | 91 s | 2 | 588 (generated shader files) |
| angular `packages/tsconfig.json` | 781 | path aliases; an option from a newer TypeScript | 24 s | 0 | 299 (mostly `rxjs`, not installed) |

None crashed. The run found 4 problems, all fixed:
- **A missing or malformed tsconfig was indexed as an empty graph.** With no files there are no cycles, so every PR would pass. Now it's an error.
- **The solution-style tsconfig was checked as 0 files**, with no warning. Now it's an error that lists the 13 referenced tsconfigs.
- **n8n's two missing `extends` were ignored**, so the check ran without the options they set. Now they're a warning.
- **On Windows, a malformed tsconfig passed with a backslash path** made TypeScript fail an internal assertion ("Debug Failure") instead of reporting the JSON error. Paths are now normalized first.

RIE uses its own TypeScript (5.9), not the repo's. A tsconfig option newer than that, like angular's `stableTypeOrdering`, shows up as a warning. Clean installs from the packed package were checked on Windows only.

**PR mode on immich, with its dependencies installed.** Setup:
- A partial clone (full history, file contents on demand), with `server/` and the pnpm workspace packages checked out.
- `pnpm install --filter immich... --ignore-scripts`: 1,257 packages in 64 s.
- `rie check --pr=server/tsconfig.json --base-ref=<parent>`, the Action's code path, run on 5 real merged PRs that touched `server/src`.

Results:
- **Real PRs:** all 5 passed in 36–76 s with no warnings. Every internal import resolved on both sides, so linking the PR's `node_modules` into the base worktree works with pnpm's symlinked layout.
- **Planted regression:** on `main`, one added `import 'src/services/album.service.js'` in `src/utils/date.ts` failed in 37 s as `cycles_merged` (two groups into one of 62 files), with the 2-file loop and the PR comment the Action would post. Clean `main` passed.
- **Two missed runtime imports, now fixed.** The emit oracle on that checkout agreed on the cycle groups, but found 5 runtime imports that RIE had marked erased. This is the dangerous direction, since a missed runtime edge can hide a cycle. There were two causes:
  - **A decorated parameter on an undecorated class.** One decorated constructor parameter (immich's NestJS `BaseModule` has only `@Inject(IWorker)`) makes the compiler emit `design:paramtypes` for every parameter. RIE only counted that when the class itself was decorated. The same applies to methods.
  - **A shorthand property.** An import used only as `{ extraModels }` was read as a declaration, not a use.

  Both are fixtures now, checked against real emit. After the fix, RIE and the oracle agree on all 2,870 import pairs.
