import ts from "typescript";
import type Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { clearIndex } from "../storage/db.js";
import { analyzeErasure, reExportHasValueMeaning } from "./erasure.js";
import { findUnresolvedInternalImports, type UnresolvedImport } from "./resolution.js";

/**
 * Batch indexer (plan §4, mode 1): a one-shot ts.Program walked once to populate
 * `symbols` and `edges`. Stateless and cheap. Reference-finding is NOT here — it
 * needs a LanguageService (mode 2) and lives in indexer/references.ts.
 *
 * Build-order step 1 — Done when: running against one fixed sample file produces
 * symbol/edge counts matching a hand-counted expectation, and at least one
 * barrel/side-effect import appears as a file->file edge with to_symbol_id NULL.
 */
export function indexRepository(db: Database.Database, tsconfigPath: string): { unresolved: UnresolvedImport[] } {
  clearIndex(db);

  const { fileNames, options } = loadTsconfig(tsconfigPath);
  const program = ts.createProgram(fileNames, options);
  const checker = program.getTypeChecker();
  const host = ts.createCompilerHost(options);

  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && !program.isSourceFileFromExternalLibrary(sf));

  // Pass 1: symbols for every file, so pass 2's named-import lookups always have
  // something to find regardless of getSourceFiles() iteration order.
  for (const sourceFile of sourceFiles) {
    extractSymbols(db, sourceFile, checker);
  }

  // Pass 2: edges, resolved against the now-complete symbols table.
  for (const sourceFile of sourceFiles) {
    extractEdges(db, sourceFile, program, options, host, checker);
  }

  // Reported, not thrown: a partial index is still useful, but the caller must be
  // able to see that it is partial (see resolution.ts for how this was found).
  return { unresolved: findUnresolvedInternalImports(program, options) };
}

/** Load a tsconfig.json into a fileNames + options pair (incl. path aliases). Shared
 * with indexer/references.ts, which needs the same inputs to stand up a LanguageService
 * over the identical file set. */
export function loadTsconfig(tsconfigPath: string): { fileNames: string[]; options: ts.CompilerOptions } {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  // basePath must be ABSOLUTE: with a relative basePath (e.g. when a caller
  // passes "./tsconfig.json", as the MCP server's RIE_TSCONFIG default does),
  // parseJsonConfigFileContent can emit relative fileNames, which would then be
  // stored as-is - producing an index whose paths never match one built from an
  // absolute tsconfig path. Everything stored must be cwd-independent.
  const basePath = resolve(dirname(tsconfigPath));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, basePath);
  return { fileNames: parsed.fileNames, options: parsed.options };
}

/** Normalize path separators so from_file/to_file join cleanly across platforms. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

const SYMBOL_KINDS = ["class", "function", "interface", "type", "const"] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

export interface TopLevelDeclaration {
  name: string;
  kind: SymbolKind;
  /** The declaration's name identifier — the position findReferences needs, not the whole node. */
  nameNode: ts.Identifier;
  /** The whole declaration node — used for the symbol's line_start/line_end span. */
  node: ts.Node;
}

/**
 * Walk a file's top-level statements and list its class/function/interface/type/const
 * declarations. Shared by extractSymbols (below) and indexer/references.ts, so both
 * agree on exactly what counts as an indexable top-level symbol.
 */
export function getTopLevelDeclarations(sourceFile: ts.SourceFile): TopLevelDeclaration[] {
  const results: TopLevelDeclaration[] = [];

  for (const stmt of sourceFile.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      results.push({ name: stmt.name.text, kind: "class", nameNode: stmt.name, node: stmt });
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      results.push({ name: stmt.name.text, kind: "function", nameNode: stmt.name, node: stmt });
    } else if (ts.isInterfaceDeclaration(stmt)) {
      results.push({ name: stmt.name.text, kind: "interface", nameNode: stmt.name, node: stmt });
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      results.push({ name: stmt.name.text, kind: "type", nameNode: stmt.name, node: stmt });
    } else if (ts.isVariableStatement(stmt)) {
      const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
      if (!isConst) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          results.push({ name: decl.name.text, kind: "const", nameNode: decl.name, node: decl });
        }
      }
    }
  }

  return results;
}

/** One name pulled in by an import/re-export, with its own inline `type` modifier. */
interface ImportedName {
  name: string;
  isTypeOnly: boolean;
}

/**
 * 'imports' covers every named/default/namespace/side-effect edge; 'reexport_star'
 * is `export * from`; 'require' is a bare top-level `require("./x")` call.
 */
type EdgeType = "imports" | "reexport_star" | "require";

/** Walk top-level statements, recording exported/top-level declarations. */
function extractSymbols(db: Database.Database, sourceFile: ts.SourceFile, _checker: ts.TypeChecker): void {
  const insert = db.prepare(
    `INSERT INTO symbols (name, kind, file_path, line_start, line_end) VALUES (?, ?, ?, ?, ?)`
  );
  const filePath = normalizePath(sourceFile.fileName);

  for (const decl of getTopLevelDeclarations(sourceFile)) {
    const start = sourceFile.getLineAndCharacterOfPosition(decl.node.getStart(sourceFile)).line + 1;
    const end = sourceFile.getLineAndCharacterOfPosition(decl.node.getEnd()).line + 1;
    insert.run(decl.name, decl.kind, filePath, start, end);
  }
}

/**
 * Walk import/export declarations, resolve each module specifier to an absolute
 * path (plan §12 — ts.resolveModuleName against the program's compiler options,
 * so path aliases and barrels resolve), then INSERT INTO edges.
 *   - named imports/re-exports -> one edge per name, to_symbol_id set if a symbol
 *     row (name, resolved_file) exists
 *   - side-effect / namespace / default / `export * from` -> one file->file edge,
 *     to_symbol_id NULL
 *   - `export * from` additionally gets edge_type 'reexport_star' rather than
 *     'imports', so it can be told apart from the other NULL-symbol edges
 *   - a bare top-level `require("./x")` call -> one file->file edge, edge_type
 *     'require', never type-only
 */
function extractEdges(
  db: Database.Database,
  sourceFile: ts.SourceFile,
  program: ts.Program,
  options: ts.CompilerOptions,
  host: ts.CompilerHost,
  checker: ts.TypeChecker
): void {
  const insertEdge = db.prepare(
    `INSERT INTO edges (from_file, to_file, to_symbol_id, edge_type, is_type_only, line, statement, imported_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const findSymbol = db.prepare(`SELECT id FROM symbols WHERE name = ? AND file_path = ?`);

  const fromFile = normalizePath(sourceFile.fileName);
  // One traversal per file, shared by every import statement in it.
  const erasure = analyzeErasure(sourceFile, checker, options);

  const resolveSpecifier = (moduleSpecifier: ts.Expression): string | undefined => {
    if (!ts.isStringLiteral(moduleSpecifier)) return undefined;
    const resolved = ts.resolveModuleName(moduleSpecifier.text, sourceFile.fileName, options, host);
    if (!resolved.resolvedModule) return undefined;
    // External packages (node_modules) aren't part of the repo's own structural
    // graph - indexRepository already excludes them from the file-walk via
    // isSourceFileFromExternalLibrary; treat them the same way here so edges don't
    // point into node_modules whenever a consuming repo happens to have it installed.
    if (resolved.resolvedModule.isExternalLibraryImport) return undefined;
    return normalizePath(resolved.resolvedModule.resolvedFileName);
  };

  /**
   * Type-only-ness is decided per edge, not per statement: `import { type A, b }`
   * is one statement carrying one erased edge and one real one. `clauseTypeOnly`
   * (from `import type { ... }`) applies to every name in the statement; a name's
   * own inline `type` modifier applies to just that one.
   */
  const writeEdges = (
    source: ts.Node,
    toFile: string,
    names: ImportedName[],
    clauseTypeOnly: boolean,
    edgeType: EdgeType = "imports"
  ) => {
    const line = sourceFile.getLineAndCharacterOfPosition(source.getStart(sourceFile)).line + 1;
    const statement = statementText(source, sourceFile);
    if (names.length === 0) {
      // default / namespace / side-effect import, or `export * from`.
      insertEdge.run(fromFile, toFile, null, edgeType, clauseTypeOnly ? 1 : 0, line, statement, null);
      return;
    }
    for (const { name, isTypeOnly } of names) {
      const row = findSymbol.get(name, toFile) as { id: number } | undefined;
      insertEdge.run(
        fromFile,
        toFile,
        row ? row.id : null,
        edgeType,
        clauseTypeOnly || isTypeOnly ? 1 : 0,
        line,
        statement,
        name
      );
    }
  };

  /**
   * Under verbatimModuleSyntax the compiler keeps every import/export declaration
   * that lacks a top-level `type`, dropping only its inline-`type` names:
   * `import { type T } from "./m"` emits `import {} from "./m"`, and
   * `export { type T } from "./m"` emits `export {} from "./m"` - both still load
   * the module (checked against tsc 5.9 emit). Without the flag the statement is
   * elided. Per-name edges alone would all be type-only here, hiding a runtime
   * edge the emitted-JS oracle found twice on directus; this adds the side-effect
   * edge the emit actually has.
   */
  const keptAsSideEffect = (names: ImportedName[]): boolean =>
    options.verbatimModuleSyntax === true && names.length > 0 && names.every((n) => n.isTypeOnly);

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const toFile = resolveSpecifier(stmt.moduleSpecifier);
      if (!toFile) continue; // unresolvable (e.g. bare external package) - skip for v1

      const names: ImportedName[] = [];
      const clause = stmt.importClause;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          names.push({
            name: (el.propertyName ?? el.name).text,
            // Erased if the source said so, or if nothing in this file ever uses
            // the local binding as a value.
            isTypeOnly: el.isTypeOnly || !erasure.isUsedAsValue(el.name),
          });
        }
      }
      // Every binding gets its own edge and its own erasure verdict. The compiler
      // keeps the statement if ANY binding is used as a value, so one binding's
      // verdict must never stand in for another's: `import Def, { val }` with Def
      // used only as a type once marked val's edge erased too, and
      // `import Def, { Shape }` with Def a value recorded only Shape's erased edge -
      // both hid a runtime edge that tsc emits as require("./m").
      // A default import is recorded under the name "default"; a namespace import
      // (`import * as ns`) names nothing. A side-effect import (no clause at all)
      // is always retained: running the module IS the point.
      const clauseTypeOnly = clause?.isTypeOnly === true;
      if (clause?.name) {
        names.push({ name: "default", isTypeOnly: !erasure.isUsedAsValue(clause.name) });
      }
      const namespace =
        clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.name : undefined;
      if (namespace) writeEdges(stmt, toFile, [], clauseTypeOnly || !erasure.isUsedAsValue(namespace));
      if (names.length > 0 || !namespace) writeEdges(stmt, toFile, names, clauseTypeOnly);
      if (!clauseTypeOnly && keptAsSideEffect(names)) writeEdges(stmt, toFile, [], false);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
      const toFile = resolveSpecifier(stmt.moduleSpecifier);
      if (!toFile) continue;

      const names: ImportedName[] = [];
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          names.push({
            name: (el.propertyName ?? el.name).text,
            // A re-export binds no local name, so there is no local use to
            // inspect - what survives is decided by the re-exported symbol's
            // own meaning in the module it came from.
            isTypeOnly: el.isTypeOnly || !reExportHasValueMeaning(el, checker, options),
          });
        }
      }
      // `export * from './x'` (no clause) and `export * as ns from './x'` (a
      // NamespaceExport) both re-export the module wholesale, so they surface
      // every symbol it declares without ever naming one. Tagged distinctly
      // because that makes them un-findable by identifier search - see
      // findSymbolReferences' re_exported_by.
      const isStarReExport = !stmt.exportClause || ts.isNamespaceExport(stmt.exportClause);
      writeEdges(stmt, toFile, names, stmt.isTypeOnly, isStarReExport ? "reexport_star" : "imports");
      if (!stmt.isTypeOnly && keptAsSideEffect(names)) writeEdges(stmt, toFile, [], false);
    } else if (ts.isImportEqualsDeclaration(stmt)) {
      // `import x = require("./mod")` is a distinct AST node from ImportDeclaration
      // (not `import { x } from ...` syntax), and was previously not walked here at
      // all - every such statement produced zero edges, regardless of runtime use.
      // `import x = SomeNamespace.Member` (no module specifier, an EntityName
      // reference) is the other legal form; it names no module, so there is nothing
      // to resolve.
      const ref = stmt.moduleReference;
      if (!ts.isExternalModuleReference(ref)) continue;
      const toFile = resolveSpecifier(ref.expression);
      if (!toFile) continue;

      // Binds a single whole-module name, like a namespace import - erasure is
      // decided the same way: the explicit keyword, or whether `stmt.name` is ever
      // used from a value position (confirmed against real emit: an import-equals
      // whose binding goes entirely unused is dropped from the compiled output).
      const erased = stmt.isTypeOnly || !erasure.isUsedAsValue(stmt.name);
      writeEdges(stmt, toFile, [], erased);
    }
  }

  // Bare `require("./x")` calls are expressions, not statements, so the loop above
  // never sees them - yet the compiler keeps every one. Missed for real on TypeORM
  // (src/cli-ts-node-esm.ts loads ./cli via a require() inside an `if`), the one
  // edge the emitted-JS oracle found in the dangerous direction. Never erased.
  for (const specifier of findTopLevelRequireCalls(sourceFile)) {
    const toFile = resolveSpecifier(specifier);
    if (toFile) writeEdges(specifier.parent, toFile, [], false, "require");
  }
}

/** Longest statement text stored per edge - enough for any ordinary import line. */
const MAX_STATEMENT_CHARS = 200;

/** A statement's source text on one line (multi-line import lists collapsed), truncated. */
function statementText(node: ts.Node, sourceFile: ts.SourceFile): string {
  const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
  return text.length > MAX_STATEMENT_CHARS ? `${text.slice(0, MAX_STATEMENT_CHARS - 1)}…` : text;
}

/**
 * Every `require("literal")` call that runs when the module loads - i.e. not
 * nested inside a function, method, accessor, constructor or static block. A
 * require() inside a function is a lazy load: it can't take part in an
 * initialization cycle, and counting it would also turn every downleveled dynamic
 * `import()` (`Promise.resolve().then(() => require(X))`) into a hard edge. This is
 * the same boundary rule benchmarks/oracle/emitted-edges.ts applies to emitted
 * JS; the two are kept separate on purpose so the oracle can catch bugs here.
 */
export function findTopLevelRequireCalls(sourceFile: ts.SourceFile): ts.StringLiteral[] {
  const out: ts.StringLiteral[] = [];

  const isFunctionBoundary = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassStaticBlockDeclaration(node);

  const visit = (node: ts.Node): void => {
    if (isFunctionBoundary(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return out;
}
