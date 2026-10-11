import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { shortestLoopLength, type CycleGraph } from "../../src/check/index.js";
import { oracleGraph } from "./graphs.js";

/**
 * Finding positive commits for the replay without replaying everything: most
 * commits change no runtime cycle. The emit oracle's cycle signature (every group,
 * and each member's shortest loop length) is computed every `stride` commits;
 * where two differ, the stretch is bisected down to the commits that changed it.
 * Only the oracle is used, so which commits get picked owes nothing to RIE.
 *
 * Misses: a change undone inside one stride (a cycle added, then removed), and a
 * loop shortened through a file outside every group (which can't happen: a loop
 * puts the file in a group).
 */

export function signature(g: CycleGraph): string {
  return JSON.stringify(g.groups.map((group) => group.map((f) => [f, shortestLoopLength(g, f)])));
}

export interface MineOptions {
  repo: string;
  tsconfig: string;
  tsconfigFrom?: string;
  /** First-parent commits, oldest first. */
  commits: string[];
  stride: number;
  /** Signatures already computed (resume), by sha. */
  known?: Map<string, string>;
  onSignature?: (sha: string, signature: string, ms: number) => void;
  log?: (line: string) => void;
}

export function mine(options: MineOptions): { changed: string[]; computed: number } {
  const { repo, commits } = options;
  const log = options.log ?? (() => {});
  const known = options.known ?? new Map<string, string>();
  let computed = 0;

  const sig = (i: number): string => {
    const sha = commits[i];
    const hit = known.get(sha);
    if (hit !== undefined) return hit;
    const r = spawnSync("git", ["checkout", "-q", "--detach", "--force", sha], { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git checkout ${sha}: ${r.stderr}`);
    if (options.tsconfigFrom) copyFileSync(options.tsconfigFrom, join(repo, options.tsconfig));
    const t = Date.now();
    let s: string;
    try {
      s = signature(oracleGraph(join(repo, options.tsconfig)));
    } catch (err) {
      s = `error: ${(err as Error).message.split("\n")[0]}`;
    }
    computed++;
    known.set(sha, s);
    options.onSignature?.(sha, s, Date.now() - t);
    log(`  ${String(i).padStart(5)} ${sha.slice(0, 10)} ${Date.now() - t} ms`);
    return s;
  };

  const changed: string[] = [];
  const bisect = (lo: number, hi: number) => {
    if (hi - lo === 1) {
      changed.push(commits[hi]);
      log(`changed at ${commits[hi].slice(0, 10)}`);
      return;
    }
    const mid = Math.floor((lo + hi) / 2);
    if (sig(lo) !== sig(mid)) bisect(lo, mid);
    if (sig(mid) !== sig(hi)) bisect(mid, hi);
  };

  const points: number[] = [];
  for (let i = 0; i < commits.length; i += options.stride) points.push(i);
  if (points.at(-1) !== commits.length - 1) points.push(commits.length - 1);
  for (let p = 0; p + 1 < points.length; p++) {
    if (sig(points[p]) !== sig(points[p + 1])) bisect(points[p], points[p + 1]);
  }
  return { changed: changed.sort((a, b) => commits.indexOf(a) - commits.indexOf(b)), computed };
}
