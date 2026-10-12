#!/usr/bin/env node
/**
 * rie check: fail a PR that makes runtime import cycles worse than its base.
 *
 *   npm run check -- --pr=<tsconfig> --base-ref=origin/main   compare against the merge base, from git
 *   npm run check -- --pr=<tsconfig> --base=<tsconfig>        compare two checkouts you already have
 *   npm run check -- <tsconfig>                                one snapshot: every cycle group and a shortest loop
 *
 * Options: --json (the full result instead of the text report)
 *          --renames=<json file> (with --base: base path -> PR path, relative to the tsconfig directory)
 *          --outcome=cycle_grown:warn,loop_shortened:fail (per-repo outcome overrides)
 *          --markdown-out=<file>, --json-out=<file> (also write the PR-comment markdown or the
 *          full result there; the GitHub Action posts the first and reads the outcome from the second)
 * Exit code: 1 when the outcome is fail, 0 for warn and pass, 2 on a usage error.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { checkCycles, DEFAULT_OUTCOMES, indexSnapshot, loopEvidence, type CycleEventType, type Outcome } from "./index.js";
import { checkAgainstRef } from "./git.js";
import { formatLoop, formatMarkdown, formatReport } from "./report.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const positional = args.filter((a) => !a.startsWith("--"));
const json = args.includes("--json");

function usage(message: string): never {
  console.error(`${message}\nUsage: rie check --pr=<tsconfig> (--base-ref=<git ref> | --base=<tsconfig>) [--json] | rie check <tsconfig>`);
  process.exit(2);
}

function parseOutcomes(spec: string | undefined): Partial<Record<CycleEventType, Outcome>> | undefined {
  if (!spec) return undefined;
  const out: Partial<Record<CycleEventType, Outcome>> = {};
  for (const pair of spec.split(",")) {
    const [type, outcome] = pair.split(":");
    if (!(type in DEFAULT_OUTCOMES)) usage(`--outcome: unknown event "${type}"`);
    if (!["fail", "warn", "pass"].includes(outcome)) usage(`--outcome: "${outcome}" must be fail, warn or pass`);
    out[type as CycleEventType] = outcome as Outcome;
  }
  return out;
}

const pr = flag("pr");
const outcomes = parseOutcomes(flag("outcome"));

if (!pr) {
  // One snapshot: list every runtime cycle group with a shortest loop through its first file.
  if (positional.length !== 1) usage("pass --pr=<tsconfig>, or one tsconfig to list its cycles");
  const snapshot = indexSnapshot(positional[0]);
  const groups = snapshot.groups.map((files) => {
    const first = files[0];
    const to = (snapshot.next.get(first) ?? []).find((n) => files.includes(n))!;
    return { files, loop: loopEvidence(snapshot, first, to) };
  });
  if (json) console.log(JSON.stringify({ groups, unresolved_internal_imports: snapshot.unresolved }, null, 2));
  else {
    console.log(`${groups.length} runtime cycle group(s) in ${dirname(positional[0])}`);
    for (const g of groups) {
      console.log(`\n${g.files.length} files: ${g.files.length <= 8 ? g.files.join(", ") : `${g.files.slice(0, 8).join(", ")}, ...`}`);
      if (g.loop) console.log(formatLoop(g.loop).join("\n"));
    }
    if (snapshot.unresolved > 0) console.log(`\nWARNING: ${snapshot.unresolved} internal import(s) don't resolve:\n${snapshot.unresolvedSummary}`);
  }
  snapshot.db.close();
  process.exit(0);
}

const baseRef = flag("base-ref");
const base = flag("base");
if (!baseRef === !base) usage("pass exactly one of --base-ref and --base");
const result = baseRef
  ? checkAgainstRef({ pr, baseRef, outcomes })
  : checkCycles({ base: base!, pr, outcomes, renames: flag("renames") ? JSON.parse(readFileSync(flag("renames")!, "utf8")) : undefined });

console.log(json ? JSON.stringify(result, null, 2) : formatReport(result));
const markdownOut = flag("markdown-out");
const jsonOut = flag("json-out");
if (markdownOut) {
  const baseCommit = "base_commit" in result ? (result.base_commit as string) : undefined;
  writeFileSync(markdownOut, formatMarkdown(result, { baseCommit, baseRef }) + "\n");
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 2) + "\n");
process.exit(result.outcome === "fail" ? 1 : 0);
