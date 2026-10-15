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
export declare function createLanguageService(fileNames: string[], options: ts.CompilerOptions): ts.LanguageService;
/**
 * For each top-level declaration, re-find its identifier position (same walk
 * extractSymbols used, via getTopLevelDeclarations), look up the matching symbols
 * row by (name, file_path, line_start), then call findReferences at that position
 * and record every usage site — excluding the declaration's own occurrence, since
 * find_module already covers "where is X declared" and references_ is "where is
 * X used".
 */
export declare function indexReferences(db: Database.Database, service: ts.LanguageService): void;
