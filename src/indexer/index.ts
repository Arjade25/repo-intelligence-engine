import ts from "typescript";
import type Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { clearIndex } from "../storage/db.js";
import { analyzeErasure, reExportHasValueMeaning } from "./erasure.js";

/**
 * Batch indexer (plan §4, mode 1): a one-shot ts.Program walked once to populate
 * `symbols` and `edges`. Stateless and cheap. Reference-finding is NOT here — it
 * needs a LanguageService (mode 2) and lives in indexer/references.ts.
 *
 * Build-order step 1 — Done when: running against one fixed sample file produces
 * symbol/edge counts matching a hand-counted expectation, and at least one
 * barrel/side-effect import appears as a file->file edge with to_symbol_id NULL.
 */
export function indexRepository(db: Database.Database, tsconfigPath: string): void {
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

/** 'imports' covers every named/default/namespace/side-effect edge; 'reexport_star' is `export * from`. */
type EdgeType = "imports" | "reexport_star";

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
    `INSERT INTO edges (from_file, to_file, to_symbol_id, edge_type, is_type_only)
     VALUES (?, ?, ?, ?, ?)`
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
    toFile: string,
    names: ImportedName[],
    clauseTypeOnly: boolean,
    edgeType: EdgeType = "imports"
  ) => {
    if (names.length === 0) {
      // default / namespace / side-effect import, or `export * from`.
      insertEdge.run(fromFile, toFile, null, edgeType, clauseTypeOnly ? 1 : 0);
      return;
    }
    for (const { name, isTypeOnly } of names) {
      const row = findSymbol.get(name, toFile) as { id: number } | undefined;
      insertEdge.run(
        fromFile,
        toFile,
        row ? row.id : null,
        edgeType,
        clauseTypeOnly || isTypeOnly ? 1 : 0
      );
    }
  };

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
      // default imports and namespace imports (`import * as ns`) fall through
      // with no names -> a single NULL edge, same as a side-effect import. A
      // side-effect import (no clause at all) is always retained: running the
      // module IS the point.
      const binding =
        clause?.name ??
        (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)
          ? clause.namedBindings.name
          : undefined);
      const clauseErased =
        clause?.isTypeOnly === true || (binding !== undefined && !erasure.isUsedAsValue(binding));
      writeEdges(toFile, names, clauseErased);
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
            isTypeOnly: el.isTypeOnly || !reExportHasValueMeaning(el, checker),
          });
        }
      }
      // `export * from './x'` (no clause) and `export * as ns from './x'` (a
      // NamespaceExport) both re-export the module wholesale, so they surface
      // every symbol it declares without ever naming one. Tagged distinctly
      // because that makes them un-findable by identifier search - see
      // findSymbolReferences' re_exported_by.
      const isStarReExport = !stmt.exportClause || ts.isNamespaceExport(stmt.exportClause);
      writeEdges(toFile, names, stmt.isTypeOnly, isStarReExport ? "reexport_star" : "imports");
    }
  }
}
