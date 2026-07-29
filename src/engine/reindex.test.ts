import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { openDb } from "../storage/db.js";
import { reindex, findModule } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_TSCONFIG = join(__dirname, "../../fixtures/sample-repo/tsconfig.json");

/** Full ordered dump of every indexed table, for byte-identical comparisons. */
function dumpAll(db: Database.Database) {
  return {
    symbols: db.prepare("SELECT * FROM symbols ORDER BY id").all(),
    edges: db.prepare("SELECT * FROM edges ORDER BY id").all(),
    references: db.prepare("SELECT * FROM references_ ORDER BY id").all(),
  };
}

describe("reindex", () => {
  it("reproduces a byte-identical index on repeated runs against an unchanged repo", () => {
    const db = openDb(":memory:");
    reindex(db, FIXTURE_TSCONFIG);
    const first = dumpAll(db);

    reindex(db, FIXTURE_TSCONFIG);
    const second = dumpAll(db);

    expect(second).toEqual(first);
    expect(first.symbols.length).toBeGreaterThan(0); // sanity: not comparing two empty dumps
  });

  it("reflects an added file, then a removed file, on a changed repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "rie-reindex-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "rie-reindex-fixture", type: "commonjs" }));
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          rootDir: "./src",
          strict: true,
        },
        include: ["src/**/*"],
      })
    );
    writeFileSync(join(dir, "src/a.ts"), "export const A = 1;\n");
    const tsconfigPath = join(dir, "tsconfig.json");

    try {
      const db = openDb(":memory:");

      reindex(db, tsconfigPath);
      expect(findModule(db, "A")).toHaveLength(1);
      expect(findModule(db, "B")).toHaveLength(0);

      writeFileSync(join(dir, "src/b.ts"), "export const B = 2;\n");
      reindex(db, tsconfigPath);
      expect(findModule(db, "A")).toHaveLength(1);
      expect(findModule(db, "B")).toHaveLength(1);

      rmSync(join(dir, "src/b.ts"));
      reindex(db, tsconfigPath);
      expect(findModule(db, "A")).toHaveLength(1);
      expect(findModule(db, "B")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
