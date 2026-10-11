import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CYCLE_EVENT_CASES, materialize, type ExpectedEvent, type Outcome } from "./cycle-events.cases.js";

/**
 * The cycle event rules as the contract `rie check` must meet (plan, week 1:
 * "write the rules as test cases before any code"). Skipped until
 * src/check/index.ts exists; the cases' premises are already checked against a
 * real tsc emit in benchmarks/oracle/cycle-events.test.ts.
 *
 * The contract: checkCycles({ base, pr, renames? }) takes the two snapshots'
 * tsconfig paths and git's renames (base path -> PR path, relative to the
 * snapshot root), and returns the PR outcome and every event, with paths
 * relative to the snapshot root. Each event must match its expected fields;
 * extra fields are allowed.
 */
interface CycleCheck {
  checkCycles(input: { base: string; pr: string; renames?: Record<string, string> }): {
    outcome: Outcome;
    events: ExpectedEvent[];
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// Not a literal specifier, so the build doesn't fail while the module doesn't exist yet.
const entry = "./index.js";
const check: CycleCheck | null = existsSync(join(__dirname, "index.ts")) ? ((await import(entry)) as CycleCheck) : null;

const order = (events: ExpectedEvent[]) =>
  [...events].sort((x, y) =>
    `${x.type} ${JSON.stringify(x.base_groups)} ${JSON.stringify(x.pr_groups)}`.localeCompare(
      `${y.type} ${JSON.stringify(y.base_groups)} ${JSON.stringify(y.pr_groups)}`
    )
  );

describe.skipIf(!check)("rie check: cycle events", () => {
  for (const c of CYCLE_EVENT_CASES) {
    it(`${c.name} - ${c.rule}`, () => {
      const base = materialize(c.base, `${c.name}-base`);
      const pr = materialize(c.pr, `${c.name}-pr`);
      const result = check!.checkCycles({ base, pr, renames: c.renames });
      expect(result.outcome).toBe(c.expected.outcome);
      expect(order(result.events)).toMatchObject(order(c.expected.events));
      if (c.expected_without_renames) {
        expect(check!.checkCycles({ base, pr }).outcome).toBe(c.expected_without_renames.outcome);
      }
    });
  }
});
