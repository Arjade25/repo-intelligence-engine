# Runtime import cycles: what counts

[← RIE Check README](../README.md)

How RIE decides which imports exist at runtime, the basis of every `rie check` result.

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
