import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../storage/db.js";
import { indexRepository, loadTsconfig } from "./index.js";
import { createLanguageService, indexReferences } from "./references.js";
import { findModule, findSymbolReferences } from "../engine/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_TSCONFIG = join(__dirname, "../../fixtures/sample-repo/tsconfig.json");

describe("indexReferences (fixtures/sample-repo)", () => {
  const db = openDb(":memory:");
  indexRepository(db, FIXTURE_TSCONFIG);
  const { fileNames, options } = loadTsconfig(FIXTURE_TSCONFIG);
  const service = createLanguageService(fileNames, options);
  indexReferences(db, service);

  it("finds semantically correct references to PI, excluding the unrelated Math.PI", () => {
    // Hand-traced (main.ts): line 1 `import { add, PI } from "./index"`,
    // line 7 `return add(PI, c.area());`. shapes.ts's `Math.PI` is a DIFFERENT
    // symbol that a raw text grep for "PI" would wrongly match too.
    const { references } = findSymbolReferences(db, "PI");
    expect(references.map((r) => r.line)).toEqual([1, 7]);
    for (const ref of references) {
      expect(ref.used_in_file).toMatch(/\/main\.ts$/);
    }
  });

  it("reference count for PI beats a raw grep count (grep over-counts Math.PI)", () => {
    // Raw text occurrences of "PI" across the fixture: mathUtils.ts declaration,
    // main.ts import, main.ts usage, shapes.ts's unrelated Math.PI = 4.
    // Semantic references (real uses of *our* PI, excluding its own declaration) = 2.
    const rawGrepCount = 4;
    const { references } = findSymbolReferences(db, "PI");
    expect(references.length).toBeLessThan(rawGrepCount);
    expect(references.length).toBe(2);
  });

  it("finds references to Circle at its two real use sites in main.ts", () => {
    // Hand-traced: line 2 `import { Circle } from "./shapes"`,
    // line 6 `const c = new Circle(2);`.
    const { references } = findSymbolReferences(db, "Circle");
    expect(references.map((r) => r.line)).toEqual([2, 6]);
  });

  it("never returns the declaration site itself as a reference", () => {
    const { references } = findSymbolReferences(db, "Circle");
    for (const ref of references) {
      expect(ref.used_in_file).not.toMatch(/\/shapes\.ts$/);
    }
  });
});

/**
 * Enums used to be skipped entirely, so find_symbol_references reported nest's
 * HttpStatus as "not in the index" while 38 files would break without its export.
 * Expected sites are hand-traced from fixtures/const-enum-repo, not taken from the
 * engine: every import binding and every `X.Member` use, plus the bare re-export.
 */
describe("indexReferences: enums (fixtures/const-enum-repo)", () => {
  const tsconfig = join(__dirname, "../../fixtures/const-enum-repo/tsconfig.json");
  const db = openDb(":memory:");
  indexRepository(db, tsconfig);
  const { fileNames, options } = loadTsconfig(tsconfig);
  indexReferences(db, createLanguageService(fileNames, options));

  const sites = (symbol: string) =>
    findSymbolReferences(db, symbol)
      .references.map((r) => `${r.used_in_file.split("/").pop()}:${r.line}`)
      .sort();

  it("indexes regular and const enums as kind 'enum', with their line spans", () => {
    for (const [name, lineStart, lineEnd] of [["Color", 1, 4], ["Size", 5, 8]] as const) {
      const { symbol_indexed, declarations } = findModule(db, name);
      expect(symbol_indexed).toBe(true);
      expect(declarations).toHaveLength(1);
      expect(declarations[0]).toMatchObject({ kind: "enum", line_start: lineStart });
      expect(declarations[0].file_path).toMatch(/\/enums\.ts$/);
      const row = db.prepare(`SELECT line_end FROM symbols WHERE name = ?`).get(name) as { line_end: number };
      expect(row.line_end).toBe(lineEnd);
    }
  });

  it("finds every use of a regular enum", () => {
    expect(sites("Size")).toEqual(["mixedEnums.ts:2", "mixedEnums.ts:4", "usesRegularEnum.ts:2", "usesRegularEnum.ts:4"]);
  });

  it("finds every use of a const enum, including both kinds of re-export", () => {
    // Members are inlined at emit, but these are still type-checked references.
    expect(sites("Color")).toEqual([
      "localReexportConstEnum.ts:4",
      "localReexportConstEnum.ts:6",
      "mixedEnums.ts:2",
      "mixedEnums.ts:4",
      "reexportConstEnum.ts:2",
      "usesConstEnum.ts:3",
      "usesConstEnum.ts:5",
    ]);
  });
});
