import { describe, expect, it } from "vitest";
import { checkCycles } from "./index.js";
import { CYCLE_EVENT_CASES, materialize, type ExpectedEvent } from "./cycle-events.cases.js";

/**
 * The cycle event rules as the contract `rie check` must meet, written before the
 * check existed (plan, week 1). The cases' premises are checked against a real tsc
 * emit in benchmarks/oracle/cycle-events.test.ts. Each event must match its
 * expected fields; extra fields are allowed.
 */

const order = <T extends Pick<ExpectedEvent, "type" | "base_groups" | "pr_groups">>(events: T[]) =>
  [...events].sort((x, y) =>
    `${x.type} ${JSON.stringify(x.base_groups)} ${JSON.stringify(x.pr_groups)}`.localeCompare(
      `${y.type} ${JSON.stringify(y.base_groups)} ${JSON.stringify(y.pr_groups)}`
    )
  );

describe("rie check: cycle events", () => {
  for (const c of CYCLE_EVENT_CASES) {
    it(`${c.name} - ${c.rule}`, () => {
      const base = materialize(c.base, `${c.name}-base`);
      const pr = materialize(c.pr, `${c.name}-pr`);
      const result = checkCycles({ base, pr, renames: c.renames });
      expect(result.outcome).toBe(c.expected.outcome);
      expect(order(result.events)).toMatchObject(order(c.expected.events));
      expect(result.warnings).toEqual([]);
      // Each loop is found through an import the PR added, and says which of its hops are new.
      for (const { hops } of result.events.flatMap((e) => e.evidence ?? [])) {
        expect(hops.every((h) => typeof h.added === "boolean")).toBe(true);
        expect(hops[0].added).toBe(true);
      }
      if (c.expected_without_renames) {
        expect(checkCycles({ base, pr }).outcome).toBe(c.expected_without_renames.outcome);
      }
    });
  }

  it("takes per-repo outcome overrides", () => {
    const grown = CYCLE_EVENT_CASES.find((c) => c.name === "cycle_grown")!;
    const result = checkCycles({
      base: materialize(grown.base, "override-base"),
      pr: materialize(grown.pr, "override-pr"),
      outcomes: { cycle_grown: "warn" },
    });
    expect(result.outcome).toBe("warn");
    expect(result.events[0]).toMatchObject({ type: "cycle_grown", outcome: "warn" });
    expect(result.events[0].evidence).toHaveLength(1); // a warning still shows its loop
  });
});
