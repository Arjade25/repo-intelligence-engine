import ts from "typescript";
import type Database from "better-sqlite3";
import { getTopLevelDeclarations, normalizePath } from "./index.js";

/**
 * Reference indexer (plan §4, mode 2): backs find_symbol_references.
 *
 * findReferences is a LanguageService operation, NOT a Program method — this is
 * why references are a separate pass from the batch indexer. We stand up a
 * ts.LanguageService over a LanguageServiceHost, then call getReferencesAtPosition
 * (or findReferences) for each symbol's declaration position.
 *
 * Build-order step 3 — Done when: references for a known symbol are semantically
 * correct — count is <= a raw grep for the name (grep over-counts comments/strings/
 * shadowed locals) and every returned site is a real use.
 */
export function createLanguageService(fileNames: string[], options: ts.CompilerOptions): ts.LanguageService {
  const files = new Map<string, { version: number }>();
  for (const f of fileNames) files.set(f, { version: 0 });

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: (fileName) => String(files.get(fileName)?.version ?? 0),
    getScriptSnapshot: (fileName) => {
      const text = ts.sys.readFile(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

/**
 * For each top-level declaration, re-find its identifier position (same walk
 * extractSymbols used, via getTopLevelDeclarations), look up the matching symbols
 * row by (name, file_path, line_start), then call findReferences at that position
 * and record every usage site — excluding the declaration's own occurrence, since
 * find_module already covers "where is X declared" and references_ is "where is
 * X used".
 */
export function indexReferences(db: Database.Database, service: ts.LanguageService): void {
  const program = service.getProgram();
  if (!program) return;

  const findSymbolId = db.prepare(
    `SELECT id FROM symbols WHERE name = ? AND file_path = ? AND line_start = ?`
  );
  const insertRef = db.prepare(`INSERT INTO references_ (symbol_id, used_in_file, line) VALUES (?, ?, ?)`);

  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && !program.isSourceFileFromExternalLibrary(sf));

  for (const sourceFile of sourceFiles) {
    const filePath = normalizePath(sourceFile.fileName);

    for (const decl of getTopLevelDeclarations(sourceFile)) {
      const lineStart = sourceFile.getLineAndCharacterOfPosition(decl.node.getStart(sourceFile)).line + 1;
      const symbolRow = findSymbolId.get(decl.name, filePath, lineStart) as { id: number } | undefined;
      if (!symbolRow) continue; // extractSymbols didn't record this - shouldn't happen if run first

      const namePos = decl.nameNode.getStart(sourceFile);
      const referencedSymbols = service.findReferences(sourceFile.fileName, namePos);
      if (!referencedSymbols) continue;

      // findReferences does NOT return one merged group: a named import elsewhere
      // creates a separate "alias" symbol group (definition = the import binding,
      // not our declaration), even for a plain direct import - not just barrels.
      // Take the union of every group's references so cross-file uses aren't
      // dropped, deduped by (file, position), excluding only this declaration's
      // own occurrence (find_module already covers "where is X declared").
      const seen = new Set<string>();
      for (const group of referencedSymbols) {
        for (const ref of group.references) {
          const refFile = normalizePath(ref.fileName);
          if (refFile === filePath && ref.textSpan.start === namePos) continue;

          const key = `${refFile}:${ref.textSpan.start}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const refSourceFile = program.getSourceFile(ref.fileName);
          const line = refSourceFile
            ? refSourceFile.getLineAndCharacterOfPosition(ref.textSpan.start).line + 1
            : null;
          insertRef.run(symbolRow.id, refFile, line);
        }
      }
    }
  }
}
