import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * A commit and its parent side by side, the way rie check sees a PR, in two
 * temporary detached worktrees, so the benchmark clone stays where it is. A
 * sparse clone stays sparse: the worktrees copy its patterns. `tsconfigFrom` is
 * copied into both, for repos that don't track the tsconfig. Used by the demo
 * and the agent evaluation.
 */

export function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export interface PairCheckout {
  /** Worktree directories. */
  baseDir: string;
  prDir: string;
  /** The tsconfig in each. */
  baseTsconfig: string;
  prTsconfig: string;
  /** Removes both worktrees. */
  dispose(): void;
}

export function checkoutPair(repo: string, parent: string, commit: string, tsconfig: string, tsconfigFrom?: string): PairCheckout {
  const sparse = git(repo, ["sparse-checkout", "list"]).split("\n").filter(Boolean);
  const tmp = mkdtempSync(join(tmpdir(), "rie-pair-"));
  const worktrees: string[] = [];
  const dispose = () => {
    for (const dir of worktrees) git(repo, ["worktree", "remove", "--force", dir]);
    rmSync(tmp, { recursive: true, force: true });
  };
  const checkout = (name: string, sha: string) => {
    const dir = join(tmp, name);
    git(repo, ["worktree", "add", "--detach", "--no-checkout", dir, sha]);
    worktrees.push(dir);
    if (sparse.length > 0) git(dir, ["sparse-checkout", "set", "--no-cone", ...sparse]);
    git(dir, ["checkout", "--detach", sha]);
    if (tsconfigFrom) copyFileSync(tsconfigFrom, join(dir, tsconfig));
    return dir;
  };
  try {
    const baseDir = checkout("base", parent);
    const prDir = checkout("pr", commit);
    return { baseDir, prDir, baseTsconfig: join(baseDir, tsconfig), prTsconfig: join(prDir, tsconfig), dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}
