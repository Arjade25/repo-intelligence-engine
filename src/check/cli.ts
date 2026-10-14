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
 *          --explain (experimental: on a fail or warn, run the investigation agent on each finding; the
 *          explanations go into the markdown and JSON. It never changes the outcome)
 *            --explain-max=3 (findings explained), --explain-budget=0.5 (USD per finding),
 *            --explain-model=<id>, --diff=<file> (the PR's diff, with --base; --base-ref reads it from git)
 * Exit code: 1 when the outcome is fail, 0 for warn and pass, 2 on a usage error.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PrExplanation } from "../agent/pr.js";
import { checkCycles, checkCyclesOpen, DEFAULT_OUTCOMES, indexSnapshot, loopEvidence, type CycleCheckResult, type CycleEventType, type Outcome } from "./index.js";
import { checkAgainstRef, checkAgainstRefOpen, prDiff } from "./git.js";
import { formatLoop, formatMarkdown, formatReport } from "./report.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const positional = args.filter((a) => !a.startsWith("--"));
const json = args.includes("--json");

function usage(message: string): never {
  console.error(`${message}\nUsage: rie-check --pr=<tsconfig> (--base-ref=<git ref> | --base=<tsconfig>) [--json] | rie-check <tsconfig>  (or rie check ...)`);
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
const renamesFile = flag("renames");
const renames = renamesFile ? JSON.parse(readFileSync(renamesFile, "utf8")) : undefined;
const number = (name: string, fallback: number) => {
  const v = flag(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) usage(`--${name}: "${v}" must be a positive number`);
  return n;
};

const SDK = "@anthropic-ai/claude-agent-sdk";

/**
 * The agent, loaded only for --explain, so a plain check never loads the Agent SDK.
 * The SDK is an optional peer dependency: without it, say how to install it and
 * carry on with rie check's own findings, since the agent never changes the outcome.
 */
async function loadAgent(): Promise<typeof import("../agent/pr.js") | undefined> {
  try {
    return await import("../agent/pr.js");
  } catch (e) {
    const message = (e as Error).message ?? "";
    if (!/claude-agent-sdk/.test(message) || !/cannot find|not found/i.test(message)) throw e;
    console.error(`--explain needs the Claude Agent SDK, which isn't installed: npm install ${SDK}. Findings are reported without explanations.`);
    return undefined;
  }
}

let result: CycleCheckResult & { base_commit?: string };
let explanations: PrExplanation[] | undefined;
if (!args.includes("--explain")) {
  result = baseRef ? checkAgainstRef({ pr, baseRef, outcomes }) : checkCycles({ base: base!, pr, outcomes, renames });
} else {
  // Keep both indexes open: the agent queries the PR's, the verifier checks against both.
  const open = baseRef ? checkAgainstRefOpen({ pr, baseRef, outcomes }) : { ...checkCyclesOpen({ base: base!, pr, outcomes, renames }), gitRoot: undefined };
  result = open.result;
  try {
    if (result.outcome !== "pass") {
      const diffFile = flag("diff");
      const diff = diffFile ? readFileSync(diffFile, "utf8") : open.gitRoot && result.base_commit ? prDiff(open.gitRoot, result.base_commit) : "";
      const agent = await loadAgent();
      explanations = await agent?.explainEvents({
        result,
        pr: open.pr,
        base: open.base,
        renames: "renames" in result ? (result.renames as Record<string, string>) : renames,
        tsconfig: pr,
        diff,
        gitRoot: open.gitRoot,
        maxEvents: number("explain-max", 3),
        model: flag("explain-model"),
        limits: { maxBudgetUsd: number("explain-budget", 0.5) },
        log: (line) => console.error(line),
      });
    }
  } finally {
    open.base.db.close();
    open.pr.db.close();
  }
}

const full = JSON.stringify({ ...result, ...(explanations && { explanations }) }, null, 2);
console.log(json ? full : formatReport(result));
const markdownOut = flag("markdown-out");
const jsonOut = flag("json-out");
if (markdownOut) writeFileSync(markdownOut, `${formatMarkdown(result, { baseCommit: result.base_commit, baseRef }, explanations)}\n`);
if (jsonOut) writeFileSync(jsonOut, `${full}\n`);
process.exit(result.outcome === "fail" ? 1 : 0);
