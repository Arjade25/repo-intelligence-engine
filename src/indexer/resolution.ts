import ts from "typescript";
import { normalizePath } from "./index.js";

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

export function findUnresolvedInternalImports(
  program: ts.Program,
  options: ts.CompilerOptions = program.getCompilerOptions()
): UnresolvedImport[] {
  const host = ts.createCompilerHost(options);
  const aliasPatterns = Object.keys(options.paths ?? {}).map((key) => {
    const star = key.indexOf("*");
    return star === -1 ? { prefix: key, suffix: "", exact: true } : { prefix: key.slice(0, star), suffix: key.slice(star + 1), exact: false };
  });
  const isInternal = (spec: string) =>
    spec.startsWith(".") ||
    aliasPatterns.some((p) =>
      p.exact ? spec === p.prefix : spec.length >= p.prefix.length + p.suffix.length && spec.startsWith(p.prefix) && spec.endsWith(p.suffix)
    );

  const out: UnresolvedImport[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || program.isSourceFileFromExternalLibrary(sf)) continue;
    for (const spec of moduleSpecifiers(sf)) {
      if (!isInternal(spec.text)) continue;
      const mode = ts.getModeForUsageLocation(sf, spec, options);
      const resolved = ts.resolveModuleName(spec.text, sf.fileName, options, host, undefined, undefined, mode);
      if (resolved.resolvedModule) continue;
      out.push({
        file: normalizePath(sf.fileName),
        line: sf.getLineAndCharacterOfPosition(spec.getStart(sf)).line + 1,
        specifier: spec.text,
      });
    }
  }
  return out;
}

/** One-line summary plus a few examples, for CLI output and tool results. */
export function describeUnresolved(unresolved: UnresolvedImport[], max = 5): string {
  const examples = unresolved.slice(0, max).map((u) => `  ${u.file}:${u.line}  '${u.specifier}'`);
  const more = unresolved.length > max ? [`  ... and ${unresolved.length - max} more`] : [];
  return [
    `${unresolved.length} internal import(s) do not resolve under the compiler's own module resolution. ` +
      `References and type-check results through them are wrong, and edges may be missing. Check the tsconfig's paths/moduleResolution.`,
    ...examples,
    ...more,
  ].join("\n");
}

function moduleSpecifiers(sf: ts.SourceFile): ts.StringLiteral[] {
  const out: ts.StringLiteral[] = [];
  for (const stmt of sf.statements) {
    if ((ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      out.push(stmt.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(stmt) &&
      ts.isExternalModuleReference(stmt.moduleReference) &&
      ts.isStringLiteral(stmt.moduleReference.expression)
    ) {
      out.push(stmt.moduleReference.expression);
    }
  }
  return out;
}
