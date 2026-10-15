import ts from "typescript";
import type Database from "better-sqlite3";
import { type UnresolvedImport } from "./resolution.js";
/**
 * Batch indexer (plan §4, mode 1): a one-shot ts.Program walked once to populate
 * `symbols` and `edges`. Stateless and cheap. Reference-finding is NOT here — it
 * needs a LanguageService (mode 2) and lives in indexer/references.ts.
 *
 * Build-order step 1 — Done when: running against one fixed sample file produces
 * symbol/edge counts matching a hand-counted expectation, and at least one
 * barrel/side-effect import appears as a file->file edge with to_symbol_id NULL.
 */
export declare function indexRepository(db: Database.Database, tsconfigPath: string): {
    unresolved: UnresolvedImport[];
    configErrors: string[];
};
/** Load a tsconfig.json into a fileNames + options pair (incl. path aliases). Shared
 * with indexer/references.ts, which needs the same inputs to stand up a LanguageService
 * over the identical file set. */
export declare function loadTsconfig(tsconfigPath: string): {
    fileNames: string[];
    options: ts.CompilerOptions;
    configErrors: string[];
};
/** Normalize path separators so from_file/to_file join cleanly across platforms. */
export declare function normalizePath(p: string): string;
declare const SYMBOL_KINDS: readonly ["class", "function", "interface", "type", "const", "enum"];
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
 * Walk a file's top-level statements and list its class/function/interface/type/const/enum
 * declarations. Shared by extractSymbols (below) and indexer/references.ts, so both
 * agree on exactly what counts as an indexable top-level symbol.
 *
 * `const enum` is indexed as kind 'enum' too: its members are inlined at emit, but
 * every use is still a reference the type checker resolves, and removing its export
 * breaks the same files. A merged enum (declared twice) gets one row per declaration,
 * as merged interfaces already do.
 */
export declare function getTopLevelDeclarations(sourceFile: ts.SourceFile): TopLevelDeclaration[];
/**
 * Every `require("literal")` call that runs when the module loads - i.e. not
 * nested inside a function, method, accessor, constructor or static block. A
 * require() inside a function is a lazy load: it can't take part in an
 * initialization cycle, and counting it would also turn every downleveled dynamic
 * `import()` (`Promise.resolve().then(() => require(X))`) into a hard edge. This is
 * the same boundary rule benchmarks/oracle/emitted-edges.ts applies to emitted
 * JS; the two are kept separate on purpose so the oracle can catch bugs here.
 */
export declare function findTopLevelRequireCalls(sourceFile: ts.SourceFile): ts.StringLiteral[];
export {};
