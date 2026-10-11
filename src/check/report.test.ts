import { describe, expect, it } from "vitest";
import { checkCycles, type CycleCheckResult } from "./index.js";
import { COMMENT_MARKER, formatMarkdown } from "./report.js";
import { CYCLE_EVENT_CASES, materialize } from "./cycle-events.cases.js";

function run(name: string): CycleCheckResult {
  const c = CYCLE_EVENT_CASES.find((x) => x.name === name)!;
  return checkCycles({ base: materialize(c.base, `md-${name}-base`), pr: materialize(c.pr, `md-${name}-pr`), renames: c.renames });
}

describe("formatMarkdown (the PR comment)", () => {
  it("starts with the marker, tables every event strictest first, and shows each finding's loop", () => {
    const md = formatMarkdown(run("several events, one fails"), { baseCommit: "0123456789abcdef", baseRef: "origin/main" });
    expect(md.startsWith(`${COMMENT_MARKER}\n### rie check: fail\n`)).toBe(true);
    expect(md).toContain("Compared with `0123456789`, the merge base with `origin/main`.");
    expect(md).toContain("Runtime import cycle groups: 1 on base, 1 with this PR.");
    const rows = md.split("\n").filter((l) => l.startsWith("| fail") || l.startsWith("| pass"));
    expect(rows).toEqual(["| fail | `new_cycle` | new runtime cycle of 2 files |", "| pass | `cycle_resolved` | cycle of 2 files resolved |"]);
    expect(md).toContain("#### fail: `new_cycle`, new runtime cycle of 2 files");
    expect(md).toContain("Joined: `src/x.ts`, `src/y.ts`");
    expect(md).toContain(['```', 'src/y.ts:1  import { x } from "./x.js";  (runtime: x)', 'src/x.ts:1  import { y } from "./y.js";  (runtime: y)', '```'].join("\n"));
    expect(md).not.toContain("#### pass"); // a pass event gets its row and nothing else
  });

  it("is one table row for a clean PR", () => {
    const md = formatMarkdown(run("no_regression"));
    expect(md).toContain("### rie check: pass");
    expect(md).toContain("| pass | `no_regression` |");
    expect(md).not.toContain("####");
  });

  it("caps long file lists and loop counts, so a big group can't overflow a comment", () => {
    const files = Array.from({ length: 30 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);
    const loop = { loop: ["src/a.ts", "src/b.ts", "src/a.ts"], hops: [{ at: "src/a.ts:1", statement: "x" }, { at: "src/b.ts:1", statement: "y" }] };
    const md = formatMarkdown({
      outcome: "fail",
      events: [{ type: "new_cycle", outcome: "fail", base_groups: [], pr_groups: [files], joined: files, evidence: Array(8).fill(loop) }],
      groups: { base: [], pr: [files] },
      warnings: [],
    });
    expect(md).toContain("`src/f19.ts` and 10 more");
    expect(md.match(/Loop of 2 files/g)).toHaveLength(5);
    expect(md).toContain("3 more loop(s) in the job log.");
  });
});
