import { afterAll, describe, expect, it } from "vitest";
import { compareSnapshots, indexSnapshot, type CycleEvent, type Snapshot } from "../check/index.js";
import { CYCLE_EVENT_CASES, materialize, modules } from "../check/cycle-events.cases.js";
import { factsFromEvent, type FactHop, type Finding } from "./finding.js";
import { checkFinding, verifyFinding, type VerifyContext } from "./verify.js";

const open: Snapshot[] = [];
afterAll(() => open.forEach((s) => s.db.close()));

function index(snapshot: Record<string, string>, label: string): Snapshot {
  const s = indexSnapshot(materialize(snapshot, label));
  open.push(s);
  return s;
}

const finding = (event: CycleEvent["type"], loops: FactHop[][]): Finding => ({
  version: 1,
  event,
  facts: { loops: loops.map((hops) => ({ hops })) },
  why_it_matters: "The new import pulls a file into the runtime cycle.",
  suggestions: [{ text: "Import it lazily.", verified: false }],
});

const errorsOf = (r: ReturnType<typeof verifyFinding>) => (r.ok ? [] : r.errors).join("\n");

describe("verifier: every real rie check finding verifies", () => {
  for (const c of CYCLE_EVENT_CASES) {
    const flagged = c.expected.events.filter((e) => e.outcome !== "pass");
    if (flagged.length === 0) continue;
    it(c.name, () => {
      const base = index(c.base, `verify-${c.name}-base`);
      const pr = index(c.pr, `verify-${c.name}-pr`);
      const result = compareSnapshots(base, pr, { renames: c.renames });
      for (const event of result.events.filter((e) => e.outcome !== "pass")) {
        const f: Finding = { ...finding(event.type, []), facts: factsFromEvent(event) };
        expect(verifyFinding(f, { event, pr, base, renames: c.renames })).toEqual({ ok: true, finding: f });
      }
    });
  }
});

describe("verifier: fabricated facts are refused", () => {
  // Base: a -> b -> c -> a. The PR adds b -> d -> a (d joins the cycle) and a
  // type-only c -> d, which would close a shorter loop if it were counted.
  const base = index(modules({ a: ["b"], b: ["c"], c: ["a"] }), "verify-trap-base");
  const pr = index(
    {
      ...modules({ a: ["b"], b: ["c", "d"] }),
      "c.ts": 'import { a } from "./a.js";\nimport type { D } from "./d.js";\nexport const c = (x: D | null) => [a, x];\n',
      "d.ts": 'import { a } from "./a.js";\nexport type D = number;\nexport const d = () => [a];\n',
    },
    "verify-trap-pr"
  );
  const event = compareSnapshots(base, pr).events.find((e) => e.type === "cycle_grown")!;
  const ctx: VerifyContext = { event, pr, base };

  const hop = (from: string, to: string, line: number, added_in_pr: boolean, runtime = true): FactHop => ({
    from: `src/${from}.ts`,
    to: `src/${to}.ts`,
    line,
    statement: runtime ? `import { ${to} } from "./${to}.js";` : `import type { D } from "./${to}.js";`,
    runtime,
    added_in_pr,
  });
  // The real loop: b -> d (b.ts:2, new), d -> a (d.ts:1, new), a -> b (a.ts:1, on base).
  const real = () => [hop("b", "d", 2, true), hop("d", "a", 1, true), hop("a", "b", 1, false)];

  it("accepts the real loop", () => {
    expect(event.evidence).toHaveLength(1);
    expect(verifyFinding(finding("cycle_grown", [real()]), ctx).ok).toBe(true);
  });

  it("refuses a wrong line and names the right one", () => {
    const hops = real();
    hops[0].line = 3;
    expect(errorsOf(verifyFinding(finding("cycle_grown", [hops]), ctx))).toBe(
      "facts.loops.0.hops.0: src/b.ts has no import of src/d.ts at line 3 (it imports it at line 2)"
    );
  });

  it("refuses a misquoted statement", () => {
    const hops = real();
    hops[1].statement = 'import { a, extra } from "./a.js";';
    expect(errorsOf(verifyFinding(finding("cycle_grown", [hops]), ctx))).toContain('the statement at src/d.ts:1 is "import { a } from \\"./a.js\\";"');
  });

  it("refuses an import that doesn't exist", () => {
    const r = verifyFinding(finding("cycle_grown", [[hop("a", "d", 1, true), hop("d", "a", 1, true)]]), ctx);
    expect(errorsOf(r)).toBe("facts.loops.0.hops.0: src/a.ts does not import src/d.ts");
  });

  it("refuses a loop through a type-only import, labelled either way", () => {
    // c -> d -> a -> b -> c would be a loop if c's `import type` from d survived.
    const asRuntime = [{ ...hop("c", "d", 2, true, false), runtime: true }, hop("d", "a", 1, true), hop("a", "b", 1, false), hop("b", "c", 1, false)];
    const errors = errorsOf(verifyFinding(finding("cycle_grown", [asRuntime]), ctx));
    expect(errors).toContain("src/c.ts:2 is type-only (erased at compile time), but the finding says the opposite");
    expect(errors).toContain("src/c.ts:2 is erased at compile time, so this loop is not a runtime cycle");

    const honest = [hop("c", "d", 2, true, false), ...asRuntime.slice(1)];
    expect(errorsOf(verifyFinding(finding("cycle_grown", [honest]), ctx))).toBe(
      "facts.loops.0.hops.0: the import at src/c.ts:2 is erased at compile time, so this loop is not a runtime cycle"
    );
  });

  it("refuses a wrong added-in-PR claim", () => {
    const hops = real();
    hops[2].added_in_pr = true;
    expect(errorsOf(verifyFinding(finding("cycle_grown", [hops]), ctx))).toBe(
      "facts.loops.0.hops.2: src/a.ts -> src/b.ts is already a runtime import on the base branch, but the finding says the opposite"
    );
  });

  it("refuses a true loop the PR didn't touch", () => {
    const old = [hop("a", "b", 1, false), hop("b", "c", 1, false), hop("c", "a", 1, false)];
    expect(errorsOf(verifyFinding(finding("cycle_grown", [old]), ctx))).toBe(
      "facts.loops.0: no hop of this loop is an import the PR added, so it doesn't show what the PR changed"
    );
  });

  it("refuses the wrong event type and files the PR doesn't have", () => {
    expect(errorsOf(verifyFinding(finding("new_cycle", [real()]), ctx))).toBe("event: the finding explains new_cycle, but the event is cycle_grown");
    const hops = [hop("b", "z", 3, true), hop("z", "b", 1, true)];
    expect(errorsOf(verifyFinding(finding("cycle_grown", [hops]), ctx))).toContain("facts.loops.0.hops.0: src/z.ts is not a file in the PR");
  });

  it("checks shape first, from raw JSON text", () => {
    expect(checkFinding(JSON.stringify(finding("cycle_grown", [real()])), ctx).ok).toBe(true);
    const r = checkFinding("Here is the finding: {", ctx);
    expect(r.ok).toBe(false);
    expect(errorsOf(r)).toContain("not JSON");
  });
});
