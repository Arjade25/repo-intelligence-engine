import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { computeEmittedEdges } from "../oracle/emitted-edges.js";
import { findStronglyConnectedComponents } from "../oracle/tarjan.js";
import { loadTsconfig, normalizePath } from "../../src/indexer/index.js";
import { successors, type CycleGraph, type RuntimeEdge } from "../../src/check/index.js";

/**
 * The non-RIE sources of a runtime import graph for the history replay, each as a
 * CycleGraph so the same event rules (src/check) apply to all:
 * - the emit oracle, which compiles the snapshot and reads which imports survive
 *   into the JavaScript - the labels;
 * - madge and dpdm, common cycle checkers, each as a team would run it, and
 *   diffed between parent and commit.
 * eslint-plugin-import's no-cycle is the exception: it reports imports, not a
 * graph (eslintReports).
 * Groups come from the oracle's own Tarjan, not RIE's.
 */

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function graph(edges: RuntimeEdge[]): CycleGraph {
  const groups = findStronglyConnectedComponents(edges)
    .filter((c) => c.files.length > 1 || edges.some((e) => e.from === c.files[0] && e.to === c.files[0]))
    .map((c) => [...c.files].sort())
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  return { groups, edges, next: successors(edges) };
}

/** Path relative to the tsconfig directory, for any absolute path under it. */
function relativizer(tsconfigPath: string): (p: string) => string {
  const root = normalizePath(dirname(resolve(tsconfigPath))).replace(/\/+$/, "") + "/";
  return (p) => {
    const n = normalizePath(p);
    return n.toLowerCase().startsWith(root.toLowerCase()) ? n.slice(root.length) : n;
  };
}

export interface OracleGraph extends CycleGraph {
  fileCount: number;
  unresolved: number;
}

export function oracleGraph(tsconfigPath: string): OracleGraph {
  const rel = relativizer(tsconfigPath);
  const result = computeEmittedEdges(tsconfigPath);
  const seen = new Set<string>();
  const edges: RuntimeEdge[] = [];
  for (const e of result.edges) {
    const edge = { from: rel(e.from), to: rel(e.to), line: 0 };
    const k = `${edge.from}\u0000${edge.to}`;
    if (!seen.has(k)) edges.push(edge), seen.add(k);
  }
  return { ...graph(edges), fileCount: result.fileCount, unresolved: result.unresolvedInternal.length };
}

/**
 * madge over the tsconfig's directory, restricted to the files the tsconfig
 * includes: madge doesn't read `include`/`exclude`, so without this it would also
 * graph tests and declaration files, which a team would exclude by config.
 */
export function madgeGraph(tsconfigPath: string, sourceDir = "src"): CycleGraph & { fileCount: number } {
  const dir = dirname(resolve(tsconfigPath));
  const rel = relativizer(tsconfigPath);
  const included = new Set(loadTsconfig(tsconfigPath).fileNames.map(rel));
  const r = spawnSync(
    process.execPath,
    // Absolute: madge runs from the tsconfig's directory.
    [join(PROJECT_ROOT, "node_modules", "madge", "bin", "cli.js"), "--json", "--extensions", "ts,tsx", "--ts-config", resolve(tsconfigPath), sourceDir],
    {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      // The bash-madge benchmark arm's configuration (benchmarks/tools.json).
      env: { ...process.env, madge_detectiveOptions__ts__skipTypeImports: "true", madge_detectiveOptions__tsx__skipTypeImports: "true" },
    }
  );
  // madge prints a crash to stdout, not stderr.
  if (r.status !== 0) throw new Error(`madge failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  const deps = JSON.parse(r.stdout) as Record<string, string[]>;
  // madge's keys are relative to the directory it scanned.
  const toRel = (p: string) => posix.normalize(posix.join(sourceDir, p.replace(/\\/g, "/")));
  const edges: RuntimeEdge[] = [];
  for (const [from, tos] of Object.entries(deps)) {
    const f = toRel(from);
    if (!included.has(f)) continue;
    for (const to of new Set(tos.map(toRel))) if (included.has(to)) edges.push({ from: f, to, line: 0 });
  }
  return { ...graph(edges), fileCount: Object.keys(deps).map(toRel).filter((f) => included.has(f)).length };
}

/**
 * dpdm over the tsconfig's directory, as its README suggests running it: with -T,
 * which transpiles each file before reading its imports, so type-only imports
 * drop out. Dynamic import() still counts, as in dpdm's default. Restricted to the
 * tsconfig's files, like madge.
 */
export function dpdmGraph(tsconfigPath: string, sourceDir = "src"): CycleGraph & { fileCount: number } {
  const dir = dirname(resolve(tsconfigPath));
  const rel = relativizer(tsconfigPath);
  const included = new Set(loadTsconfig(tsconfigPath).fileNames.map(rel));
  const out = join(mkdtempSync(join(tmpdir(), "rie-dpdm-")), "dpdm.json");
  try {
    const r = spawnSync(
      process.execPath,
      [
        join(PROJECT_ROOT, "node_modules", "dpdm", "lib", "bin", "dpdm.js"),
        "-T",
        "--no-tree",
        "--no-circular",
        "--no-warning",
        "--tsconfig",
        resolve(tsconfigPath),
        "-o",
        out,
        `${sourceDir}/**/*.{ts,tsx}`,
      ],
      { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
    );
    if (r.status !== 0 || !existsSync(out)) throw new Error(`dpdm failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    const { tree } = JSON.parse(readFileSync(out, "utf8")) as { tree: Record<string, { id: string | null }[] | null> };
    // dpdm's paths are relative to its working directory, the tsconfig's.
    const toRel = (p: string) => posix.normalize(p.replace(/\\/g, "/"));
    const seen = new Set<string>();
    const edges: RuntimeEdge[] = [];
    for (const [from, deps] of Object.entries(tree)) {
      const f = toRel(from);
      if (!included.has(f)) continue;
      for (const d of deps ?? []) {
        if (d.id === null) continue;
        const to = toRel(d.id);
        const k = `${f}\u0000${to}`;
        if (included.has(to) && !seen.has(k)) edges.push({ from: f, to, line: 0 }), seen.add(k);
      }
    }
    return { ...graph(edges), fileCount: Object.keys(tree).map(toRel).filter((f) => included.has(f)).length };
  } finally {
    rmSync(dirname(out), { recursive: true, force: true });
  }
}

/** The module specifier of the import, export, require() or import() that starts at `pos`. */
function specifierAt(source: ts.SourceFile, pos: number): string | undefined {
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined || pos < node.getFullStart() || pos >= node.getEnd()) return;
    if (node.getStart(source) === pos) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        found = node.moduleSpecifier.text;
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
        found = node.moduleReference.expression.text;
      } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        found = node.arguments[0].text;
      } else if (ts.isStringLiteralLike(node)) {
        found = node.text;
      }
      if (found !== undefined) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export interface EslintReports {
  /** Each import no-cycle reported, as importing file -> imported file. */
  reports: RuntimeEdge[];
  fileCount: number;
  /** Reported imports whose specifier didn't resolve to a file in the tsconfig. */
  unresolved: number;
  /** Files eslint couldn't parse. */
  parseErrors: number;
}

/**
 * eslint-plugin-import's import/no-cycle (config: eslint-no-cycle.config.mjs), as
 * the imports it reports. These are not a graph: the rule shares one set of visited
 * modules across all imports of a file, so once one import's search has visited a
 * module, the file's later imports skip it, and only some of a file's imports into
 * a cycle are reported. Which ones depends on import order. So no-cycle gives no
 * cycle groups, and the replay compares its reports instead (compareReports).
 * The rule reports the import statement, not its target, so each reported
 * specifier is resolved with TypeScript's module resolution on the same tsconfig.
 * Inline eslint-disable comments are ignored: they say which cycles a team
 * accepted, not which exist.
 */
export function eslintReports(tsconfigPath: string, sourceDir = "src"): EslintReports {
  const dir = dirname(resolve(tsconfigPath));
  const rel = relativizer(tsconfigPath);
  const { fileNames, options } = loadTsconfig(tsconfigPath);
  const included = new Set(fileNames.map(rel));
  const out = join(mkdtempSync(join(tmpdir(), "rie-eslint-")), "eslint.json");
  try {
    const r = spawnSync(
      process.execPath,
      [
        join(PROJECT_ROOT, "node_modules", "eslint", "bin", "eslint.js"),
        "-c",
        join(PROJECT_ROOT, "benchmarks", "replay", "eslint-no-cycle.config.mjs"),
        "--no-inline-config",
        "--no-warn-ignored",
        "--format",
        "json",
        "--output-file",
        out,
        sourceDir,
      ],
      { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, RIE_ESLINT_TSCONFIG: resolve(tsconfigPath) } }
    );
    // 1 means lint errors (the cycles); 2 means eslint itself failed.
    if ((r.status !== 0 && r.status !== 1) || !existsSync(out)) throw new Error(`eslint failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    const results = JSON.parse(readFileSync(out, "utf8")) as { filePath: string; messages: { ruleId: string | null; line: number; column: number; fatal?: boolean }[] }[];
    const seen = new Set<string>();
    const reports: RuntimeEdge[] = [];
    let unresolved = 0;
    let parseErrors = 0;
    for (const result of results) {
      const from = rel(result.filePath);
      if (!included.has(from)) continue;
      if (result.messages.some((m) => m.fatal)) parseErrors++;
      const flagged = result.messages.filter((m) => m.ruleId === "import/no-cycle");
      if (flagged.length === 0) continue;
      const text = readFileSync(result.filePath, "utf8");
      const source = ts.createSourceFile(result.filePath, text, ts.ScriptTarget.Latest, true);
      for (const m of flagged) {
        const spec = specifierAt(source, source.getPositionOfLineAndCharacter(m.line - 1, m.column - 1));
        const target = spec && ts.resolveModuleName(spec, result.filePath, options, ts.sys).resolvedModule?.resolvedFileName;
        const to = target ? rel(target) : undefined;
        if (!to || !included.has(to)) {
          unresolved++;
          continue;
        }
        const k = `${from}\u0000${to}`;
        if (!seen.has(k)) reports.push({ from, to, line: m.line }), seen.add(k);
      }
    }
    const fileCount = results.filter((x) => included.has(rel(x.filePath))).length;
    return { reports, fileCount, unresolved, parseErrors };
  } finally {
    rmSync(dirname(out), { recursive: true, force: true });
  }
}
