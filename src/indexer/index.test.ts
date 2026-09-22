import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../storage/db.js";
import { indexRepository } from "./index.js";
import type { EdgeRow } from "../storage/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_TSCONFIG = join(__dirname, "../../fixtures/sample-repo/tsconfig.json");

describe("indexRepository (fixtures/sample-repo)", () => {
  const db = openDb(":memory:");
  indexRepository(db, FIXTURE_TSCONFIG);

  it("produces the hand-counted symbol total", () => {
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM symbols").get() as { count: number };
    expect(count).toBe(6);
  });

  it("records the expected symbol names and kinds", () => {
    const rows = db.prepare("SELECT name, kind FROM symbols ORDER BY name").all() as {
      name: string;
      kind: string;
    }[];
    // SQLite's default ORDER BY uses a binary collation (uppercase before
    // lowercase), so match that rather than a locale-aware sort.
    expect(rows).toEqual([
      { name: "Circle", kind: "class" },
      { name: "PI", kind: "const" },
      { name: "Shape", kind: "interface" },
      { name: "ShapeKind", kind: "type" },
      { name: "add", kind: "function" },
      { name: "run", kind: "function" },
    ]);
  });

  it("produces the hand-counted edge total", () => {
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM edges").get() as { count: number };
    expect(count).toBe(6);
  });

  it("tags a barrel re-export (`export * from`) as reexport_star with a NULL to_symbol_id", () => {
    const edges = db
      .prepare("SELECT * FROM edges WHERE from_file LIKE '%/index.ts'")
      .all() as EdgeRow[];
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.to_symbol_id).toBeNull();
      expect(edge.to_file).toMatch(/\/(mathUtils|shapes)\.ts$/);
      // The distinct edge_type is what makes these recoverable: a star re-export
      // names no identifier, so reference search alone can never surface it.
      expect(edge.edge_type).toBe("reexport_star");
    }
  });

  it("gives a side-effect import (`import './x'`) a NULL to_symbol_id", () => {
    const edge = db
      .prepare("SELECT * FROM edges WHERE from_file LIKE '%/main.ts' AND to_file LIKE '%/sideEffect.ts'")
      .get() as EdgeRow | undefined;
    expect(edge).toBeDefined();
    expect(edge!.to_symbol_id).toBeNull();
    // Also NULL-symbol, but NOT a re-export - the two must stay distinguishable.
    expect(edge!.edge_type).toBe("imports");
  });

  it("gives a named import through a barrel a NULL to_symbol_id (symbol lives elsewhere)", () => {
    const edges = db
      .prepare("SELECT * FROM edges WHERE from_file LIKE '%/main.ts' AND to_file LIKE '%/index.ts'")
      .all() as EdgeRow[];
    expect(edges).toHaveLength(2); // add, PI
    for (const edge of edges) {
      expect(edge.to_symbol_id).toBeNull();
    }
  });

  it("resolves a direct named import to its symbol id", () => {
    const edge = db
      .prepare("SELECT * FROM edges WHERE from_file LIKE '%/main.ts' AND to_file LIKE '%/shapes.ts'")
      .get() as EdgeRow | undefined;
    const circle = db.prepare("SELECT id FROM symbols WHERE name = 'Circle'").get() as { id: number };
    expect(edge).toBeDefined();
    expect(edge!.to_symbol_id).toBe(circle.id);
  });

  it("does not write an edge for an external (node_modules) package import", () => {
    // external.ts imports the real `zod` package (a dependency of this project,
    // resolved via node_modules walk-up from the fixture) - it must not produce
    // an edge into node_modules, matching how indexRepository already excludes
    // external-library files from the symbol-extraction walk.
    const edges = db.prepare("SELECT * FROM edges WHERE from_file LIKE '%/external.ts'").all() as EdgeRow[];
    expect(edges).toEqual([]);

    const anyIntoNodeModules = db
      .prepare("SELECT COUNT(*) AS count FROM edges WHERE to_file LIKE '%node_modules%'")
      .get() as { count: number };
    expect(anyIntoNodeModules.count).toBe(0);
  });
});

/**
 * Type-only import detection. TypeScript erases these at compile time, so they are
 * real source dependencies but not runtime ones — the distinction cycle detection
 * relies on. Uses its own fixture so sample-repo's hand-counted totals stay fixed.
 */
/**
 * `emitDecoratorMetadata` is the one case where a type-position-only import still
 * survives: a decorated declaration's parameter/property types are re-emitted as
 * `design:paramtypes`/`design:type`. Its own fixture, because it needs
 * experimentalDecorators + emitDecoratorMetadata turned on.
 */
describe("indexRepository: emitDecoratorMetadata (fixtures/decorator-metadata-repo)", () => {
  const db = openDb(":memory:");
  indexRepository(db, join(__dirname, "../../fixtures/decorator-metadata-repo/tsconfig.json"));

  function edgesBetween(from: string, to: string): EdgeRow[] {
    return db
      .prepare(`SELECT * FROM edges WHERE from_file LIKE ? AND to_file LIKE ?`)
      .all(`%/${from}`, `%/${to}`) as EdgeRow[];
  }

  it("keeps a constructor-parameter type when the class is decorated", () => {
    const edges = edgesBetween("decorated.ts", "deps.ts");
    expect(edges).toHaveLength(1);
    expect(edges[0].is_type_only).toBe(0);
  });

  it("erases the identical usage when the class is NOT decorated", () => {
    // Same import, same type-only usage - the decorator is the whole difference.
    const edges = edgesBetween("undecorated.ts", "deps.ts");
    expect(edges).toHaveLength(1);
    expect(edges[0].is_type_only).toBe(1);
  });
});

describe("indexRepository: is_type_only (fixtures/type-only-repo)", () => {
  const db = openDb(":memory:");
  indexRepository(db, join(__dirname, "../../fixtures/type-only-repo/tsconfig.json"));

  /** Every edge between two files, by basename. */
  function edgesBetween(from: string, to: string): EdgeRow[] {
    return db
      .prepare(`SELECT * FROM edges WHERE from_file LIKE ? AND to_file LIKE ?`)
      .all(`%/${from}`, `%/${to}`) as EdgeRow[];
  }

  it("flags a whole-clause `import type { B } from './b'`", () => {
    const edges = edgesBetween("a.ts", "b.ts");
    expect(edges).toHaveLength(1);
    expect(edges[0].is_type_only).toBe(1);
  });

  it("leaves a plain value import unflagged", () => {
    const edges = edgesBetween("c.ts", "d.ts");
    expect(edges).toHaveLength(1);
    expect(edges[0].is_type_only).toBe(0);
  });

  it("splits one mixed statement into a type-only edge and a value edge", () => {
    // mixed.ts: `import { type A, aValue } from "./a"` - same statement, same file
    // pair, but only the `type A` half is erased.
    const edges = edgesBetween("mixed.ts", "a.ts");
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.is_type_only).sort()).toEqual([0, 1]);

    const typeEdge = edges.find((e) => e.is_type_only === 1)!;
    const aInterface = db
      .prepare("SELECT id FROM symbols WHERE name = 'A' AND kind = 'interface'")
      .get() as { id: number };
    expect(typeEdge.to_symbol_id).toBe(aInterface.id);
  });

  it("flags a type-only re-export (`export type { B } from './b'`)", () => {
    const edges = edgesBetween("mixed.ts", "b.ts");
    expect(edges).toHaveLength(1);
    expect(edges[0].is_type_only).toBe(1);
  });

  // The `type` keyword is a hint, not the rule: TypeScript erases any import whose
  // bindings are only ever used in type position. Detecting only the keyword made
  // nestjs/nest report 7 runtime cycles where an emit-verified count found 2.
  describe("erasure without the `type` keyword", () => {
    it("flags a plain `import { B }` used only as a type", () => {
      const edges = edgesBetween("erased.ts", "b.ts");
      expect(edges).toHaveLength(1);
      expect(edges[0].is_type_only).toBe(1);
    });

    it("splits a keyword-free statement by how each name is actually used", () => {
      // `import { Widget, WIDGET_TOKEN }` - Widget only annotates, WIDGET_TOKEN is
      // assigned to an exported const, so exactly one of the two edges survives.
      const edges = edgesBetween("erased.ts", "values.ts");
      const named = edges.filter((e) => e.to_symbol_id !== null);
      expect(named.map((e) => e.is_type_only).sort()).toEqual([0, 1]);

      const widget = db
        .prepare("SELECT id FROM symbols WHERE name = 'Widget' AND kind = 'class'")
        .get() as { id: number };
      expect(named.find((e) => e.to_symbol_id === widget.id)!.is_type_only).toBe(1);
    });

    it("flags a namespace import referenced only through a type (`ns.Widget`)", () => {
      // Namespace imports carry no symbol, so they land as the NULL-symbol edge.
      const edges = edgesBetween("erased.ts", "values.ts").filter((e) => e.to_symbol_id === null);
      expect(edges).toHaveLength(1);
      expect(edges[0].is_type_only).toBe(1);
    });

    it("keeps `extends` on a class but erases `implements`", () => {
      const edges = edgesBetween("heritage.ts", "values.ts");
      const byName = (name: string) => {
        const sym = db.prepare("SELECT id FROM symbols WHERE name = ?").get(name) as { id: number };
        return edges.find((e) => e.to_symbol_id === sym.id)!;
      };
      // Base becomes the prototype at runtime; Contract is an interface.
      expect(byName("Base").is_type_only).toBe(0);
      expect(byName("Contract").is_type_only).toBe(1);
    });

    it("decides a keyword-free re-export by the re-exported symbol's meaning", () => {
      const edges = edgesBetween("reexport.ts", "values.ts");
      const byName = (name: string) => {
        const sym = db.prepare("SELECT id FROM symbols WHERE name = ?").get(name) as { id: number };
        return edges.find((e) => e.to_symbol_id === sym.id)!;
      };
      expect(byName("Base").is_type_only).toBe(0);
      expect(byName("Contract").is_type_only).toBe(1);
    });
  });
});
