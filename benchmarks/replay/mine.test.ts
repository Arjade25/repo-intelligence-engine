import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mine } from "./mine.js";

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

const mod = (name: string, deps: string[]) =>
  deps.map((d) => `import { ${d} } from "./${d}";\n`).join("") + `export const ${name} = () => [${deps.join(", ")}];\n`;

describe("mine (oracle-only search for cycle changes)", () => {
  it("finds exactly the commits that change runtime cycles, without computing every commit", () => {
    const repo = mkdtempSync(join(tmpdir(), "rie-mine-"));
    mkdirSync(join(repo, "src"));
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(
      join(repo, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "preserve", moduleResolution: "bundler", target: "es2022", noEmit: true }, include: ["src/**/*.ts"] })
    );
    const shas: string[] = [];
    const commit = (files: Record<string, string>) => {
      for (const [p, c] of Object.entries(files)) writeFileSync(join(repo, "src", p), c);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", `c${shas.length}`);
      shas.push(git(repo, "rev-parse", "HEAD"));
    };
    commit({ "a.ts": mod("a", ["b"]), "b.ts": mod("b", ["c"]), "c.ts": mod("c", []) });
    for (let i = 1; i <= 8; i++) {
      // c3 closes a loop; c6 routes it through a new file d (the group grows); the rest add unrelated files.
      if (i === 3) commit({ "c.ts": mod("c", ["a"]) });
      else if (i === 6) commit({ "c.ts": mod("c", ["d"]), "d.ts": mod("d", ["a"]) });
      else commit({ [`n${i}.ts`]: `export const n${i} = ${i};\n` });
    }

    const { changed, computed } = mine({ repo, tsconfig: "tsconfig.json", commits: shas, stride: 4 });
    expect(changed).toEqual([shas[3], shas[6]]);
    expect(computed).toBeLessThan(shas.length);
  });
}, 120_000);
