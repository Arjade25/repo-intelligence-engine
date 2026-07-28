import ts from "typescript";
import type Database from "better-sqlite3";
import { clearIndex } from "../storage/db.js";

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

  const program = createProgramFromTsconfig(tsconfigPath);
  const checker = program.getTypeChecker();

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (program.isSourceFileFromExternalLibrary(sourceFile)) continue;

    extractSymbols(db, sourceFile, checker);
    extractEdges(db, sourceFile, program);
  }
}

/** Load a tsconfig.json and build a Program that honors its options (incl. path aliases). */
function createProgramFromTsconfig(tsconfigPath: string): ts.Program {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    // basePath = the tsconfig's directory
    tsconfigPath.replace(/[^/\\]*$/, "") || "."
  );
  return ts.createProgram(parsed.fileNames, parsed.options);
}

/** TODO(step 1): walk top-level statements, record exported/top-level declarations. */
function extractSymbols(
  _db: Database.Database,
  _sourceFile: ts.SourceFile,
  _checker: ts.TypeChecker
): void {
  // For each class/function/interface/type/const declaration:
  //   - name, kind, file_path, line_start, line_end (via getLineAndCharacterOfPosition)
  //   - INSERT INTO symbols
}

/**
 * TODO(step 1): walk import/export declarations, resolve each module specifier to
 * an absolute path (plan §12 — use ts.resolveModuleName / program resolution so
 * path aliases and barrels resolve), then INSERT INTO edges.
 *   - named imports  -> one edge per name, to_symbol_id set once symbols exist
 *   - side-effect / namespace / bare re-export -> one file->file edge, to_symbol_id NULL
 */
function extractEdges(
  _db: Database.Database,
  _sourceFile: ts.SourceFile,
  _program: ts.Program
): void {
  // resolve specifier -> to_file, then INSERT INTO edges (from_file, to_file, to_symbol_id, 'imports')
}
