import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { checkCycles, type CycleCheckInput, type CycleCheckResult } from "./index.js";

/**
 * The base side of a PR check from git: check out the merge base of `ref` and the
 * working tree into a temporary worktree, find the same tsconfig there, and read
 * renames from git's rename detection. The PR side is the working tree as it is,
 * uncommitted changes included.
 *
 * The base worktree has no dependencies installed, and type-only detection needs
 * imports resolved, so the PR checkout's node_modules is linked into it (at the
 * git root and at the tsconfig's directory, where each exists). The links are
 * removed before the worktree is, so removing it can't reach into the real ones.
 */

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.error?.message}`);
  return r.stdout.trim();
}

/**
 * `git diff -M --name-status` output -> renames relative to `prefix` (the tsconfig's
 * directory relative to the git root, "" at the root). Renames that cross out of
 * that directory are dropped: on one side the file isn't in the snapshot at all.
 */
export function parseRenames(nameStatus: string, prefix: string): Record<string, string> {
  const dir = prefix ? prefix.replace(/\\/g, "/").replace(/\/?$/, "/") : "";
  const renames: Record<string, string> = {};
  for (const line of nameStatus.split("\n")) {
    const [status, from, to] = line.split("\t");
    if (!status?.startsWith("R") || !from || !to) continue;
    if (!from.startsWith(dir) || !to.startsWith(dir)) continue;
    renames[from.slice(dir.length)] = to.slice(dir.length);
  }
  return renames;
}

export interface GitCheckInput extends Pick<CycleCheckInput, "outcomes"> {
  /** tsconfig of the PR checkout (the working tree). */
  pr: string;
  /** The branch or commit the PR merges into, e.g. origin/main. */
  baseRef: string;
}

export interface GitCheckResult extends CycleCheckResult {
  /** The commit the PR was compared against: the merge base of baseRef and HEAD. */
  base_commit: string;
  renames: Record<string, string>;
}

export function checkAgainstRef(input: GitCheckInput): GitCheckResult {
  const prTsconfig = resolve(input.pr);
  const gitRoot = resolve(git(dirname(prTsconfig), ["rev-parse", "--show-toplevel"]));
  const baseCommit = git(gitRoot, ["merge-base", input.baseRef, "HEAD"]);
  const tsconfigRel = relative(gitRoot, prTsconfig);
  const prefix = dirname(tsconfigRel) === "." ? "" : dirname(tsconfigRel);
  const renames = parseRenames(git(gitRoot, ["diff", "-M", "--name-status", baseCommit]), prefix);

  const worktree = join(mkdtempSync(join(tmpdir(), "rie-check-")), "base");
  git(gitRoot, ["worktree", "add", "--detach", worktree, baseCommit]);
  const links: string[] = [];
  try {
    for (const dir of new Set(["", prefix])) {
      const real = join(gitRoot, dir, "node_modules");
      const link = join(worktree, dir, "node_modules");
      if (existsSync(real) && existsSync(dirname(link)) && !existsSync(link)) {
        symlinkSync(real, link, "junction");
        links.push(link);
      }
    }
    const baseTsconfig = join(worktree, tsconfigRel);
    if (!existsSync(baseTsconfig)) throw new Error(`${tsconfigRel} doesn't exist at ${input.baseRef} (${baseCommit.slice(0, 10)})`);
    const result = checkCycles({ base: baseTsconfig, pr: prTsconfig, renames, outcomes: input.outcomes });
    return { ...result, base_commit: baseCommit, renames };
  } finally {
    for (const link of links) {
      try {
        unlinkSync(link);
      } catch {
        rmdirSync(link); // a Windows junction is removed as a directory, without touching its target
      }
    }
    git(gitRoot, ["worktree", "remove", "--force", worktree]);
  }
}
