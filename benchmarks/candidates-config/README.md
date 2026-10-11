# Candidate benchmark targets

Screening configs for repos evaluated as benchmark targets with `npm run screen`.
The clones live in `benchmarks/candidates/` (git-ignored); raw screen output is in
`benchmarks/results/screening/`. Each config keeps the repo's own erasure-relevant
flags (`module`, `moduleResolution`, `isolatedModules`, `emitDecoratorMetadata`,
`preserveConstEnums`, `verbatimModuleSyntax`). It drops only what needs installed
dependencies (`extends` of workspace packages, `types`, build caches) and excludes tests.

## Results (2026-09-29)

"Loop" is the shortest runtime import loop back to a file, in files. A cycle-trace
task is only as hard as that number, because any loop through the start file is
accepted. So it, not the size of the cycle group, decides whether a repo is worth
benchmarking.

| Repo (screened part) | Files | Runtime groups (largest) | Files with no loop < 6 | Longest loop | Type-inclusive groups | Use |
|---|---|---|---|---|---|---|
| **directus** `api/src` | 837 | 5 (**157**) | **94 of 195 (48%)**; 89 of 157 in the largest | **13** | 192, 32, … | Cycle tasks |
| **element-web** `apps/web/src` | 1,434 | 10 (**115**) | **64 of 173 (37%)**; 58 of 115 in the largest | **17** | 644, 14, … | Cycle tasks |
| joplin `packages/lib` | 521 | 6 (13) | 13 of 36; one 13-file ring, every loop exactly 7 | 7 | 218, … | Few distinct cycle tasks |
| TypeScript compiler (v5.9.3) | 77 | 1 (73) | 0; 69 of 73 loop through the barrel in 2 | 3 | 76 | Shows why group size misleads |
| Babylon.js `packages/dev/core` | 2,673 | **0** | – | – | **2,260**, … | Trap tasks |
| pixijs `src` | 716 | **0** | – | – | 227, 16, … | Trap tasks |
| angular `packages/core` | 457 | **0** | – | – | 104, 69, … | Trap tasks / control |
| n8n `packages/cli` | 2,052 | 1 (4) | 0 | 4 | 81, 24, … | Ordinary control |
| outline, app half | 1,211 | 3 (5) | 0 | 4 | 81, 74, … | Ordinary control |
| immich `server/src` | 457 | 2 (2) | 0 | 2 | 94, … | Ordinary control |
| outline, server half | – | – | – | – | – | Out of memory at 12 GB, not screened |

Repos were chosen for screening as large TypeScript codebases (app monorepos and
library cores, roughly 500–3,000 files), then kept or dropped on these numbers. Any
published result has to say so: long-loop repos were selected on purpose, and the
ordinary repos (nest, TypeORM, n8n, outline, immich) are the controls.

## Unresolved imports, and why they don't change the results

- **Babylon.js** (433): shader modules its build generates from `.fx` sources. A
  generated module can only import `Engines/shaderStore`, which imports nothing but an
  enum, so none can sit on a cycle.
- **TypeScript** (1): `diagnosticInformationMap.generated.ts`, created by the build and
  imported once by the barrel. It can't lengthen a 2-file loop.
- **joplin** (1): `../../renderer` points into another workspace package that wasn't
  cloned.
- **element-web** (46) and **pixijs** (48): images and shader sources (`.svg`,
  `.frag`, `.wgsl`). Both unresolved-import checks now ignore asset imports.

Workspace packages imported by package name (e.g. `@n8n/db`) resolve to nothing without
an install, so they count as external. That's fine for screening one package's own
cycles, since workspace dependencies are normally acyclic. It does mean the warning
can't catch a broken package mapping, so check that the screened file count matches
the source tree.

## Configs

| Config | Repo @ commit | Copy to |
|---|---|---|
| `directus-api.tsconfig.rie.json` | directus/directus @ `1694b190` | `directus/api/tsconfig.rie.json` |
| `element-web.tsconfig.rie.json` | element-hq/element-web @ `3af3cbec` | `element-web/apps/web/tsconfig.rie.json` |
| `joplin-lib.tsconfig.rie.json` | laurent22/joplin @ `1499d4f1` | `joplin/packages/lib/tsconfig.rie.json` |
| `typescript-compiler.tsconfig.rie.json` | microsoft/TypeScript @ `v5.9.3` (`c63de15a`) | `typescript/src/compiler/tsconfig.rie.json` |
| `babylon-core.tsconfig.rie.json` | BabylonJS/Babylon.js @ `b1bc84e8` | `babylon/tsconfig.rie.json` |
| `pixijs.tsconfig.rie.json` | pixijs/pixijs @ `ef0c0a79` | `pixijs/tsconfig.rie.json` |
| `angular-core.tsconfig.rie.json` | angular/angular @ `82a4289d` | `angular/packages/tsconfig.rie.json` |
| `n8n-cli.tsconfig.rie.json` | n8n-io/n8n @ `702bb42c` | `n8n/packages/cli/tsconfig.rie.json` |
| `outline.tsconfig.rie.json` (+ `outline-app`, `outline-server`) | outline/outline @ `722098ed` | `outline/tsconfig.rie*.json` |
| `immich-server.tsconfig.rie.json` | immich-app/immich @ `a9d10223` | `immich/server/tsconfig.rie.json` |

Directus's settings come from the npm package `@directus/tsconfig` (`node22`, v4.0.0),
which sets `verbatimModuleSyntax: true`. `microsoft/TypeScript`'s main branch is now
the Go port, so the TypeScript-in-TypeScript compiler is taken from the last 5.x tag.
