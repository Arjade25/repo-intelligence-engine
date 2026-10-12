import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstParentCommits, replay, replaySeeds } from "./replay.js";
import { summarizeReplay } from "./summarize.js";

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** Extensionless imports under bundler resolution, like element-web. */
const mod = (name: string, deps: string[]) =>
  deps.map((d) => `import { ${d} } from "./${d}";\n`).join("") + `export const ${name} = () => [${deps.join(", ")}];\n`;

describe("replay (a four-commit history)", () => {
  const repo = mkdtempSync(join(tmpdir(), "rie-replay-"));
  mkdirSync(join(repo, "app", "src"), { recursive: true });
  writeFileSync(
    join(repo, "app", "tsconfig.json"),
    JSON.stringify({ compilerOptions: { module: "preserve", moduleResolution: "bundler", target: "es2022", strict: true, noEmit: true }, include: ["src/**/*.ts"] })
  );
  const commit = (message: string, files: Record<string, string>) => {
    for (const [p, c] of Object.entries(files)) writeFileSync(join(repo, p), c);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", message);
  };
  git(repo, "init", "-q", "-b", "main");
  commit("base", { "app/src/a.ts": mod("a", ["b"]), "app/src/b.ts": mod("b", ["c"]), "app/src/c.ts": mod("c", []), "README.md": "x\n" });
  commit("close a loop", { "app/src/c.ts": mod("c", ["a"]) });
  commit("docs only", { "README.md": "y\n" });
  commit("load a lazily", { "app/src/c.ts": 'export const c = () => import("./a");\n' });

  const records = replay({ repo, tsconfig: "app/tsconfig.json", commits: firstParentCommits(repo, "HEAD", 3), tools: ["rie", "oracle", "madge"] });

  it("compares each changed commit with its parent three ways, and skips the unchanged one", () => {
    expect(records.map((r) => [r.subject, r.status])).toEqual([
      ["close a loop", "compared"],
      ["docs only", "unchanged"],
      ["load a lazily", "compared"],
    ]);
    const [closed, , lazy] = records;
    for (const tool of ["rie", "oracle", "madge"] as const) {
      expect(closed.tools[tool]!.events).toEqual(['new_cycle [] [["src/a.ts","src/b.ts","src/c.ts"]]']);
    }
    expect(closed.tools.rie!.detail[0].evidence).toHaveLength(1); // RIE's events keep their evidence
    expect(closed.edges).toEqual({ agree: 3, rie_only: 0, oracle_only: 0 });

    // A dynamic import() is no load-time edge: the loop is gone. madge still counts it.
    expect(lazy.tools.oracle!.events).toEqual(['cycle_resolved [["src/a.ts","src/b.ts","src/c.ts"]] []']);
    expect(lazy.tools.rie!.events).toEqual(lazy.tools.oracle!.events);
    expect(lazy.tools.madge!.events).toEqual(["no_regression [] []"]);
  });

  it("scores each tool against the oracle's labels", () => {
    const s = summarizeReplay(records);
    expect(s).toMatchObject({ commits: 3, compared: 2, unchanged: 1, label_regressions: 1, label_changes: 2 });
    const [rie, madge] = s.tools;
    expect(rie).toMatchObject({ tool: "rie", detected: 1, false_alarms: 0, exact_events: 2, compared: 2 });
    expect(madge).toMatchObject({ tool: "madge", detected: 1, false_alarms: 0, exact_events: 1 });
    expect(s.disagreements.map((d) => [d.tool, d.subject])).toEqual([["madge", "load a lazily"]]);
  });

  it("seeds a commit with a loop-closing import and two type-only lookalikes, labelled by the oracle", () => {
    // At HEAD~2 ("close a loop" + docs): a -> b -> c -> a is a group. Seed at the base commit instead, where there's no loop yet.
    const base = firstParentCommits(repo, "HEAD", 4)[0];
    const seeds = replaySeeds({ repo, tsconfig: "app/tsconfig.json", commit: base, count: 1, seed: 1, tools: ["rie", "oracle", "madge"] });
    expect(seeds.map((r) => r.seed!.kind)).toEqual(["runtime", "type-only", "type-by-usage"]);
    const [runtime, typeOnly, byUsage] = seeds;
    expect(runtime.tools.oracle!.events[0]).toMatch(/^new_cycle /);
    expect(runtime.tools.rie!.events).toEqual(runtime.tools.oracle!.events);
    expect(runtime.tools.madge!.events).toEqual(runtime.tools.oracle!.events);
    for (const r of [typeOnly, byUsage]) {
      expect(r.tools.oracle!.outcome).toBe("pass");
      expect(r.tools.rie!.events).toEqual(r.tools.oracle!.events);
    }
    expect(typeOnly.tools.madge!.outcome).toBe("pass"); // madge skips `import type`...
    expect(byUsage.tools.madge!.outcome).toBe("fail"); // ...but not an import erased by how it's used
  });
}, 120_000);
