import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { openDb } from "../storage/db.js";
import { indexRepository } from "../indexer/index.js";
import {
  findModule,
  findRelatedFiles,
  dependencyPath,
  findSymbolReferences,
  findCircularDependencies,
} from "./index.js";

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

/**
 * Ambiguous-name behavior (mirrors a real case: the benchmark target repo declares
 * both a `Comment` entity class and a `Comment` interface). The fixture repo has
 * deliberately unique names, so these cases use a hand-built index instead.
 */
describe("engine queries with ambiguous symbol names (synthetic db)", () => {
  const db = openDb(":memory:");
  db.exec(`
    INSERT INTO symbols (id, name, kind, file_path, line_start, line_end) VALUES
      (1, 'Dup',    'class',     '/repo/a.ts', 1, 5),
      (2, 'Dup',    'interface', '/repo/b.ts', 1, 3),
      (3, 'Target', 'class',     '/repo/target.ts', 1, 2);
    INSERT INTO edges (from_file, to_file, to_symbol_id, edge_type) VALUES
      ('/repo/a.ts', '/repo/target.ts', 3, 'imports');
    INSERT INTO references_ (symbol_id, used_in_file, line) VALUES
      (1, '/repo/user1.ts', 10),
      (2, '/repo/user2.ts', 20);
  `);

  it("find_symbol_references labels every reference with its declaration", () => {
    const result = findSymbolReferences(db, "Dup");
    expect(result.symbol_indexed).toBe(true);
    expect(result.declarations.map((d) => d.file_path)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    expect(result.references).toEqual([
      { used_in_file: "/repo/user1.ts", line: 10, declared_in: "/repo/a.ts", kind: "class" },
      { used_in_file: "/repo/user2.ts", line: 20, declared_in: "/repo/b.ts", kind: "interface" },
    ]);
  });

  it("find_symbol_references scopes to one declaration via declaredIn", () => {
    const result = findSymbolReferences(db, "Dup", "/repo/b.ts");
    expect(result.declarations.map((d) => d.file_path)).toEqual(["/repo/b.ts"]);
    expect(result.references).toEqual([
      { used_in_file: "/repo/user2.ts", line: 20, declared_in: "/repo/b.ts", kind: "interface" },
    ]);
  });

  it("find_symbol_references distinguishes 'not indexed' from 'indexed but unreferenced'", () => {
    // Not in the index at all (e.g. a method name): flagged, with an explanatory note.
    const unknown = findSymbolReferences(db, "someMethodName");
    expect(unknown.symbol_indexed).toBe(false);
    expect(unknown.references).toEqual([]);
    expect(unknown.note).toMatch(/not in the index/);
    expect(unknown.note).toMatch(/does NOT mean the name is unused/i);

    // Indexed, genuinely zero references: no note, and clearly marked as indexed.
    const unreferenced = findSymbolReferences(db, "Target");
    expect(unreferenced.symbol_indexed).toBe(true);
    expect(unreferenced.references).toEqual([]);
    expect(unreferenced.note).toBeUndefined();
  });

  it("dependency_path discloses candidates and its deterministic (alphabetical) choice", () => {
    const result = dependencyPath(db, "Dup", "Target");
    // /repo/a.ts sorts before /repo/b.ts, and a.ts -> target.ts is a real edge.
    expect(result).toEqual({
      found: true,
      chain: ["/repo/a.ts", "/repo/target.ts"],
      ambiguity: { symbol_a: { chosen: "/repo/a.ts", candidates: ["/repo/a.ts", "/repo/b.ts"] } },
    });
  });

  it("dependency_path omits the ambiguity field entirely for unique names", () => {
    const result = dependencyPath(db, "Target", "Target");
    expect(result).toEqual({ found: true, chain: ["/repo/target.ts"] });
    expect("ambiguity" in result).toBe(false);
  });
});

/**
 * Path-format tolerance (the driver-impact benchmark regression): agents on
 * Windows pass backslash and repo-relative paths, but the index stores absolute
 * forward-slash paths. Exact string equality returned empty results for every
 * such call, which transcripts showed sends agents straight back to grep.
 */
describe("path resolution in path-taking queries (synthetic db)", () => {
  const db = openDb(":memory:");
  db.exec(`
    INSERT INTO symbols (id, name, kind, file_path, line_start, line_end) VALUES
      (1, 'Widget', 'class', '/repo/src/widgets/Widget.ts', 1, 5),
      (2, 'Panel',  'class', '/repo/src/panels/Panel.ts', 1, 5);
    INSERT INTO edges (from_file, to_file, to_symbol_id, edge_type) VALUES
      ('/repo/src/panels/Panel.ts', '/repo/src/widgets/Widget.ts', 1, 'imports'),
      ('/repo/src/a/util.ts', '/repo/src/widgets/Widget.ts', NULL, 'imports'),
      ('/repo/src/b/util.ts', '/repo/src/widgets/Widget.ts', NULL, 'imports');
    INSERT INTO references_ (symbol_id, used_in_file, line) VALUES
      (1, '/repo/src/panels/Panel.ts', 3);
  `);

  it("find_related_files accepts backslash absolute paths", () => {
    const related = findRelatedFiles(db, "\\repo\\src\\widgets\\Widget.ts");
    expect(related.file_indexed).toBe(true);
    expect(related.resolved_path).toBe("/repo/src/widgets/Widget.ts");
    expect(related.imported_by).toHaveLength(3);
  });

  it("find_related_files accepts repo-relative paths via unique suffix match", () => {
    const related = findRelatedFiles(db, "widgets/Widget.ts");
    expect(related.file_indexed).toBe(true);
    expect(related.resolved_path).toBe("/repo/src/widgets/Widget.ts");
    expect(related.imported_by).toHaveLength(3);
  });

  it("find_related_files matches case-insensitively (Windows filesystems)", () => {
    const related = findRelatedFiles(db, "/REPO/src/Widgets/widget.TS");
    expect(related.file_indexed).toBe(true);
    expect(related.resolved_path).toBe("/repo/src/widgets/Widget.ts");
  });

  it("find_related_files flags an ambiguous suffix instead of guessing", () => {
    // 'util.ts' matches both a/util.ts and b/util.ts.
    const related = findRelatedFiles(db, "util.ts");
    expect(related.file_indexed).toBe(false);
    expect(related.resolved_path).toBeNull();
    expect(related.note).toMatch(/matches 2 indexed files/);
    expect(related.note).toContain("/repo/src/a/util.ts");
  });

  it("find_related_files flags an unknown path instead of returning bare empties", () => {
    const related = findRelatedFiles(db, "no/such/file.ts");
    expect(related.file_indexed).toBe(false);
    expect(related.note).toMatch(/not in the index/);
  });

  it("find_symbol_references resolves backslash/relative declaredIn filters", () => {
    for (const path of ["\\repo\\src\\widgets\\Widget.ts", "widgets/Widget.ts"]) {
      const result = findSymbolReferences(db, "Widget", path);
      expect(result.symbol_indexed).toBe(true);
      expect(result.declarations.map((d) => d.file_path)).toEqual(["/repo/src/widgets/Widget.ts"]);
      expect(result.references).toHaveLength(1);
      expect(result.note).toBeUndefined();
    }
  });

  it("find_symbol_references drops an unresolvable filter with a note, never claiming 'not indexed'", () => {
    const result = findSymbolReferences(db, "Widget", "no/such/file.ts");
    expect(result.symbol_indexed).toBe(true); // the NAME is indexed - the old code said false here
    expect(result.declarations).toHaveLength(1);
    expect(result.references).toHaveLength(1);
    expect(result.note).toMatch(/ignoring the filter/);
  });

  it("find_symbol_references drops a filter pointing at a file that lacks the symbol, with a note", () => {
    const result = findSymbolReferences(db, "Widget", "/repo/src/panels/Panel.ts");
    expect(result.symbol_indexed).toBe(true);
    expect(result.declarations.map((d) => d.file_path)).toEqual(["/repo/src/widgets/Widget.ts"]);
    expect(result.note).toMatch(/no declaration in/);
  });
});

/** Circular dependency detection (plan §9 stretch 1; step 8 done-when: flags a known injected cycle). */
describe("find_circular_dependencies (synthetic db)", () => {
  /** Build an index containing only the given from->to file edges. */
  function dbWithEdges(edges: [string, string][]) {
    const db = openDb(":memory:");
    const insert = db.prepare(
      `INSERT INTO edges (from_file, to_file, to_symbol_id, edge_type) VALUES (?, ?, NULL, 'imports')`
    );
    for (const [from, to] of edges) insert.run(from, to);
    return db;
  }

  it("reports nothing for an acyclic graph", () => {
    const db = dbWithEdges([
      ["/r/a.ts", "/r/b.ts"],
      ["/r/b.ts", "/r/c.ts"],
      ["/r/a.ts", "/r/c.ts"],
    ]);
    expect(findCircularDependencies(db)).toEqual([]);
  });

  it("flags a known injected two-file cycle, with a concrete example path", () => {
    const db = dbWithEdges([
      ["/r/a.ts", "/r/b.ts"],
      ["/r/b.ts", "/r/a.ts"], // the injected cycle
      ["/r/standalone.ts", "/r/a.ts"], // acyclic neighbour, must not be swept in
    ]);
    const cycles = findCircularDependencies(db);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].files).toEqual(["/r/a.ts", "/r/b.ts"]);
    // example_cycle starts and ends at the same file, and only visits members.
    const example = cycles[0].example_cycle;
    expect(example[0]).toBe(example[example.length - 1]);
    expect(new Set(example)).toEqual(new Set(["/r/a.ts", "/r/b.ts"]));
  });

  it("flags a three-file cycle and returns a shortest example through it", () => {
    const db = dbWithEdges([
      ["/r/a.ts", "/r/b.ts"],
      ["/r/b.ts", "/r/c.ts"],
      ["/r/c.ts", "/r/a.ts"],
    ]);
    const [cycle] = findCircularDependencies(db);
    expect(cycle.files).toEqual(["/r/a.ts", "/r/b.ts", "/r/c.ts"]);
    expect(cycle.example_cycle).toHaveLength(4); // a -> b -> c -> a
    expect(cycle.example_cycle[0]).toBe(cycle.example_cycle[3]);
  });

  it("detects a self-import (file importing itself)", () => {
    const db = dbWithEdges([["/r/loop.ts", "/r/loop.ts"]]);
    const cycles = findCircularDependencies(db);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].files).toEqual(["/r/loop.ts"]);
    expect(cycles[0].example_cycle).toEqual(["/r/loop.ts", "/r/loop.ts"]);
  });

  it("separates independent cycles and orders the largest group first", () => {
    const db = dbWithEdges([
      // small cycle: x <-> y
      ["/r/x.ts", "/r/y.ts"],
      ["/r/y.ts", "/r/x.ts"],
      // larger cycle: p -> q -> r -> p
      ["/r/p.ts", "/r/q.ts"],
      ["/r/q.ts", "/r/r.ts"],
      ["/r/r.ts", "/r/p.ts"],
    ]);
    const cycles = findCircularDependencies(db);
    expect(cycles).toHaveLength(2);
    expect(cycles[0].files).toEqual(["/r/p.ts", "/r/q.ts", "/r/r.ts"]);
    expect(cycles[1].files).toEqual(["/r/x.ts", "/r/y.ts"]);
  });

  it("does not treat a diamond (two paths, no back-edge) as a cycle", () => {
    const db = dbWithEdges([
      ["/r/top.ts", "/r/left.ts"],
      ["/r/top.ts", "/r/right.ts"],
      ["/r/left.ts", "/r/bottom.ts"],
      ["/r/right.ts", "/r/bottom.ts"],
    ]);
    expect(findCircularDependencies(db)).toEqual([]);
  });
});
