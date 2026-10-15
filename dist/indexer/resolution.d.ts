import ts from "typescript";
/**
 * Input validation: find imports that point INTO the repo (relative, or matching a
 * `paths` alias) but that the compiler cannot resolve.
 *
 * Why this exists: an unresolved internal import doesn't fail loudly anywhere. The
 * edge extractor quietly drops it, and the type-checker reports TS2307 and treats
 * the binding as an error type - so every downstream answer (references, compile
 * impact) is confidently wrong. Found for real on nestjs/nest: every package there
 * is `"type": "module"`, so under module Node16 its imports resolve in ESM mode,
 * where a `paths` alias pointing at a DIRECTORY never resolves. 556 cross-package
 * imports were unresolved and nothing said so.
 *
 * Resolution here uses the per-import resolution mode (ESM vs CJS) the compiler
 * itself uses - a plain ts.resolveModuleName call defaults to CJS mode and would
 * have reported every one of those nest imports as fine.
 */
export interface UnresolvedImport {
    file: string;
    line: number;
    specifier: string;
}
export declare function findUnresolvedInternalImports(program: ts.Program, options?: ts.CompilerOptions): UnresolvedImport[];
/** One-line summary plus a few examples, for CLI output and tool results. */
export declare function describeUnresolved(unresolved: UnresolvedImport[], max?: number): string;
