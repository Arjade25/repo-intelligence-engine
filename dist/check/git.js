import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { checkCyclesOpen } from "./index.js";
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
function git(cwd, args) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0)
        throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.error?.message}`);
    return r.stdout.trim();
}
/**
 * `git diff -M --name-status` output -> renames relative to `prefix` (the tsconfig's
 * directory relative to the git root, "" at the root). Renames that cross out of
 * that directory are dropped: on one side the file isn't in the snapshot at all.
 */
export function parseRenames(nameStatus, prefix) {
    const dir = prefix ? prefix.replace(/\\/g, "/").replace(/\/?$/, "/") : "";
    const renames = {};
    for (const line of nameStatus.split("\n")) {
        const [status, from, to] = line.split("\t");
        if (!status?.startsWith("R") || !from || !to)
            continue;
        if (!from.startsWith(dir) || !to.startsWith(dir))
            continue;
        renames[from.slice(dir.length)] = to.slice(dir.length);
    }
    return renames;
}
export function checkAgainstRef(input) {
    const { result, base, pr } = checkAgainstRefOpen(input);
    base.db.close();
    pr.db.close();
    return result;
}
/** The PR's changes against the commit it was compared with, working tree included, as a unified diff. */
export function prDiff(gitRoot, baseCommit) {
    const r = spawnSync("git", ["diff", "-M", baseCommit], { cwd: gitRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0)
        throw new Error(`git diff ${baseCommit} failed: ${r.stderr.trim() || r.error?.message}`);
    return r.stdout;
}
export function checkAgainstRefOpen(input) {
    const prTsconfig = resolve(input.pr);
    const gitRoot = resolve(git(dirname(prTsconfig), ["rev-parse", "--show-toplevel"]));
    let baseCommit;
    try {
        baseCommit = git(gitRoot, ["merge-base", input.baseRef, "HEAD"]);
    }
    catch (e) {
        // The usual cause in CI: a shallow checkout, or a base branch that was never fetched.
        throw new Error(`no merge base between ${input.baseRef} and HEAD. Fetch the base branch with its history ` +
            `(actions/checkout with fetch-depth: 0, or git fetch --unshallow origin). ${e.message}`);
    }
    const tsconfigRel = relative(gitRoot, prTsconfig);
    const prefix = dirname(tsconfigRel) === "." ? "" : dirname(tsconfigRel);
    const renames = parseRenames(git(gitRoot, ["diff", "-M", "--name-status", baseCommit]), prefix);
    const worktree = join(mkdtempSync(join(tmpdir(), "rie-check-")), "base");
    git(gitRoot, ["worktree", "add", "--detach", worktree, baseCommit]);
    const links = [];
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
        if (!existsSync(baseTsconfig))
            throw new Error(`${tsconfigRel} doesn't exist at ${input.baseRef} (${baseCommit.slice(0, 10)})`);
        const { result, base, pr } = checkCyclesOpen({ base: baseTsconfig, pr: prTsconfig, renames, outcomes: input.outcomes });
        // The base index is in memory, so it outlives the worktree removed below.
        return { result: { ...result, base_commit: baseCommit, renames }, base, pr, gitRoot };
    }
    finally {
        for (const link of links) {
            try {
                unlinkSync(link);
            }
            catch {
                rmdirSync(link); // a Windows junction is removed as a directory, without touching its target
            }
        }
        git(gitRoot, ["worktree", "remove", "--force", worktree]);
    }
}
//# sourceMappingURL=git.js.map