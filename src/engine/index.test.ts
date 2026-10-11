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
  circularDependencyReport,
  findCycleThroughFile,
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
    expect(findModule(db, "Circle")).toEqual({
      symbol_indexed: true,
      declarations: [{ name: "Circle", kind: "class", file_path: shapesTs, line_start: 7 }],
    });
  });

  it("find_module locates a known function at the correct file:line", () => {
    // add() is declared at line 1 of mathUtils.ts.
    expect(findModule(db, "add")).toEqual({
      symbol_indexed: true,
      declarations: [{ name: "add", kind: "function", file_path: mathUtilsTs, line_start: 1 }],
    });
  });

  it("find_module says explicitly when a name is not indexed, rather than returning a bare []", () => {
    const result = findModule(db, "DoesNotExist");
    expect(result.symbol_indexed).toBe(false);
    expect(result.declarations).toEqual([]);
    expect(result.note).toMatch(/does NOT mean the name is absent/);
    expect(result.similar_names).toBeUndefined();
  });

  it("find_module suggests a case-insensitive match on a miss", () => {
    const result = findModule(db, "circle");
    expect(result.symbol_indexed).toBe(false);
    expect(result.similar_names).toEqual(["Circle"]);
  });

  it("find_symbol_references surfaces the barrel that star-re-exports a symbol", () => {
    // End-to-end: index.ts is `export * from "./mathUtils"`, so add() is part of
    // the package's public surface - but that statement never writes the name
    // "add", so this is invisible to reference search alone.
    expect(findSymbolReferences(db, "add").re_exported_by).toEqual([indexTs]);
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
    expect(dependencyPath(db, "run", "add")).toMatchObject({
      found: true,
      chain: [mainTs, indexTs, mathUtilsTs],
    });
  });

  it("dependency_path is directional: the reverse (add -> run) is NOT connected", () => {
    // mathUtils.ts has zero outgoing edges (it imports nothing), so there is no
    // directed path back to main.ts even though run -> add is connected.
    const result = dependencyPath(db, "add", "run");
    expect(result).toMatchObject({ found: false, chain: [], files_searched: 1 });
  });

  it("dependency_path says how much it searched when no path exists", () => {
    // index.ts reaches itself, mathUtils.ts and shapes.ts - never main.ts.
    const result = dependencyPath(db, "src/index.ts", "run");
    expect(result.found).toBe(false);
    expect(result.files_searched).toBe(3);
    expect(result.note).toMatch(/^No import path from .*index\.ts to .*main\.ts\. The search was exhaustive/);
    expect(result.note).toContain("reached 3 file(s)");
  });

  it("dependency_path returns a trivial one-file chain for symbols in the same file", () => {
    expect(dependencyPath(db, "add", "PI")).toEqual({
      found: true,
      chain: [mathUtilsTs],
      path_type: "runtime_and_type_only",
    });
  });

  it("dependency_path returns not-found for an unknown symbol", () => {
    const result = dependencyPath(db, "DoesNotExist", "add");
    expect(result).toMatchObject({ found: false, chain: [] });
    expect(result.files_searched).toBeUndefined(); // nothing was searched
    expect(result.note).toContain('"DoesNotExist" is not an indexed symbol');
  });

  it("dependency_path accepts file paths at either end, including a symbol-less barrel", () => {
    // index.ts declares no symbols, so before file ends it could not be named at all.
    expect(dependencyPath(db, "src/main.ts", "src\\index.ts")).toMatchObject({ found: true, chain: [mainTs, indexTs] });
    expect(dependencyPath(db, "run", "mathUtils.ts")).toMatchObject({
      found: true,
      chain: [mainTs, indexTs, mathUtilsTs],
    });
  });

  it("dependency_path explains an unmatched file end instead of a bare not-found", () => {
    const result = dependencyPath(db, "src/nope.ts", "add");
    expect(result).toMatchObject({ found: false, chain: [] });
    expect(result.note).toContain('"src/nope.ts" is not an indexed file');
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
    expect(result).toMatchObject({
      found: true,
      chain: ["/repo/a.ts", "/repo/target.ts"],
      ambiguity: { symbol_a: { chosen: "/repo/a.ts", candidates: ["/repo/a.ts", "/repo/b.ts"] } },
    });
  });

  it("dependency_path omits the ambiguity field entirely for unique names", () => {
    const result = dependencyPath(db, "Target", "Target");
    expect(result).toEqual({ found: true, chain: ["/repo/target.ts"], path_type: "runtime_and_type_only" });
    expect("ambiguity" in result).toBe(false);
  });
});

/**
 * Star re-exports (the entity-decorator benchmark regression): `export * from`
 * names no identifier, so no reference search can see it. On TypeORM this was
 * the @Entity decorator's ONLY use outside its own file, and omitting it made a
 * live public API read as dead code.
 */
describe("find_symbol_references re_exported_by (synthetic db)", () => {
  const db = openDb(":memory:");
  db.exec(`
    INSERT INTO symbols (id, name, kind, file_path, line_start, line_end) VALUES
      (1, 'Decorated', 'function', '/repo/src/decorator/Decorated.ts', 1, 9),
      (2, 'Plain',     'class',    '/repo/src/Plain.ts', 1, 4);
    INSERT INTO edges (from_file, to_file, to_symbol_id, edge_type) VALUES
      ('/repo/src/index.ts',  '/repo/src/decorator/Decorated.ts', NULL, 'reexport_star'),
      ('/repo/src/barrel.ts', '/repo/src/decorator/Decorated.ts', NULL, 'reexport_star'),
      ('/repo/src/user.ts',   '/repo/src/Plain.ts',               2,    'imports');
  `);

  it("reports barrel files that star-re-export the declaring module", () => {
    const result = findSymbolReferences(db, "Decorated");
    expect(result.symbol_indexed).toBe(true);
    expect(result.references).toEqual([]); // no identifier anywhere - the whole point
    expect(result.re_exported_by).toEqual(["/repo/src/barrel.ts", "/repo/src/index.ts"]);
  });

  it("omits re_exported_by when nothing star-re-exports the module", () => {
    // /repo/src/Plain.ts IS imported, but by a named import - not a re-export.
    // Guards against counting every to_symbol_id-NULL edge as a star re-export.
    const result = findSymbolReferences(db, "Plain");
    expect(result.symbol_indexed).toBe(true);
    expect(result.re_exported_by).toBeUndefined();
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
  /**
   * Build an index containing only the given edges. A third tuple element marks
   * the edge type-only (erased at compile time); omitted means a value import.
   */
  function dbWithEdges(edges: ([string, string] | [string, string, "type-only"])[]) {
    const db = openDb(":memory:");
    const insert = db.prepare(
      `INSERT INTO edges (from_file, to_file, to_symbol_id, edge_type, is_type_only)
       VALUES (?, ?, NULL, 'imports', ?)`
    );
    for (const [from, to, kind] of edges) insert.run(from, to, kind === "type-only" ? 1 : 0);
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

  it("ignores a type-only cycle by default, and reports it on request", () => {
    const db = dbWithEdges([
      ["/r/a.ts", "/r/b.ts", "type-only"],
      ["/r/b.ts", "/r/a.ts", "type-only"],
    ]);
    // Erased at compile time -> not a runtime cycle.
    expect(findCircularDependencies(db)).toEqual([]);

    const withTypes = findCircularDependencies(db, { includeTypeOnly: true });
    expect(withTypes).toHaveLength(1);
    expect(withTypes[0].files).toEqual(["/r/a.ts", "/r/b.ts"]);
  });

  it("still reports a cycle that is only closed by a value edge", () => {
    const db = dbWithEdges([
      ["/r/a.ts", "/r/b.ts", "type-only"],
      ["/r/b.ts", "/r/a.ts"], // value import closes the loop at runtime... but
    ]);
    // ...the a->b half is erased, so at runtime there is no loop: b imports a,
    // and a imports nothing. Not a runtime cycle.
    expect(findCircularDependencies(db)).toEqual([]);
    expect(findCircularDependencies(db, { includeTypeOnly: true })).toHaveLength(1);
  });

  it("keeps a file pair joined by BOTH a type-only and a value import", () => {
    // Filtering happens before DISTINCT, so the value edge must survive.
    const db = dbWithEdges([
      ["/r/a.ts", "/r/b.ts", "type-only"],
      ["/r/a.ts", "/r/b.ts"], // same pair, real runtime import
      ["/r/b.ts", "/r/a.ts"],
    ]);
    const cycles = findCircularDependencies(db);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].files).toEqual(["/r/a.ts", "/r/b.ts"]);
  });
});

/** End-to-end over real TypeScript source, not hand-inserted rows. */
describe("find_circular_dependencies over fixtures/type-only-repo", () => {
  const db = openDb(":memory:");
  indexRepository(db, join(__dirname, "../../fixtures/type-only-repo/tsconfig.json"));

  it("reports the value cycle (c <-> d) but not the type-only one (a <-> b)", () => {
    const cycles = findCircularDependencies(db);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].files.map((f) => f.split("/").pop())).toEqual(["c.ts", "d.ts"]);
  });

  it("reports both cycles when type-only edges are included", () => {
    const cycles = findCircularDependencies(db, { includeTypeOnly: true });
    const groups = cycles.map((c) => c.files.map((f) => f.split("/").pop()).sort()).sort();
    expect(groups).toEqual([
      ["a.ts", "b.ts"],
      ["c.ts", "d.ts"],
    ]);
  });
});

/** The compact MCP-facing report and the per-file loop query (the directus fix). */
describe("circularDependencyReport + findCycleThroughFile (synthetic db)", () => {
  function dbWithEdges(edges: ([string, string] | [string, string, "type-only"])[]) {
    const db = openDb(":memory:");
    const insert = db.prepare(
      `INSERT INTO edges (from_file, to_file, to_symbol_id, edge_type, is_type_only)
       VALUES (?, ?, NULL, 'imports', ?)`
    );
    for (const [from, to, kind] of edges) insert.run(from, to, kind === "type-only" ? 1 : 0);
    return db;
  }

  // A 10-file ring (too big to inline) with a chord 0 -> 5, plus a separate 2-file cycle.
  const ring = Array.from({ length: 10 }, (_, i) => `/repo/src/r${i}.ts`);
  const ringEdges: [string, string][] = ring.map((f, i) => [f, ring[(i + 1) % ring.length]]);
  const db = dbWithEdges([
    ...ringEdges,
    ["/repo/src/r0.ts", "/repo/src/r5.ts"],
    ["/repo/src/x.ts", "/repo/src/y.ts"],
    ["/repo/src/y.ts", "/repo/src/x.ts"],
    ["/repo/src/leaf.ts", "/repo/src/r0.ts"],
    ["/repo/src/t1.ts", "/repo/src/t2.ts"],
    ["/repo/src/t2.ts", "/repo/src/t1.ts", "type-only"],
  ]);

  it("summarizes large groups, inlines small ones, and relativizes paths", () => {
    const report = circularDependencyReport(db, { root: "/repo" });
    expect(report.cycle_type).toBe("runtime");
    expect(report.files_in_cycles).toBe(12);
    expect(report.groups.map((g) => g.size)).toEqual([10, 2]);
    expect(report.groups[0].files).toBeUndefined();
    expect(report.groups[1].files).toEqual(["src/x.ts", "src/y.ts"]);
    expect(report.groups[0].example_cycle.every((f) => f.startsWith("src/"))).toBe(true);
    expect(report.note).toMatch(/include_files/);
    expect(report.note).toMatch(/find_cycle_through_file/);
  });

  it("lists every member with includeFiles, and agrees with findCircularDependencies", () => {
    const report = circularDependencyReport(db, { includeFiles: true });
    expect(report.groups.map((g) => g.files)).toEqual(findCircularDependencies(db).map((c) => c.files));
  });

  it("the root prefix match is case- and slash-insensitive, and only strips whole directories", () => {
    const report = circularDependencyReport(db, { root: "\\REPO\\src\\" });
    expect(report.groups[1].files).toEqual(["x.ts", "y.ts"]);
    expect(circularDependencyReport(db, { root: "/rep" }).groups[1].files).toEqual(["/repo/src/x.ts", "/repo/src/y.ts"]);
  });

  it("returns the shortest loop through the given file, not an arbitrary group example", () => {
    // r5 -> r6 -> ... -> r9 -> r0 -> r5 (the chord) = 6 files, shorter than the full ring.
    const result = findCycleThroughFile(db, "src/r7.ts", { root: "/repo" });
    expect(result.in_cycle).toBe(true);
    expect(result.resolved_path).toBe("src/r7.ts");
    expect(result.cycle).toEqual(["src/r7.ts", "src/r8.ts", "src/r9.ts", "src/r0.ts", "src/r5.ts", "src/r6.ts", "src/r7.ts"]);
    expect(result.loop_length).toBe(6);
  });

  it("proves a negative exhaustively, for a file that only imports into a cycle", () => {
    const result = findCycleThroughFile(db, "/repo/src/leaf.ts");
    expect(result.in_cycle).toBe(false);
    expect(result.cycle).toEqual([]);
    expect(result.files_searched).toBe(11); // leaf + the 10 ring files
    expect(result.type_only_cycle_exists).toBe(false);
  });

  it("flags a loop that exists only through a type-only import", () => {
    const runtime = findCycleThroughFile(db, "/repo/src/t1.ts");
    expect(runtime.in_cycle).toBe(false);
    expect(runtime.type_only_cycle_exists).toBe(true);
    expect(runtime.note).toMatch(/cannot run/);

    const withTypes = findCycleThroughFile(db, "/repo/src/t1.ts", { includeTypeOnly: true });
    expect(withTypes.in_cycle).toBe(true);
    expect(withTypes.cycle).toEqual(["/repo/src/t1.ts", "/repo/src/t2.ts", "/repo/src/t1.ts"]);
    expect(withTypes).not.toHaveProperty("type_only_cycle_exists");
  });

  it("handles a self-import and an unindexed path", () => {
    const self = findCycleThroughFile(dbWithEdges([["/r/loop.ts", "/r/loop.ts"]]), "loop.ts");
    expect(self.cycle).toEqual(["/r/loop.ts", "/r/loop.ts"]);
    expect(self.loop_length).toBe(1);

    const missing = findCycleThroughFile(db, "src/nope.ts");
    expect(missing.file_indexed).toBe(false);
    expect(missing.note).toMatch(/not in the index/);
  });
});

/** Each hop cites the statement behind it, so an agent needn't grep to confirm the loop. */
describe("findCycleThroughFile hops", () => {
  function dbWithEvidence(
    edges: { from: string; to: string; line: number; stmt: string; name?: string; typeOnly?: boolean }[]
  ) {
    const db = openDb(":memory:");
    const insert = db.prepare(
      `INSERT INTO edges (from_file, to_file, to_symbol_id, edge_type, is_type_only, line, statement, imported_name)
       VALUES (?, ?, NULL, 'imports', ?, ?, ?, ?)`
    );
    for (const e of edges) insert.run(e.from, e.to, e.typeOnly ? 1 : 0, e.line, e.stmt, e.name ?? null);
    return db;
  }

  const db = dbWithEvidence([
    // a -> b: a mixed statement (one erased name, one runtime name), plus a later star re-export.
    { from: "/repo/a.ts", to: "/repo/b.ts", line: 3, stmt: "import { type T, run } from './b';", name: "T", typeOnly: true },
    { from: "/repo/a.ts", to: "/repo/b.ts", line: 3, stmt: "import { type T, run } from './b';", name: "run" },
    { from: "/repo/a.ts", to: "/repo/b.ts", line: 9, stmt: "export * from './b';" },
    // b -> a only through an erased import: no runtime loop, but a type-level one.
    { from: "/repo/b.ts", to: "/repo/a.ts", line: 1, stmt: "import { Shape } from './a';", name: "Shape", typeOnly: true },
    // c <-> d runtime loop.
    { from: "/repo/c.ts", to: "/repo/d.ts", line: 2, stmt: "import * as d from './d';" },
    { from: "/repo/d.ts", to: "/repo/c.ts", line: 4, stmt: "import { c, cc } from './c';", name: "c" },
    { from: "/repo/d.ts", to: "/repo/c.ts", line: 4, stmt: "import { c, cc } from './c';", name: "cc" },
  ]);

  it("cites file:line, the statement, and the names that survive to runtime", () => {
    const result = findCycleThroughFile(db, "c.ts", { root: "/repo" });
    expect(result.cycle).toEqual(["c.ts", "d.ts", "c.ts"]);
    expect(result.hops).toEqual([
      { at: "c.ts:2", statement: "import * as d from './d';" },
      { at: "d.ts:4", statement: "import { c, cc } from './c';", runtime_names: ["c", "cc"] },
    ]);
  });

  it("lists only the runtime names of a mixed statement, and marks type-only hops when they count", () => {
    const withTypes = findCycleThroughFile(db, "/repo/a.ts", { includeTypeOnly: true, root: "/repo" });
    expect(withTypes.hops).toEqual([
      { at: "a.ts:3", statement: "import { type T, run } from './b';", runtime_names: ["run"], type_only: false },
      { at: "b.ts:1", statement: "import { Shape } from './a';", type_only: true },
    ]);
    expect(findCycleThroughFile(db, "/repo/a.ts")).not.toHaveProperty("hops");
  });

  it("falls back to the bare file for an index built before lines were recorded", () => {
    const old = openDb(":memory:");
    old.exec(`INSERT INTO edges (from_file, to_file, edge_type) VALUES ('/r/x.ts', '/r/y.ts', 'imports'), ('/r/y.ts', '/r/x.ts', 'imports')`);
    expect(findCycleThroughFile(old, "/r/x.ts").hops).toEqual([
      { at: "/r/x.ts", statement: null },
      { at: "/r/y.ts", statement: null },
    ]);
  });

  it("dependency_path cites each hop and marks the erased ones", () => {
    expect(dependencyPath(db, "/repo/b.ts", "/repo/a.ts")).toMatchObject({
      found: true,
      chain: ["/repo/b.ts", "/repo/a.ts"],
      path_type: "runtime_and_type_only",
      hops: [{ at: "/repo/b.ts:1", statement: "import { Shape } from './a';", type_only: true }],
    });
  });

  it("dependency_path runtime_only skips erased imports and says when only a type-level path exists", () => {
    const result = dependencyPath(db, "/repo/b.ts", "/repo/a.ts", { runtimeOnly: true });
    expect(result).toMatchObject({
      found: false,
      chain: [],
      path_type: "runtime",
      files_searched: 1,
      type_only_path_exists: true,
    });
    expect(result.note).toMatch(/^No runtime import path/);
    expect(result.note).toContain("cannot run");

    expect(dependencyPath(db, "/repo/a.ts", "/repo/b.ts", { runtimeOnly: true })).toMatchObject({
      found: true,
      hops: [{ at: "/repo/a.ts:3", statement: "import { type T, run } from './b';", runtime_names: ["run"] }],
    });
    expect(dependencyPath(db, "/repo/c.ts", "/repo/a.ts", { runtimeOnly: true })).toMatchObject({
      found: false,
      type_only_path_exists: false,
    });
  });

  it("dependency_path runtime_only takes a longer runtime chain over a shorter erased one", () => {
    const detour = dbWithEvidence([
      { from: "/r/x.ts", to: "/r/z.ts", line: 1, stmt: "import type { Z } from './z';", name: "Z", typeOnly: true },
      { from: "/r/x.ts", to: "/r/y.ts", line: 2, stmt: "import { y } from './y';", name: "y" },
      { from: "/r/y.ts", to: "/r/z.ts", line: 1, stmt: "import { z } from './z';", name: "z" },
    ]);
    expect(dependencyPath(detour, "/r/x.ts", "/r/z.ts").chain).toEqual(["/r/x.ts", "/r/z.ts"]);
    const runtime = dependencyPath(detour, "/r/x.ts", "/r/z.ts", { runtimeOnly: true });
    expect(runtime.chain).toEqual(["/r/x.ts", "/r/y.ts", "/r/z.ts"]);
    expect(runtime.hops).toEqual([
      { at: "/r/x.ts:2", statement: "import { y } from './y';", runtime_names: ["y"] },
      { at: "/r/y.ts:1", statement: "import { z } from './z';", runtime_names: ["z"] },
    ]);
  });

  it("over real source: the fixture's c <-> d loop cites both import lines", () => {
    const real = openDb(":memory:");
    indexRepository(real, join(__dirname, "../../fixtures/type-only-repo/tsconfig.json"));
    const result = findCycleThroughFile(real, "src/c.ts", { root: join(__dirname, "../../fixtures/type-only-repo") });
    expect(result.hops).toEqual([
      { at: "src/c.ts:2", statement: `import { d } from "./d";`, runtime_names: ["d"] },
      { at: "src/d.ts:1", statement: `import { c } from "./c";`, runtime_names: ["c"] },
    ]);
  });
});
