#!/usr/bin/env tsx
/**
 * Screen a candidate benchmark target: how hard would its cycle tasks be?
 *
 * Usage: npm run screen -- <path-to-tsconfig.json> [--long=6] [--json=out.json]
 *
 * Compiles the repo with the emitted-JS oracle (no RIE index, no agent runs - free
 * apart from one compile) and reports, for its RUNTIME cycle groups, the shortest
 * loop through each member file. Group size alone is misleading: the cycle-trace
 * validator accepts any cycle through the start file, so a huge group whose members
 * all loop back through a barrel in 2 hops is as easy as a tiny one. `--long` is
 * the loop length that counts as forcing real traversal (default 6); a repo is
 * worth benchmarking when a meaningful share of members have no shorter loop, and
 * its taskgen `min_path` should then be raised to match.
 *
 * Source-level groups (type-only imports counted too) are summarized as well:
 * that's where runtime-vs-type trap tasks come from.
 */
import { writeFileSync } from "node:fs";
import { computeEmittedEdges } from "./emitted-edges.js";
import { findStronglyConnectedComponents } from "./tarjan.js";
import { shortestLoopLengths, summarizeLoopLengths, type LoopLengthSummary } from "./loops.js";

const args = process.argv.slice(2);
const tsconfigPath = args.find((a) => !a.startsWith("--"));
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const longThreshold = Number(flag("long") ?? 6);
const jsonOut = flag("json");

if (!tsconfigPath || !Number.isInteger(longThreshold) || longThreshold < 2) {
  console.error("usage: npm run screen -- <path-to-tsconfig.json> [--long=6] [--json=out.json]");
  process.exit(1);
}

const started = Date.now();
const { edges, sourceEdges, unresolvedInternal, fileCount, rootDir } = computeEmittedEdges(tsconfigPath);
const runtimeGroups = findStronglyConnectedComponents(edges);
const sourceGroups = findStronglyConnectedComponents(sourceEdges);
const loops = shortestLoopLengths(edges, runtimeGroups);

const relative = (f: string) => (f.startsWith(rootDir + "/") ? f.slice(rootDir.length + 1) : f);
const pct = (n: number, d: number) => (d === 0 ? "-" : `${((100 * n) / d).toFixed(0)}%`);
const histogramText = (s: LoopLengthSummary) =>
  [...s.histogram].map(([len, count]) => `${len}:${count}`).join(" ");

const groupRows = runtimeGroups.map((g) => {
  const lengths = g.files.map((f) => loops.get(f)!);
  const summary = summarizeLoopLengths(lengths, longThreshold);
  const longest = g.files.reduce((a, b) => (loops.get(b)! > loops.get(a)! ? b : a));
  return { size: g.files.length, summary, example: relative(longest) };
});
const overall = summarizeLoopLengths([...loops.values()], longThreshold);

console.log(`\n${tsconfigPath}`);
console.log(
  `${fileCount} files, ${new Set(edges.map((e) => `${e.from}\0${e.to}`)).size} runtime edges ` +
    `(${new Set(sourceEdges.map((e) => `${e.from}\0${e.to}`)).size} in source), compiled in ${Date.now() - started}ms`
);
if (unresolvedInternal.length > 0) {
  console.log(
    `WARNING: ${unresolvedInternal.length} internal import(s) don't resolve, so the graph below is missing ` +
      `edges and the cycle numbers are too LOW. Fix the tsconfig (paths / moduleResolution) or install deps first. e.g.:`
  );
  for (const u of unresolvedInternal.slice(0, 5)) console.log(`  ${relative(u.from)}  '${u.specifier}'`);
} else {
  console.log(`Unresolved internal imports: 0`);
}
console.log(
  `Source-level groups (type-only imports counted): ${sourceGroups.length} ` +
    `[${sourceGroups.map((g) => g.files.length).join(", ")}]`
);
console.log(`Runtime groups: ${runtimeGroups.length}`);

if (runtimeGroups.length > 0) {
  console.log(`\n| group size | median loop | max loop | members with loop >= ${longThreshold} | loop length:count | longest-loop member |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const r of groupRows) {
    console.log(
      `| ${r.size} | ${r.summary.median} | ${r.summary.max} | ${r.summary.long} (${pct(r.summary.long, r.size)}) | ` +
        `${histogramText(r.summary)} | ${r.example} |`
    );
  }
}
console.log(
  `\nAll runtime-cycle members: ${overall.members}, median loop ${overall.median}, max ${overall.max}, ` +
    `${overall.long} (${pct(overall.long, overall.members)}) with loop >= ${longThreshold}`
);

if (jsonOut) {
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        tsconfig: tsconfigPath,
        files: fileCount,
        unresolved_internal: unresolvedInternal.length,
        long_threshold: longThreshold,
        source_groups: sourceGroups.map((g) => g.files.length),
        runtime_groups: groupRows.map((r) => ({
          size: r.size,
          median_loop: r.summary.median,
          max_loop: r.summary.max,
          long_members: r.summary.long,
          histogram: Object.fromEntries(r.summary.histogram),
          longest_loop_member: r.example,
        })),
        overall: { members: overall.members, median_loop: overall.median, max_loop: overall.max, long_members: overall.long },
      },
      null,
      2
    )
  );
  console.error(`wrote ${jsonOut}`);
}
