import ts from "typescript";
import type Database from "better-sqlite3";

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

/** TODO(step 3): for each symbol, look up its declaration position, call the LS, write references_. */
export function indexReferences(_db: Database.Database, _service: ts.LanguageService): void {
  // for each symbol row: service.getReferencesAtPosition(file, pos) -> INSERT INTO references_
}
