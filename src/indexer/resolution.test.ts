import { describe, expect, it } from "vitest";
import ts from "typescript";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadTsconfig } from "./index.js";
import { describeUnresolved, findUnresolvedInternalImports } from "./resolution.js";
import { openDb } from "../storage/db.js";
import { reindex } from "../engine/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ESM_TSCONFIG = join(__dirname, "../../fixtures/esm-alias-repo/tsconfig.json");
const SAMPLE_TSCONFIG = join(__dirname, "../../fixtures/sample-repo/tsconfig.json");

/**
 * fixtures/esm-alias-repo reproduces the nestjs/nest failure in miniature: a
 * "type": "module" package under module Node16, with one `paths` alias pointing at
 * a directory (never resolves in ESM mode) and one pointing at a file (resolves).
 */
describe("findUnresolvedInternalImports (fixtures/esm-alias-repo)", () => {
  const { fileNames, options } = loadTsconfig(ESM_TSCONFIG);
  const program = ts.createProgram(fileNames, options);
  const unresolved = findUnresolvedInternalImports(program);

  it("flags the directory alias and the missing relative import, not the file alias or node:fs", () => {
    expect(unresolved.map((u) => u.specifier).sort()).toEqual(["./missing.js", "@dir"]);
    expect(unresolved.every((u) => u.file.endsWith("src/main.ts"))).toBe(true);
    expect(unresolved.find((u) => u.specifier === "@dir")!.line).toBe(2);
  });

  it("uses the compiler's ESM resolution mode - the default CJS-mode call would call @dir fine", () => {
    // This is the trap the check exists for: RIE's edge extractor made exactly this
    // call and saw nothing wrong, while the type-checker reported TS2307.
    const main = fileNames.find((f) => f.endsWith("src/main.ts"))!;
    const cjs = ts.resolveModuleName("@dir", main, options, ts.createCompilerHost(options));
    expect(cjs.resolvedModule).toBeDefined();
  });

  it("describes the problem with examples", () => {
    const text = describeUnresolved(unresolved);
    expect(text).toMatch(/^2 internal import\(s\) do not resolve/);
    expect(text).toContain("'@dir'");
  });

  it("is surfaced by reindex, and empty for a repo whose imports all resolve", () => {
    expect(reindex(openDb(":memory:"), ESM_TSCONFIG).unresolved_internal_imports).toHaveLength(2);
    expect(reindex(openDb(":memory:"), SAMPLE_TSCONFIG).unresolved_internal_imports).toEqual([]);
  }, 30_000); // two full reindexes - see engine/reindex.test.ts on load-dependent timing
});

describe("findUnresolvedInternalImports: bare require() calls", () => {
  it("flags an internal require() that doesn't resolve, but not an external one", () => {
    const dir = mkdtempSync(join(tmpdir(), "rie-require-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "rie-require-fixture", type: "commonjs" }));
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
          include: ["src/**/*"],
        })
      );
      writeFileSync(join(dir, "src/ok.ts"), "export const ok = 1;\n");
      writeFileSync(
        join(dir, "src/main.ts"),
        ['declare const require: (id: string) => unknown;', 'require("./ok");', 'require("./gone");', 'require("some-package");'].join("\n")
      );

      const { fileNames, options } = loadTsconfig(join(dir, "tsconfig.json"));
      const unresolved = findUnresolvedInternalImports(ts.createProgram(fileNames, options));
      expect(unresolved.map((u) => [u.specifier, u.line])).toEqual([["./gone", 3]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
