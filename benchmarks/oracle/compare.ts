#!/usr/bin/env tsx
/**
 * Validation step from the plan: diff RIE's own runtime edges against the
 * emitted-JS oracle (emitted-edges.ts) for a real target repo. This is the
 * reusable version of the manual process the top-level README describes doing by
 * hand for nest ("Checking it edge by edge") - same three-bucket table, same
 * agree/over-report/hide framing, but rerunnable against any tsconfig instead of
 * a one-off script.
 *
 * Usage: npm run oracle -- <path-to-tsconfig.json> [db-path]
 *   db-path defaults to :memory: - this indexes fresh every run, it isn't meant
 *   to produce a reusable index artifact.
 *
 * Exit code is 1 if any DANGEROUS-direction disagreement is found (a real
 * runtime edge RIE reports as erased) - that's a bug, not a rounding difference.
 * A SAFE-direction disagreement (RIE reports an edge the compiler actually
 * erases, e.g. the known const-enum limit) exits 0.
 */
import { openDb } from "../../src/storage/db.js";
import { reindex, findCircularDependencies } from "../../src/engine/index.js";
import { computeEmittedEdges } from "./emitted-edges.js";
import { findStronglyConnectedComponents } from "./tarjan.js";

const tsconfigPath = process.argv[2];
const dbPath = process.argv[3] ?? ":memory:";

if (!tsconfigPath) {
  console.error("usage: npm run oracle -- <path-to-tsconfig.json> [db-path]");
  process.exit(1);
}

const pairKey = (from: string, to: string) => `${from}\u0000${to}`;

console.error(`Indexing ${tsconfigPath} with RIE...`);
const db = openDb(dbPath);
const indexStart = Date.now();
reindex(db, tsconfigPath);
console.error(`  done in ${Date.now() - indexStart}ms`);

const rieEdges = db.prepare(`SELECT DISTINCT from_file, to_file FROM edges WHERE is_type_only = 0`).all() as {
  from_file: string;
  to_file: string;
}[];
const riePairs = new Set(rieEdges.map((e) => pairKey(e.from_file, e.to_file)));

console.error(`Compiling ${tsconfigPath} for the emitted-JS oracle...`);
const oracleStart = Date.now();
const { edges: oracleEdges, fileCount } = computeEmittedEdges(tsconfigPath);
console.error(`  done in ${Date.now() - oracleStart}ms (${fileCount} files)`);

const oraclePairSet = new Map<string, { from: string; to: string }>();
for (const e of oracleEdges) oraclePairSet.set(pairKey(e.from, e.to), e);

let agree = 0;
const safeOverReport: { from: string; to: string }[] = []; // RIE: runtime, oracle: erased
const dangerousHidden: { from: string; to: string }[] = []; // RIE: erased/absent, oracle: runtime

for (const e of rieEdges) {
  const key = pairKey(e.from_file, e.to_file);
  if (oraclePairSet.has(key)) agree++;
  else safeOverReport.push({ from: e.from_file, to: e.to_file });
}
for (const [key, e] of oraclePairSet) {
  if (!riePairs.has(key)) dangerousHidden.push(e);
}

console.log(`\n${tsconfigPath}`);
console.log(`RIE runtime edges: ${riePairs.size}    Oracle runtime edges: ${oraclePairSet.size}`);
console.log(`\n| | pairs |`);
console.log(`|---|---|`);
console.log(`| agree | ${agree} |`);
console.log(`| erased by the compiler, reported as runtime (safe) | ${safeOverReport.length} |`);
console.log(`| real runtime edge, reported as erased (DANGEROUS) | ${dangerousHidden.length} |`);

const printSample = (label: string, pairs: { from: string; to: string }[], max = 15) => {
  if (pairs.length === 0) return;
  console.log(`\n${label}:`);
  for (const p of pairs.slice(0, max)) console.log(`  ${p.from} -> ${p.to}`);
  if (pairs.length > max) console.log(`  ... and ${pairs.length - max} more`);
};
printSample("Safe over-reports (RIE says runtime, compiler erases it)", safeOverReport);
printSample("DANGEROUS: real runtime edges RIE reports as erased", dangerousHidden);

const rieSccs = findCircularDependencies(db);
const oracleSccs = findStronglyConnectedComponents(oracleEdges);
console.log(`\nSCCs — RIE: ${rieSccs.length} group(s) [${rieSccs.map((c) => c.files.length).join(", ")}]`);
console.log(`SCCs — Oracle: ${oracleSccs.length} group(s) [${oracleSccs.map((c) => c.files.length).join(", ")}]`);

db.close();

if (dangerousHidden.length > 0) {
  console.error(`\nFAIL: ${dangerousHidden.length} real runtime edge(s) reported as erased.`);
  process.exit(1);
}
console.error(`\nOK: no runtime edges are hidden.`);
