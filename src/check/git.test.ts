import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAgainstRef, parseRenames } from "./git.js";
import { formatLoop, formatReport } from "./report.js";
import { indexSnapshot, loopEvidence } from "./index.js";
import { modules } from "./cycle-events.cases.js";

function run(cwd: string, ...args: string[]) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** A git repo whose tsconfig sits in packages/app, with a node_modules at the root. */
function repo(files: Record<string, string>): { root: string; app: string; tsconfig: string } {
  const root = mkdtempSync(join(tmpdir(), "rie-check-git-"));
  const app = join(root, "packages", "app");
  mkdirSync(join(app, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  writeFileSync(join(app, "package.json"), JSON.stringify({ type: "commonjs" }));
  writeFileSync(
    join(app, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, rootDir: "./src" }, include: ["src/**/*"] })
  );
  for (const [p, c] of Object.entries(files)) writeFileSync(join(app, "src", p), c);
  run(root, "init", "-q", "-b", "main");
  run(root, "add", ".");
  run(root, "commit", "-q", "-m", "base");
  return { root, app, tsconfig: join(app, "tsconfig.json") };
}

describe("indexSnapshot", () => {
  it("takes a relative tsconfig path, and cites each hop with the names that survive compilation", () => {
    const snapshot = indexSnapshot("fixtures/type-only-repo/tsconfig.json");
    expect(snapshot.groups).toEqual([["src/c.ts", "src/d.ts"]]);
    const ev = loopEvidence(snapshot, "src/c.ts", "src/d.ts")!;
    expect(ev.loop).toEqual(["src/c.ts", "src/d.ts", "src/c.ts"]);
    expect(ev.hops).toEqual([
      { at: "src/c.ts:2", statement: 'import { d } from "./d";', runtime_names: ["d"] },
      { at: "src/d.ts:1", statement: 'import { c } from "./c";', runtime_names: ["c"] },
    ]);
    expect(formatLoop(ev).join("\n")).toContain("(runtime: d)");
    snapshot.db.close();
  });
});

describe("parseRenames", () => {
  it("keeps renames inside the tsconfig's directory, relative to it", () => {
    const out = "M\tpackages/app/src/a.ts\nR095\tpackages/app/src/c.ts\tpackages/app/src/c2.ts\nR100\tpackages/app/src/x.ts\tother/x.ts\nA\tREADME.md";
    expect(parseRenames(out, "packages/app")).toEqual({ "src/c.ts": "src/c2.ts" });
    expect(parseRenames("R100\tsrc/a.ts\tsrc/b.ts", "")).toEqual({ "src/a.ts": "src/b.ts" });
  });
});

describe("checkAgainstRef", () => {
  it("compares the working tree with the merge base, reads renames from git, and cleans up", () => {
    const { root, app, tsconfig } = repo(modules({ a: ["b"], b: ["c"], c: ["a"], e: [] }));
    run(root, "checkout", "-q", "-b", "feature");
    // Rename c.ts inside the cycle, and close a new loop e <-> f.
    renameSync(join(app, "src", "c.ts"), join(app, "src", "c2.ts"));
    writeFileSync(join(app, "src", "b.ts"), 'import { c } from "./c2.js";\nexport const b = () => [c];\n');
    for (const [p, c] of Object.entries(modules({ e: ["f"], f: ["e"] }))) writeFileSync(join(app, "src", p), c);
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "pr");
    // A commit on main after the branch point must not count against the PR.
    run(root, "checkout", "-q", "main");
    writeFileSync(join(app, "src", "g.ts"), 'import { e } from "./e.js";\nexport const g = () => [e];\n');
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "main moves on");
    run(root, "checkout", "-q", "feature");

    const result = checkAgainstRef({ pr: tsconfig, baseRef: "main" });

    expect(result.base_commit).toBe(run(root, "rev-parse", "HEAD~1"));
    expect(result.renames).toEqual({ "src/c.ts": "src/c2.ts" });
    expect(result.outcome).toBe("fail");
    expect(result.events.map((e) => e.type)).toEqual(["new_cycle"]); // the rename isn't a file joining a group
    expect(result.events[0].pr_groups).toEqual([["src/e.ts", "src/f.ts"]]);
    expect(result.warnings).toEqual([]);
    expect(formatReport(result)).toContain("src/e.ts:1  import { f } from \"./f.js\";");

    expect(run(root, "worktree", "list").split("\n")).toHaveLength(1);
    expect(existsSync(join(root, "node_modules", "dep"))).toBe(true); // the linked node_modules survived cleanup
  }, 60_000);
});
