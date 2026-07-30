import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../storage/db.js";
import { indexRepository, loadTsconfig } from "./index.js";
import { createLanguageService, indexReferences } from "./references.js";
import { findSymbolReferences } from "../engine/index.js";

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
