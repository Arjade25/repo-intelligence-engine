import { describe, expect, it } from "vitest";
import { checkCycles } from "../check/index.js";
import { CYCLE_EVENT_CASES, materialize } from "../check/cycle-events.cases.js";
import { factsFromEvent, parseFinding, type Finding } from "./finding.js";

const grownEvent = () => {
  const c = CYCLE_EVENT_CASES.find((x) => x.name === "cycle_grown")!;
  const result = checkCycles({ base: materialize(c.base, "finding-base"), pr: materialize(c.pr, "finding-pr") });
  return result.events.find((e) => e.type === "cycle_grown")!;
};

const finding = (facts: Finding["facts"]): Finding => ({
  version: 1,
  event: "cycle_grown",
  facts,
  why_it_matters: "The new import pulls a file into the runtime cycle.",
  suggestions: [{ text: "Import it lazily.", verified: false }],
});

describe("finding format", () => {
  it("states a rie check event's evidence as facts that parse", () => {
    const event = grownEvent();
    const facts = factsFromEvent(event);
    expect(facts.loops).toHaveLength(event.evidence!.length);
    const [loop] = facts.loops;
    expect(loop.hops.map((h) => h.from)).toEqual(event.evidence![0].loop.slice(0, -1));
    expect(loop.hops[0]).toMatchObject({ runtime: true, added_in_pr: true });
    expect(loop.hops.every((h) => h.line > 0)).toBe(true);
    expect(parseFinding(JSON.stringify(finding(facts)))).toEqual({ ok: true, finding: finding(facts) });
  });

  it("refuses a suggestion marked verified, extra fields, and a missing explanation", () => {
    const facts = factsFromEvent(grownEvent());
    const r = parseFinding({ ...finding(facts), why_it_matters: "", suggestions: [{ text: "x", verified: true }], confidence: "high" });
    expect(r.ok).toBe(false);
    const errors = (r as { errors: string[] }).errors.join("\n");
    expect(errors).toContain("why_it_matters");
    expect(errors).toContain("suggestions.0.verified");
    expect(errors).toContain("confidence");
  });

  it("refuses loops that don't chain or don't close", () => {
    const hop = { line: 1, statement: "import x", runtime: true, added_in_pr: false };
    const broken = parseFinding(finding({ loops: [{ hops: [{ ...hop, from: "a.ts", to: "b.ts" }, { ...hop, from: "c.ts", to: "a.ts" }] }] }));
    expect(broken.ok).toBe(false);
    expect((broken as { errors: string[] }).errors.join()).toContain("hop 0 ends at b.ts but hop 1 starts at c.ts");
    const open = parseFinding(finding({ loops: [{ hops: [{ ...hop, from: "a.ts", to: "b.ts" }] }] }));
    expect((open as { errors: string[] }).errors.join()).toContain("loop doesn't close");
    expect(parseFinding(finding({ loops: [] })).ok).toBe(false);
  });

  it("refuses text that isn't JSON", () => {
    expect(parseFinding("Here is the finding: {")).toMatchObject({ ok: false });
  });
});
