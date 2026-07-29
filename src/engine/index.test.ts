import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { openDb } from "../storage/db.js";
import { indexRepository } from "../indexer/index.js";
import { findModule, findRelatedFiles, dependencyPath } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_TSCONFIG = join(__dirname, "../../fixtures/sample-repo/tsconfig.json");

/** Recover an indexed file's exact stored path (normalized, absolute) by suffix. */
function pathEndingWith(db: Database.Database, suffix: string): string {
  const row = db
    .prepare(
      `SELECT from_file AS p FROM edges WHERE from_file LIKE ?
       UNION
       SELECT to_file AS p FROM edges WHERE to_file LIKE ?
       LIMIT 1`
    )
    .get(`%${suffix}`, `%${suffix}`) as { p: string } | undefined;
  if (!row) throw new Error(`no indexed file ending in ${suffix}`);
  return row.p;
}

describe("engine queries (fixtures/sample-repo)", () => {
  const db = openDb(":memory:");
  indexRepository(db, FIXTURE_TSCONFIG);

  const mainTs = pathEndingWith(db, "/main.ts");
  const indexTs = pathEndingWith(db, "/index.ts");
  const shapesTs = pathEndingWith(db, "/shapes.ts");
  const mathUtilsTs = pathEndingWith(db, "/mathUtils.ts");

  it("find_module locates a known class at the correct file:line", () => {
    // Circle is declared at line 7 of shapes.ts (traced by hand).
    expect(findModule(db, "Circle")).toEqual([
      { name: "Circle", kind: "class", file_path: shapesTs, line_start: 7 },
    ]);
  });

  it("find_module locates a known function at the correct file:line", () => {
    // add() is declared at line 1 of mathUtils.ts.
    expect(findModule(db, "add")).toEqual([
      { name: "add", kind: "function", file_path: mathUtilsTs, line_start: 1 },
    ]);
  });

  it("find_module returns nothing for an unknown name", () => {
    expect(findModule(db, "DoesNotExist")).toEqual([]);
  });

  it("find_related_files: main.ts imports index.ts, shapes.ts, sideEffect.ts; imported by nothing", () => {
    // Hand-traced: main.ts imports { add, PI } from ./index, { Circle } from
    // ./shapes, and side-effect-imports ./sideEffect. Nothing imports main.ts.
    const related = findRelatedFiles(db, mainTs);
    expect(related.imports).toHaveLength(3);
    expect(new Set(related.imports)).toEqual(new Set([indexTs, shapesTs, pathEndingWith(db, "/sideEffect.ts")]));
    expect(related.imported_by).toEqual([]);
  });

  it("find_related_files: shapes.ts imports nothing; imported by index.ts and main.ts", () => {
    // Hand-traced: index.ts re-exports * from ./shapes, main.ts imports { Circle }.
    const related = findRelatedFiles(db, shapesTs);
    expect(related.imports).toEqual([]);
    expect(new Set(related.imported_by)).toEqual(new Set([indexTs, mainTs]));
  });

  it("find_related_files: mathUtils.ts imports nothing; imported only by the barrel index.ts", () => {
    const related = findRelatedFiles(db, mathUtilsTs);
    expect(related.imports).toEqual([]);
    expect(related.imported_by).toEqual([indexTs]);
  });

  it("dependency_path finds a real multi-hop chain: run -> add via the barrel", () => {
    // Hand-traced: main.ts has NO direct edge to mathUtils.ts (only through the
    // barrel), so the shortest path is main.ts -> index.ts -> mathUtils.ts (2 hops).
    // This exercises actual BFS, not just a single-edge lookup.
    expect(dependencyPath(db, "run", "add")).toEqual({
      found: true,
      chain: [mainTs, indexTs, mathUtilsTs],
    });
  });

  it("dependency_path is directional: the reverse (add -> run) is NOT connected", () => {
    // mathUtils.ts has zero outgoing edges (it imports nothing), so there is no
    // directed path back to main.ts even though run -> add is connected.
    expect(dependencyPath(db, "add", "run")).toEqual({ found: false, chain: [] });
  });

  it("dependency_path returns a trivial one-file chain for symbols in the same file", () => {
    expect(dependencyPath(db, "add", "PI")).toEqual({ found: true, chain: [mathUtilsTs] });
  });

  it("dependency_path returns not-found for an unknown symbol", () => {
    expect(dependencyPath(db, "DoesNotExist", "add")).toEqual({ found: false, chain: [] });
  });
});
