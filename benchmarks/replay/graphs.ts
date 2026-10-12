import { spawnSync } from "node:child_process";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeEmittedEdges } from "../oracle/emitted-edges.js";
import { findStronglyConnectedComponents } from "../oracle/tarjan.js";
import { loadTsconfig, normalizePath } from "../../src/indexer/index.js";
import { successors, type CycleGraph, type RuntimeEdge } from "../../src/check/index.js";

/**
 * The two non-RIE sources of a runtime import graph for the history replay, both
 * as a CycleGraph so the same event rules (src/check) apply to each:
 * - the emit oracle, which compiles the snapshot and reads which imports survive
 *   into the JavaScript - the labels;
 * - madge, the common circular-dependency CLI, as a team would run it: with
 *   `import type` skipped, and diffed between parent and commit.
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
