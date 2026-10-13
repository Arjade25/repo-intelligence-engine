import { afterAll, describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { checkCyclesOpen } from "../check/index.js";
import { CYCLE_EVENT_CASES, materialize } from "../check/cycle-events.cases.js";
import { formatMarkdown, safeProse } from "../check/report.js";
import { factsFromEvent, type Finding } from "./finding.js";
import { explainEvents, type PrExplanation } from "./pr.js";
import type { InvestigationInput, InvestigationResult } from "./runtime.js";

const c = CYCLE_EVENT_CASES.find((x) => x.name === "cycle_grown")!;
const prTsconfig = materialize(c.pr, "pr-explain-pr");
const { result, base, pr } = checkCyclesOpen({ base: materialize(c.base, "pr-explain-base"), pr: prTsconfig });
afterAll(() => [base, pr].forEach((s) => s.db.close()));
const index = result.events.findIndex((e) => e.type === "cycle_grown");
const event = result.events[index];

const finding = (fields: Partial<Finding> = {}): Finding => ({
  version: 1,
  event: "cycle_grown",
  facts: factsFromEvent(event),
  why_it_matters: "b.ts now imports d.ts, which imports a.ts, so d.ts joins the cycle.",
  suggestions: [{ text: "Move what b needs from d into b.", verified: false }],
  ...fields,
});

/** query() stand-in: each call yields the next reply. */
function replies(...drafts: unknown[]) {
  let i = 0;
  return ((_: { options: Options }) =>
    (async function* () {
      yield { type: "result", subtype: "success", structured_output: drafts[i++], total_cost_usd: 0.03, num_turns: 2, session_id: "s1" } as unknown as SDKMessage;
    })()) as unknown as InvestigationInput["run"];
}

const explainWith = (run: InvestigationInput["run"], extra = {}) => explainEvents({ result, pr, base, tsconfig: prTsconfig, diff: "", run, ...extra });

describe("explainEvents", () => {
  it("explains each fail and warn event that has evidence", async () => {
    const out = await explainWith(replies(finding()));
    expect(out).toEqual([{ event_index: index, explanation: expect.objectContaining({ source: "agent", finding: finding() }) }]);
  });

  it("gives events past the limit rie check's facts only, without running the agent", async () => {
    const out = await explainWith(replies(), { maxEvents: 0 });
    expect(out[0].explanation).toMatchObject({ source: "deterministic", reason: "only the first 0 finding(s) are explained", attempts: [] });
  });

  it("survives an agent that throws", async () => {
    const run = (() => {
      throw new Error("no credentials");
    }) as unknown as InvestigationInput["run"];
    const out = await explainWith(run);
    expect(out[0].explanation).toMatchObject({ source: "deterministic", facts: factsFromEvent(event) });
  });
});

describe("PR comment with explanations", () => {
  const agent = (f: Finding): PrExplanation[] => [{ event_index: index, explanation: { source: "agent", finding: f, attempts: [], cost_usd: 0.03 } }];

  it("puts rie check's loops first, then the explanation, then the unverified suggestions", () => {
    const md = formatMarkdown(result, {}, agent(finding()));
    const at = (s: string) => md.indexOf(s);
    expect(at("Loop of 3 files through an import this PR adds")).toBeGreaterThan(0);
    expect(at("##### Explanation (verified facts)")).toBeGreaterThan(at("Loop of 3 files"));
    expect(at("so d.ts joins the cycle")).toBeGreaterThan(at("##### Explanation"));
    expect(at("##### Suggestions (not verified)")).toBeGreaterThan(at("so d.ts joins the cycle"));
    expect(md).toContain("- Move what b needs from d into b.");
    // The agent's loops are rie check's own here, so they aren't shown twice.
    expect(md).not.toContain("Loops the explanation cites");
  });

  it("shows loops the agent cites beyond rie check's", () => {
    const extra = { hops: [...finding().facts.loops[0].hops].reverse() } as Finding["facts"]["loops"][number];
    const md = formatMarkdown(result, {}, agent(finding({ facts: { loops: [...finding().facts.loops, extra] } })));
    expect(md).toContain("Loops the explanation cites (every hop checked against the import graph):");
  });

  it("shows none of the agent's text when it has no verified finding", () => {
    const rejected: InvestigationResult = { status: "rejected", draft: finding({ why_it_matters: "SECRET DRAFT" }), errors: ["x"], tool_calls: 0, refused: [], cost_usd: 0.03, num_turns: 2, wall_ms: 1 };
    const md = formatMarkdown(result, {}, [
      { event_index: index, explanation: { source: "deterministic", facts: factsFromEvent(event), reason: "failed twice: x", attempts: [rejected, rejected], cost_usd: 0.06 } },
    ]);
    expect(md).toContain("No explanation for this finding: its draft didn't pass verification.");
    expect(md).not.toContain("SECRET DRAFT");
    expect(md).not.toContain("##### Explanation");
  });

  it("escapes HTML and @-mentions in the agent's text", () => {
    expect(safeProse("ping @octocat <img src=x onerror=alert(1)>")).toBe(`ping @${String.fromCharCode(0x200b)}octocat &lt;img src=x onerror=alert(1)&gt;`);
    expect(safeProse("x".repeat(5000))).toHaveLength(3001);
    const md = formatMarkdown(result, {}, agent(finding({ suggestions: [{ text: "line one\n\nline two <b>", verified: false }] })));
    expect(md).toContain("- line one line two &lt;b&gt;");
  });

  it("is unchanged without explanations", () => {
    expect(formatMarkdown(result, {}, [])).toBe(formatMarkdown(result));
  });
});
