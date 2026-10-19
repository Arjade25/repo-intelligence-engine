# RIE Check

**Fail a pull request that makes your TypeScript runtime import cycles worse, and show the import line behind every loop.** RIE Check compares the PR's runtime import graph with its base branch's. It uses the TypeScript compiler's own resolution and erasure rules, so type-only imports don't count, and cycles already on the base branch never fail a PR.

```bash
npx rie-check --pr=tsconfig.json --base-ref=origin/main
```

The check uses no model and gives the same answer every time. An optional, experimental agent can explain what it finds ([below](#explaining-findings-experimental)).

## Why another cycle checker

Most cycle checkers tell you a cycle exists. RIE Check reports which cycle changed and how, and its answer matches the compiled JavaScript. The test: 59 commits of element-web's history, each labelled by compiling the commit and its parent.

| element-web, 59 commits | Regressions caught (of 21) | False alarms | Cycle change matches the compiled code |
|---|---|---|---|
| **RIE Check** | **21** | **0** | **59 of 59** |
| madge | 20 | 0 | 35 of 59 |
| dpdm (`-T`) | 20 | 2 | 30 of 58* |
| eslint-plugin-import `no-cycle` | 21 | 8 | – (it reports imports, not cycles) |

\* dpdm and `no-cycle` skipped one commit whose parent isn't in the shallow benchmark clone. Its label is no change, so it doesn't affect the regression or false-alarm counts.

- **madge** counts dynamic `import()` and imports used only as types, so its cycle groups are too big. It reported a cycle change that doesn't match the compiled code in 24 of 59 commits, mostly the right event with the wrong files. It also failed all 10 seeded PRs that add an import used only as a type; RIE Check failed none.
- **dpdm** drops type-only imports but still counts dynamic `import()`. It raised 2 false alarms and got the cycle change wrong in 28 of 58 commits.
- **eslint `no-cycle`** catches every regression, but it reports only some of a file's imports into a cycle, and which ones depends on import order. A PR that only moves those reports around therefore fails. It failed 6 PRs whose cycles didn't get worse, and 2 that should only have warned.

On directus (40 commits), RIE Check caught 23 of 23 regressions with no false alarms and matched the compiled code on all 40. madge caught 23, one of them only as a warning, and matched on 19. The method, per-commit results and each tool's misses are in [docs/evaluation.md](docs/evaluation.md).

## What a failing PR looks like

element-web's developers had kept the room-list store out of the app's large import cycle by loading it with a dynamic `import()`. Commit `526b4b8c33` added a static import of it in `InviteDialog.tsx`, which pulls the store and 9 more files into the cycle. madge reports no change. RIE Check fails it with this report (the two longest lines shortened):

```
rie check: FAIL

FAIL  cycle_grown: cycle of 126 files grew to 136
  joined: src/stores/room-list-v3/RoomListStoreV3.ts, src/stores/room-list-v3/section.ts, … (10 files)
  loop (6 files): src/components/views/dialogs/InviteDialog.tsx -> src/stores/room-list-v3/RoomListStoreV3.ts -> …
    src/components/views/dialogs/InviteDialog.tsx:29  import RoomListStoreV3 from "../../../stores/room-list-v3/RoomListStoreV3";  (runtime: default)
    src/stores/room-list-v3/RoomListStoreV3.ts:22     import SpaceStore from "../spaces/SpaceStore";  (runtime: default)
    src/stores/spaces/SpaceStore.ts:38                import { TAG_ORDER } from "../../components/views/rooms/LegacyRoomList";  (runtime: TAG_ORDER)
    src/components/views/rooms/LegacyRoomList.tsx:52  import { shouldShowSpaceInvite, showAddExistingRooms, showCreateNewRoom, showSpaceInvite, } from "../../../utils/space.tsx";  (runtime: …)
    src/utils/space.tsx:20                            import { showRoomInviteDialog } from "../RoomInvite";  (runtime: showRoomInviteDialog)
    src/RoomInvite.tsx:16                             import InviteDialog from "./components/views/dialogs/InviteDialog";  (runtime: default)
```

Each line of the loop is one import, with the names it brings in at runtime. The first is the one this PR added. The PR comment the Action posts, including the agent's explanation, is in [`benchmarks/results/demo/element-web-526b4b8c33/rie-comment.md`](benchmarks/results/demo/element-web-526b4b8c33/rie-comment.md). eslint `no-cycle` and dpdm also flag this commit; madge is the one that misses it.

## Use it

### In GitHub Actions

Run it after your dependency install, because deciding which imports are erased needs every import resolved:

```yaml
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  rie-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # the merge base must be in the clone
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - uses: Arjade25/repo-intelligence-engine@v0
        with:
          tsconfig: tsconfig.json
```

| Input | Default | |
|---|---|---|
| `tsconfig` | `tsconfig.json` | The tsconfig to check, relative to the repo root |
| `base-ref` | the PR's base branch | Compare with the merge base of this ref |
| `outcomes` | none | Per-repo overrides, e.g. `cycle_grown:warn` |
| `fail-on` | `fail` | `warn` fails the job on warnings too |
| `comment` | `auto` | `always` also comments on a first pass; `never` writes only the job summary |
| `explain` | `false` | Experimental: `true` runs the investigation agent on each fail or warn finding ([below](#explaining-findings-experimental)) |
| `anthropic-api-key` | none | The agent's key, e.g. `${{ secrets.ANTHROPIC_API_KEY }}`; without one, nothing is explained |
| `explain-max` | `3` | Findings explained per run |
| `explain-budget-usd` | `0.5` | Spend cap per finding, retry included |
| `explain-model` | `claude-opus-5-5` | The agent's model |

Outputs are `outcome` (`fail`, `warn` or `pass`) and `report`, the path of the JSON result. It uses the runner's Node, 22 or later, and doesn't change it for later steps. A PR from a fork gets a read-only token, so it can't comment, and the report stays in the job summary. `.github/workflows/rie-check.yml` runs the action on this repo's own PRs. Its first local run found a 2-file runtime cycle already on `main`, `src/indexer/index.ts` ↔ `src/indexer/resolution.ts`, which passed because old cycles never fail a PR. The PR that removed it reported `cycle_resolved`, and the repo now has no runtime cycles.

The Action runs the check on a pull request, writes the report to the job summary, and fails the job on a fail outcome. On a fail or warn it posts a PR comment, which later pushes update in place. A pass doesn't get a new comment, but it does update an existing one, so a fixed PR shows it's fixed.

### From the command line

It needs Node 22 or later, and nothing to configure beyond a tsconfig:

```bash
npx rie-check --pr=tsconfig.json --base-ref=origin/main   # this branch against its merge base
npx rie-check --pr=<tsconfig> --base=<tsconfig>           # two checkouts you already have
npx rie-check tsconfig.json                               # one snapshot: every cycle group and a shortest loop
```

Once installed (`npm install -D rie-check`), the same commands are also `rie check`. `rie index` and `rie mcp` run the engine underneath ([docs/engine.md](docs/engine.md)).

## How it works

RIE Check indexes both snapshots with the TypeScript compiler and compares their runtime cycle groups. A group is a set of files that all reach each other through imports that survive compilation. Groups are matched by the files they share, after renamed files are mapped through git's rename detection.

| Event | What changed between base and PR | Default outcome |
|---|---|---|
| `new_cycle` | A group appears whose files were in no cycle on base | fail |
| `cycle_grown` | An existing group gains files | fail |
| `cycles_merged` | Two or more base groups become one | fail |
| `loop_shortened` | No file joins or leaves, but a new import makes a shorter loop through some file | warn |
| `cycle_split` | A group becomes two or more smaller ones, and no file joins | pass |
| `cycle_shrunk` | Files leave a group that still exists | pass |
| `cycle_resolved` | A base group no longer exists | pass |
| `no_regression` | Nothing above fired | pass |

A PR's outcome is its strictest event's. Old cycles never fail a PR: directus's 157-file group fails only a PR that changes it for the worse. Type-only imports and dynamic `import()` don't count, and barrel re-exports do. Each fail or warn event shows its evidence. For each import the PR added inside a group, the report gives the shortest loop that uses it, with the line, statement and runtime names behind each hop:

```
rie check: FAIL

FAIL  new_cycle: new runtime cycle of 2 files
  joined: src/e.ts, src/f.ts
  loop (2 files): src/e.ts -> src/f.ts -> src/e.ts
    src/e.ts:1  import { f } from "./f.js";  (runtime: f)
    src/f.ts:1  import { e } from "./e.js";  (runtime: e)
```

With `--base-ref`, the base is the merge base of that ref and `HEAD`, checked out into a temporary git worktree. The PR checkout's `node_modules` is linked into it, because erasure needs imports resolved. `--json` prints the full result, and `--outcome=cycle_grown:warn` overrides an outcome for a repo. The exit code is 1 on fail and 0 on warn or pass. A setup problem exits 2 with one line on stderr: a tsconfig that's missing or isn't valid JSON, a tsconfig with no files (a solution-style one gets the list of its referenced tsconfigs to pass instead), or a base ref with no merge base (fetch it with its history). Any other error TypeScript reports in the tsconfig, such as an `extends` from a package that isn't installed, becomes a warning, because the compiler options may be incomplete. The rules are pinned down as 16 test cases in `src/check/cycle-events.cases.ts`, each checked against a real tsc emit. On nest, the single-snapshot listing finds the same two 4-file groups as the emit oracle, in about 10 s.

## Explaining findings (experimental)

With `explain: true` and an Anthropic API key, an agent explains each fail or warn finding in the PR comment, under "Explanation (verified facts)" and "Suggestions (not verified)". The check alone decides the outcome.

- **Verified facts.** A verifier checks every import the agent cites against the import graph, with no model. A draft that fails twice is dropped, and the comment then shows only the check's own findings.
- **Results.** Over 192 sessions on real findings, 98% were posted, none citing an import the compiled code doesn't have, at a median $0.09 and 19 s each.
- **Why experimental.** Only the facts are checked: the prose can overstate, and the largest findings can exceed the spend cap.
- **Install.** The Claude Agent SDK it needs is an optional dependency, installed only when `explain` is on.

Details and the evaluation: [docs/agent-evaluation.md](docs/agent-evaluation.md).

## Limits

- **TypeScript projects and runtime import cycles only.** It doesn't check other architecture rules, and it has been tested only on TypeScript projects.
- **It uses its own TypeScript (5.9), not your repo's.** A tsconfig option newer than that is reported as a warning.
- **Dependencies must be installed** for erasure to come out right. Imports that don't resolve are listed in a warning, with file and line, because the graph may be missing edges.
- **The evaluation favors repos with long cycles.** element-web and directus were chosen because their cycles are large and change often. RIE Check has also run on 9 tsconfigs from 8 other repos ([docs/evaluation.md](docs/evaluation.md#other-repos-each-ones-own-tsconfig)), but not on their history.
- **It indexes both snapshots on every PR.** That took 36–76 s on immich's server (677 files) and 68 s on element-web (about 1,400 files). Larger repos take longer; indexing n8n's 3,900-file CLI package once took 137 s.

## More

| Doc | What's in it |
|---|---|
| [docs/evaluation.md](docs/evaluation.md) | The history replay against compiler-backed labels, the four-tool comparison, seeded cases, and runs on other repos |
| [docs/runtime-cycles.md](docs/runtime-cycles.md) | How RIE decides which imports exist at runtime: erasure, `verbatimModuleSyntax`, decorator metadata, star re-exports, unresolved imports |
| [docs/agent-evaluation.md](docs/agent-evaluation.md) | The explaining agent and its 192-session evaluation |
| [docs/engine.md](docs/engine.md) | The engine underneath: the index, its queries and the MCP server for coding agents |
| [docs/agent-benchmark.md](docs/agent-benchmark.md) | Where the project started: does the engine make coding agents cheaper? Including where it doesn't |
| [docs/development.md](docs/development.md) | Building, the test suite (418 tests), releases and benchmark targets |

## License

MIT. See [LICENSE](LICENSE).
