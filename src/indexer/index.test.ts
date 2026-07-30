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

  it("gives a barrel re-export (`export * from`) a NULL to_symbol_id", () => {
    const edges = db
      .prepare("SELECT * FROM edges WHERE from_file LIKE '%/index.ts'")
      .all() as EdgeRow[];
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.to_symbol_id).toBeNull();
      expect(edge.to_file).toMatch(/\/(mathUtils|shapes)\.ts$/);
    }
  });

  it("gives a side-effect import (`import './x'`) a NULL to_symbol_id", () => {
    const edge = db
      .prepare("SELECT * FROM edges WHERE from_file LIKE '%/main.ts' AND to_file LIKE '%/sideEffect.ts'")
      .get() as EdgeRow | undefined;
    expect(edge).toBeDefined();
    expect(edge!.to_symbol_id).toBeNull();
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
