import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { openDb } from "../storage/db.js";
import ts from "typescript";
import { findTopLevelRequireCalls, indexRepository } from "./index.js";
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

  it("gives a side-effect import (`import './x'`) a NULL to_symbol_id and never erases it", () => {
    const edge = db
      .prepare("SELECT * FROM edges WHERE from_file LIKE '%/main.ts' AND to_file LIKE '%/sideEffect.ts'")
      .get() as EdgeRow | undefined;
    expect(edge).toBeDefined();
    expect(edge!.to_symbol_id).toBeNull();
    // Also NULL-symbol, but NOT a re-export - the two must stay distinguishable.
    expect(edge!.edge_type).toBe("imports");
    // A side-effect import has no importClause at all, so it never enters the
    // isTypeOnly check that default/namespace imports go through - running the
    // module IS the point, so it must never be flagged erased.
    expect(edge!.is_type_only).toBe(0);
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

  // Metadata serializes one entity name, and only a value (a class) survives as a
  // reference - these were 7 of nest's safe-direction over-reports. Each case was
  // checked against real emit (benchmarks/oracle/emitted-edges.test.ts has the same list).
  it.each([
    ["decoratedInterface.ts", "an interface serializes as Object"],
    ["decoratedAlias.ts", "a type alias serializes as Object"],
    ["decoratedGenericArg.ts", "a class in type arguments is not serialized"],
    ["decoratedUnion.ts", "a union of different classes serializes as Object"],
    ["decoratedNullable.ts", "`X | null` under strictNullChecks serializes as Object"],
  ])("erases a decorated parameter type when %s: %s", (file) => {
    const edges = edgesBetween(file, "contracts.ts");
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.is_type_only === 1)).toBe(true);
  });

  it("keeps `X | null` when strictNullChecks is off - null is skipped and X serialized", () => {
    const loose = openDb(":memory:");
    indexRepository(loose, join(__dirname, "../../fixtures/decorator-metadata-repo/tsconfig.loose.json"));
    const edges = loose
      .prepare(`SELECT * FROM edges WHERE from_file LIKE '%/decoratedNullable.ts' AND to_file LIKE '%/contracts.ts'`)
      .all() as EdgeRow[];
    expect(edges).toHaveLength(1);
    expect(edges[0].is_type_only).toBe(0);
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
    it("keeps an import used only in an instantiation expression (`makeBox(Box<string>)`)", () => {
      const edges = edgesBetween("instantiation.ts", "generic.ts");
      expect(edges).toHaveLength(1);
      expect(edges[0].is_type_only).toBe(0);
    });

    it("still erases the same node kind in an `implements` clause", () => {
      const edges = edgesBetween("implementsOnly.ts", "generic.ts");
      expect(edges).toHaveLength(1);
      expect(edges[0].is_type_only).toBe(1);
    });

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

  // `import x = require(...)` (ImportEqualsDeclaration) is a separate AST shape
  // from `import { x } from "..."` and was previously not walked by extractEdges
  // at all - every such statement produced zero edges. All three cases below were
  // checked against a real tsc emit before being written (see PR notes): a
  // value-used binding keeps its require(), a type-position-only or explicitly
  // `import type`-marked one is dropped entirely.
  it("erases `extends` on a `declare class`, which emits no code", () => {
    const edges = edgesBetween("ambientExtends.ts", "values.ts");
    expect(edges).toHaveLength(1);
    expect(edges[0].is_type_only).toBe(1);
  });

  describe("import x = require(...)", () => {
    it("keeps a value-used import-equals as a runtime edge", () => {
      const edges = edgesBetween("importEquals.ts", "values.ts");
      expect(edges).toHaveLength(1);
      expect(edges[0].to_symbol_id).toBeNull(); // binds the whole module, like a namespace import
      expect(edges[0].is_type_only).toBe(0);
    });

    it("erases an import-equals binding used only in type position, without the `type` keyword", () => {
      const edges = edgesBetween("importEqualsTypeOnly.ts", "values.ts");
      expect(edges).toHaveLength(1);
      expect(edges[0].is_type_only).toBe(1);
    });

    it("erases an explicit `import type x = require(...)` regardless of usage", () => {
      const edges = edgesBetween("importEqualsExplicitType.ts", "values.ts");
      expect(edges).toHaveLength(1);
      expect(edges[0].is_type_only).toBe(1);
    });
  });

  // A bare require() is a call expression, not an import statement: until this was
  // added the statement walk skipped it, and TypeORM's cli-ts-node-esm.ts -> cli.ts
  // was the one real runtime edge the emitted-JS oracle found missing. Both
  // fixtures were checked against the oracle's real emit first.
  describe("bare require(...) calls", () => {
    it("records a top-level require() as a runtime edge, even inside an `if`", () => {
      const edges = edgesBetween("bareRequire.ts", "values.ts");
      expect(edges).toHaveLength(1);
      expect(edges[0].edge_type).toBe("require");
      expect(edges[0].to_symbol_id).toBeNull();
      expect(edges[0].is_type_only).toBe(0);
    });

    it("records no edge for a require() nested inside a function (a lazy load)", () => {
      expect(edgesBetween("lazyRequire.ts", "d.ts")).toHaveLength(0);
    });
  });

  it("keeps `export * from` as a runtime edge even when the target module is entirely type-only", () => {
    // b.ts exports only `interface B` - no runtime export exists to re-export, yet
    // emit-verified tsc output still keeps the require()/__exportStar call, because
    // determining a target module has zero runtime exports would need cross-module
    // analysis the star-export transform doesn't do.
    const edges = edgesBetween("starReexportTypesOnly.ts", "b.ts");
    expect(edges).toHaveLength(1);
    expect(edges[0].edge_type).toBe("reexport_star");
    expect(edges[0].is_type_only).toBe(0);
  });
});

/**
 * `verbatimModuleSyntax` (and its deprecated predecessors, covered directly by
 * isErasureDisabledByFlag's own unit tests in erasure.test.ts) turns off
 * value-position erasure entirely: the compiler keeps every import except what's
 * explicitly marked `type`. Its own fixture, because running value-position
 * analysis anyway would silently erase real runtime edges - the dangerous
 * direction. Both cases here were checked against a real tsc emit first.
 */
describe("indexRepository: verbatimModuleSyntax (fixtures/verbatim-module-syntax-repo)", () => {
  const db = openDb(":memory:");
  indexRepository(db, join(__dirname, "../../fixtures/verbatim-module-syntax-repo/tsconfig.json"));

  function edgesBetween(from: string, to: string): EdgeRow[] {
    return db
      .prepare(`SELECT * FROM edges WHERE from_file LIKE ? AND to_file LIKE ?`)
      .all(`%/${from}`, `%/${to}`) as EdgeRow[];
  }

  it("keeps a plain import used only as a type - the same shape erased.ts erases under default rules", () => {
    const edges = edgesBetween("plainErased.ts", "values.ts");
    expect(edges).toHaveLength(1);
    expect(edges[0].is_type_only).toBe(0);
  });

  it("still erases an explicit `import type` - the one thing that does under this flag", () => {
    const edges = edgesBetween("explicitErased.ts", "values.ts");
    expect(edges).toHaveLength(1);
    expect(edges[0].is_type_only).toBe(1);
  });

  // Found by the emitted-JS oracle on directus: two `import { type X }` edges
  // reported as erased that tsc keeps as side-effect imports.
  it.each(["inlineTypeImport.ts", "inlineTypeExport.ts"])(
    "keeps a runtime edge for %s, whose only name is inline `type` - the statement survives as a side-effect import",
    (file) => {
      const edges = edgesBetween(file, "values.ts");
      expect(edges.map((e) => [e.imported_name, e.is_type_only])).toEqual([
        ["Contract", 1],
        [null, 0],
      ]);
    }
  );
});

/**
 * A const enum's import survives emit only when the compiler keeps the enum object:
 * value uses need `isolatedModules`, exports need that or `preserveConstEnums`.
 * The same table is asserted against real emit in benchmarks/oracle/emitted-edges.test.ts.
 */
describe("indexRepository: const enums (fixtures/const-enum-repo)", () => {
  const cases: [tsconfig: string, runtimeFrom: string[]][] = [
    ["tsconfig.json", ["mixedEnums.ts", "usesRegularEnum.ts"]],
    [
      "tsconfig.isolated.json",
      ["localReexportConstEnum.ts", "mixedEnums.ts", "reexportConstEnum.ts", "usesConstEnum.ts", "usesRegularEnum.ts"],
    ],
    ["tsconfig.preserve.json", ["localReexportConstEnum.ts", "mixedEnums.ts", "reexportConstEnum.ts", "usesRegularEnum.ts"]],
  ];

  for (const [tsconfig, runtimeFrom] of cases) {
    it(`${tsconfig}: runtime edges into enums.ts come from exactly ${runtimeFrom.length} file(s)`, () => {
      const db = openDb(":memory:");
      indexRepository(db, join(__dirname, "../../fixtures/const-enum-repo", tsconfig));
      const from = (
        db
          .prepare(`SELECT DISTINCT from_file FROM edges WHERE is_type_only = 0 AND to_file LIKE '%/enums.ts'`)
          .all() as { from_file: string }[]
      )
        .map((r) => r.from_file.split("/").pop()!)
        .sort();
      expect(from).toEqual(runtimeFrom);
    });
  }
});

describe("findTopLevelRequireCalls", () => {
  const specifiersOf = (code: string) =>
    findTopLevelRequireCalls(ts.createSourceFile("t.ts", code, ts.ScriptTarget.Latest, true)).map((s) => s.text);

  it("finds require() calls at top level, including nested in blocks and expressions", () => {
    expect(specifiersOf(`require("./a"); if (x) { require("./b"); } const c = require("./c").c;`)).toEqual([
      "./a",
      "./b",
      "./c",
    ]);
  });

  it("skips every kind of function boundary", () => {
    const code = `
      function f() { require("./f"); }
      const g = () => require("./g");
      const h = function () { require("./h"); };
      class K {
        m() { require("./m"); }
        get p() { return require("./p"); }
        set p(v) { require("./s"); }
        constructor() { require("./ctor"); }
        static { require("./static"); }
      }
      Promise.resolve().then(() => require("./dynamic"));
    `;
    expect(specifiersOf(code)).toEqual([]);
  });

  it("ignores non-literal arguments, extra arguments, and member calls like require.resolve", () => {
    expect(specifiersOf(`require(name); require("./a", 1); require.resolve("./b"); obj.require("./c");`)).toEqual([]);
  });
});

/** Per-edge evidence (line, statement text, imported name) - what find_cycle_through_file cites per hop. */
describe("indexRepository: edge line, statement and imported_name (fixtures/type-only-repo)", () => {
  const db = openDb(":memory:");
  indexRepository(db, join(__dirname, "../../fixtures/type-only-repo/tsconfig.json"));
  const edgesBetween = (from: string, to: string) =>
    db
      .prepare(`SELECT * FROM edges WHERE from_file LIKE ? AND to_file LIKE ? ORDER BY imported_name`)
      .all(`%/${from}`, `%/${to}`) as EdgeRow[];

  it("records the import's line, text and name", () => {
    const [edge] = edgesBetween("c.ts", "d.ts");
    expect(edge.line).toBe(2);
    expect(edge.statement).toBe(`import { d } from "./d";`);
    expect(edge.imported_name).toBe("d");
  });

  it("gives both edges of one mixed statement the same line and text, each its own name", () => {
    const edges = edgesBetween("mixed.ts", "a.ts");
    expect(edges.map((e) => [e.imported_name, e.is_type_only])).toEqual([
      ["A", 1],
      ["aValue", 0],
    ]);
    expect(new Set(edges.map((e) => e.line))).toEqual(new Set([2]));
    expect(edges[0].statement).toBe(`import { type A, aValue } from "./a";`);
  });

  it("cites the require() call itself, with no name", () => {
    const [edge] = edgesBetween("bareRequire.ts", "values.ts");
    expect(edge.statement).toBe(`require("./values")`);
    expect(edge.line).toBe(7);
    expect(edge.imported_name).toBeNull();
  });
});

describe("statement text is collapsed onto one line and bounded", () => {
  it("collapses a multi-line import list and truncates very long statements", () => {
    const dir = mkdtempSync(join(tmpdir(), "rie-stmt-"));
    const long = Array.from({ length: 60 }, (_, i) => `n${i}`);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }));
    writeFileSync(join(dir, "lib.ts"), long.map((n) => `export const ${n} = 1;`).join("\n") + "\nexport const x = 1;\nexport const y = 2;\n");
    writeFileSync(
      join(dir, "user.ts"),
      `import {\n  x,\n  y,\n} from "./lib";\nimport { ${long.join(", ")} } from "./lib";\nexport const s = x + y + ${long.join(" + ")};\n`
    );
    const db = openDb(":memory:");
    indexRepository(db, join(dir, "tsconfig.json"));
    const statements = (
      db.prepare(`SELECT DISTINCT line, statement FROM edges ORDER BY line`).all() as { line: number; statement: string }[]
    );
    expect(statements[0]).toEqual({ line: 1, statement: `import { x, y, } from "./lib";` });
    expect(statements[1].line).toBe(5);
    expect(statements[1].statement.length).toBe(200);
    expect(statements[1].statement.endsWith("…")).toBe(true);
  });
});

describe("openDb migrates an index built before edge evidence existed", () => {
  it("adds line/statement/imported_name as NULL to an old edges table", () => {
    const dir = mkdtempSync(join(tmpdir(), "rie-migrate-"));
    const path = join(dir, "old.db");
    const old = new Database(path);
    old.exec(`CREATE TABLE edges (id INTEGER PRIMARY KEY, from_file TEXT NOT NULL, to_file TEXT NOT NULL,
      to_symbol_id INTEGER, edge_type TEXT NOT NULL, is_type_only INTEGER NOT NULL DEFAULT 0);
      INSERT INTO edges (from_file, to_file, edge_type) VALUES ('/r/a.ts', '/r/b.ts', 'imports');`);
    old.close();

    const db = openDb(path);
    const row = db.prepare(`SELECT * FROM edges`).get() as EdgeRow;
    expect(row).toMatchObject({ from_file: "/r/a.ts", line: null, statement: null, imported_name: null });
    db.close();
  });
});

/**
 * A default binding and named bindings in one statement are judged separately.
 * Both cases once hid a runtime edge; `tsc` (module: commonjs) emits
 * `require("./m")` for each, checked before writing this test.
 */
describe("default + named imports in one statement", () => {
  const dir = mkdtempSync(join(tmpdir(), "rie-default-"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "commonjs" }, include: ["*.ts"] }));
  writeFileSync(join(dir, "m.ts"), "export default class Def {}\nexport const val = 1;\nexport interface Shape { x: number }\n");
  writeFileSync(join(dir, "typeDefault.ts"), `import Def, { val } from "./m";\nexport let d: Def | null = null;\nexport const v = val;\n`);
  writeFileSync(join(dir, "valueDefault.ts"), `import Def, { Shape } from "./m";\nexport const inst = new Def();\nexport let s: Shape | null = null;\n`);
  writeFileSync(join(dir, "both.ts"), `import Def, * as ns from "./m";\nexport let d: Def | null = null;\nexport const v = ns.val;\n`);
  const db = openDb(":memory:");
  indexRepository(db, join(dir, "tsconfig.json"));
  const edgesFrom = (file: string) =>
    (db.prepare(`SELECT imported_name, is_type_only FROM edges WHERE from_file LIKE ? ORDER BY imported_name`).all(`%/${file}`) as
      Pick<EdgeRow, "imported_name" | "is_type_only">[]).map((e) => [e.imported_name, e.is_type_only]);

  it("a type-only default does not erase a value named import", () => {
    expect(edgesFrom("typeDefault.ts")).toEqual([["default", 1], ["val", 0]]);
  });

  it("a value default is a runtime edge even when every named import is a type", () => {
    expect(edgesFrom("valueDefault.ts")).toEqual([["Shape", 1], ["default", 0]]);
  });

  it("default + namespace get one edge each", () => {
    expect(edgesFrom("both.ts")).toEqual([[null, 0], ["default", 1]]);
  });
});
