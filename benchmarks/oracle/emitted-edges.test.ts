import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeEmittedEdges } from "./emitted-edges.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "../../fixtures");

/**
 * Runs the oracle against the SAME fixtures src/indexer/index.test.ts and
 * erasure.test.ts already exercise, so every expectation here was independently
 * checked against a real tsc emit before being written (see the step-1 PR that
 * closed the verbatimModuleSyntax and import-equals gaps) - this file is what
 * proves the oracle agrees with the indexer on cases already known to be right,
 * on a wholly separate code path (real compiled output, not source-level
 * analysis), before either is trusted against a large real-world repo.
 */
function hasEdge(edges: { from: string; to: string }[], fromBasename: string, toBasename: string): boolean {
  return edges.some((e) => e.from.endsWith(`/${fromBasename}`) && e.to.endsWith(`/${toBasename}`));
}

describe("computeEmittedEdges (fixtures/type-only-repo)", () => {
  const { edges, fileCount } = computeEmittedEdges(join(FIXTURES, "type-only-repo/tsconfig.json"));

  it("indexes every non-declaration file in the fixture", () => {
    expect(fileCount).toBeGreaterThanOrEqual(13);
  });

  it("has no edge for a whole-clause `import type`", () => {
    expect(hasEdge(edges, "a.ts", "b.ts")).toBe(false);
  });

  it("keeps a genuine runtime cycle in both directions", () => {
    expect(hasEdge(edges, "c.ts", "d.ts")).toBe(true);
    expect(hasEdge(edges, "d.ts", "c.ts")).toBe(true);
  });

  it("keeps the edge for a mixed statement whose value half survives", () => {
    // `import { type A, aValue } from "./a"` - A is erased, aValue is not, and TS
    // combines both into one require() call, so the edge exists regardless.
    expect(hasEdge(edges, "mixed.ts", "a.ts")).toBe(true);
  });

  it("drops a fully type-only re-export entirely", () => {
    expect(hasEdge(edges, "mixed.ts", "b.ts")).toBe(false);
  });

  it("keeps a keyword-free re-export whose target has value meaning", () => {
    expect(hasEdge(edges, "reexport.ts", "values.ts")).toBe(true);
  });

  it("keeps `extends` on a class (the surviving heritage position)", () => {
    expect(hasEdge(edges, "heritage.ts", "values.ts")).toBe(true);
  });

  it("erases a plain import used only in type position, without the `type` keyword", () => {
    // erased.ts imports B (type-only) and Widget/WIDGET_TOKEN from values.ts; only
    // the values.ts edge should survive (WIDGET_TOKEN is a genuine value use).
    expect(hasEdge(edges, "erased.ts", "b.ts")).toBe(false);
    expect(hasEdge(edges, "erased.ts", "values.ts")).toBe(true);
  });

  describe("import x = require(...)", () => {
    it("keeps a value-used import-equals binding", () => {
      expect(hasEdge(edges, "importEquals.ts", "values.ts")).toBe(true);
    });

    it("drops an import-equals binding used only in type position", () => {
      expect(hasEdge(edges, "importEqualsTypeOnly.ts", "values.ts")).toBe(false);
    });

    it("drops an explicit `import type x = require(...)` regardless of usage", () => {
      expect(hasEdge(edges, "importEqualsExplicitType.ts", "values.ts")).toBe(false);
    });
  });

  it("keeps `export * from` even when the target module is entirely type-only", () => {
    expect(hasEdge(edges, "starReexportTypesOnly.ts", "b.ts")).toBe(true);
  });
});

describe("computeEmittedEdges (fixtures/verbatim-module-syntax-repo)", () => {
  const { edges } = computeEmittedEdges(join(FIXTURES, "verbatim-module-syntax-repo/tsconfig.json"));

  it("keeps a plain import used only as a type - the flag disables usage-based elision", () => {
    expect(hasEdge(edges, "plainErased.ts", "values.ts")).toBe(true);
  });

  it("still erases an explicit `import type` - the one thing that does under this flag", () => {
    expect(hasEdge(edges, "explicitErased.ts", "values.ts")).toBe(false);
  });
});

describe("computeEmittedEdges (fixtures/decorator-metadata-repo)", () => {
  const { edges } = computeEmittedEdges(join(FIXTURES, "decorator-metadata-repo/tsconfig.json"));

  it("keeps a constructor-parameter type when the class is decorated", () => {
    expect(hasEdge(edges, "decorated.ts", "deps.ts")).toBe(true);
  });

  it("erases the identical usage when the class is NOT decorated", () => {
    expect(hasEdge(edges, "undecorated.ts", "deps.ts")).toBe(false);
  });
});

describe("computeEmittedEdges (fixtures/sample-repo)", () => {
  const { edges } = computeEmittedEdges(join(FIXTURES, "sample-repo/tsconfig.json"));

  it("keeps a side-effect import", () => {
    expect(hasEdge(edges, "main.ts", "sideEffect.ts")).toBe(true);
  });

  it("keeps a star re-export of a module with real runtime exports", () => {
    expect(hasEdge(edges, "index.ts", "mathUtils.ts")).toBe(true);
    expect(hasEdge(edges, "index.ts", "shapes.ts")).toBe(true);
  });

  it("does not produce an edge into an external (node_modules) package", () => {
    expect(edges.some((e) => e.from.endsWith("/external.ts"))).toBe(false);
  });
});
