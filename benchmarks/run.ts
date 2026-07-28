#!/usr/bin/env tsx
/**
 * Benchmark harness (plan §8/B). Runs each task under both arms, N times, from a
 * FRESH session per run, and reports MEDIAN file-reads / tool-calls per task.
 *
 * Primary metrics are machine-counted by parsing Claude Code's session transcript
 * JSONL and tallying tool_use blocks by name. IMPORTANT (plan §12): the transcript
 * schema/location is an UNVERIFIED assumption — confirm against a real transcript
 * before trusting these counts, and fall back to MCP-server-side structured logging
 * for the assisted arm if it doesn't hold.
 *
 * This file is intentionally a skeleton: build-order step 6.
 */
import { readFileSync } from "node:fs";

interface Task {
  id: string;
  prompt: string;
  oracle: { description: string; files: string[] };
}

interface Metrics {
  file_reads: number;   // count of Read tool_use blocks
  tool_calls: number;   // Read + Grep + Glob + any MCP tool
  ms_to_locate: number; // secondary, noisy
}

const config = JSON.parse(readFileSync(new URL("./tasks.json", import.meta.url), "utf8"));

/** TODO(step 6): drive Claude Code for one (task, arm) run and return its transcript path. */
async function runOnce(_task: Task, _arm: "baseline" | "assisted"): Promise<string> {
  throw new Error("not implemented — step 6");
}

/** TODO(step 6): parse a transcript JSONL, tally tool_use blocks by name. */
function parseMetrics(_transcriptPath: string): Metrics {
  // read JSONL lines -> filter type === 'tool_use' -> count by name.
  throw new Error("not implemented — step 6");
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  console.log(`Benchmark: ${config.repo.name}`);
  console.log("NOTE: harness is a step-6 skeleton — runOnce/parseMetrics not yet implemented.");
  // for each task: for each arm: N fresh runs -> parseMetrics -> median -> before/after table
  void median;
  void runOnce;
  void parseMetrics;
}

main();
