import ts from "typescript";
/**
 * Value-position analysis: does an import binding survive into the emitted JS?
 *
 * `is_type_only` used to mean "the source wrote the `type` keyword". That is a
 * proxy, not the rule. TypeScript erases an import whose bindings are used only
 * in type position regardless of the keyword, so a codebase that writes plain
 * `import { Foo }` for pure types (nestjs/nest does, ~89% of its statements) had
 * every one of those edges counted as a runtime edge - which is what made
 * findCircularDependencies over-report nest's runtime cycles 7 vs a measured 3.
 *
 * So the question this module answers is the emitter's question: is any binding
 * of this import ever referenced from a value position in this file?
 *
 * One wrinkle the position rules alone get wrong: with `emitDecoratorMetadata`, a
 * *decorated* declaration's parameter/property/return types are re-emitted as
 * `design:paramtypes`/`design:type` metadata, so those imports survive despite only
 * ever appearing in type position. An edge-level diff against emitted output found
 * exactly 3 such cases in nestjs/nest, all `@Injectable()` classes taking a
 * constructor dependency - and this is the dangerous direction, since a missed
 * runtime edge can hide a real cycle. So metadata positions count as value uses
 * when the option is on - but only the one name the compiler serializes, and only
 * when it names a value (see metadataEntityName).
 *
 * A `const enum` is inlined, so its import vanishes from the emitted JS even though
 * the source uses it as a value - most of nest's 29 safe-direction over-reports.
 * The rule mirrors the checker's own (markAliasReferenced / isAliasResolvedToValue)
 * and was checked against real emit under each flag (fixtures/const-enum-repo):
 *   - a value use keeps the import only under `isolatedModules`
 *   - an export (`export { E }`, `export { E } from`) keeps it under
 *     `isolatedModules` or `preserveConstEnums`
 * Only a symbol that IS a const enum counts; a namespace holding only const enums
 * (which the compiler also inlines) is still treated as a value - the safe direction.
 *
 * `verbatimModuleSyntax` (and its two deprecated predecessors,
 * `importsNotUsedAsValues: "preserve"|"error"` and `preserveValueImports`) turn off
 * value-position elision entirely: under these flags the compiler keeps every
 * import/re-export except the ones explicitly marked with the `type` modifier,
 * regardless of how (or whether) the binding is used in the file. Running
 * value-position analysis anyway is the DANGEROUS direction - it would erase a
 * plain `import { Foo }` used only in type position that the compiler actually
 * emits, hiding a real runtime cycle. So `isErasureDisabledByFlag` gates both this
 * module's own walk and `reExportHasValueMeaning` below; callers still apply the
 * explicit `type` keyword themselves (index.ts already does, per edge/clause).
 */
export interface ErasureAnalysis {
    /** True if `declarationName` (an import/default/namespace binding) is referenced
     *  from at least one value position in the file it was declared in. */
    isUsedAsValue(declarationName: ts.Identifier): boolean;
}
/** True when the compiler options tell TypeScript to stop eliding imports based on
 *  usage and keep everything but what's explicitly marked `type`. */
export declare function isErasureDisabledByFlag(options: ts.CompilerOptions): boolean;
export declare function analyzeErasure(sourceFile: ts.SourceFile, checker: ts.TypeChecker, options?: ts.CompilerOptions): ErasureAnalysis;
/**
 * `export { A } from './x'` names nothing locally, so there is no use to analyze -
 * what decides it is whether A is a value in the module it comes from. Same
 * verbatimModuleSyntax-family gate as analyzeErasure: under those flags the
 * re-export is kept regardless of A's meaning, unless explicitly marked `type`.
 */
export declare function reExportHasValueMeaning(specifier: ts.ExportSpecifier, checker: ts.TypeChecker, options?: ts.CompilerOptions): boolean;
