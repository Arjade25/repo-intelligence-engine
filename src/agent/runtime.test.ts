import { afterAll, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import type { HookCallback, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { compareSnapshots, indexSnapshot, type Snapshot } from "../check/index.js";
import { CYCLE_EVENT_CASES, materialize } from "../check/cycle-events.cases.js";
import { factsFromEvent, type Finding } from "./finding.js";
import { buildPrompt, createGate, diffFiles, explain, investigate, promptDiff, READ_ONLY_MCP_TOOLS, readableFiles, revisePrompt, type InvestigationInput } from "./runtime.js";

const c = CYCLE_EVENT_CASES.find((x) => x.name === "cycle_grown")!;
const baseTsconfig = materialize(c.base, "runtime-base");
const prTsconfig = materialize(c.pr, "runtime-pr");
const base = indexSnapshot(baseTsconfig);
const pr: Snapshot = indexSnapshot(prTsconfig);
afterAll(() => [base, pr].forEach((s) => s.db.close()));

const event = compareSnapshots(base, pr).events.find((e) => e.type === "cycle_grown")!;
const root = dirname(prTsconfig);
const diff = [
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1,2 +1,3 @@",
  ' import { c } from "./c.js";',
  '+import { d } from "./d.js";',
  "diff --git a/src/d.ts b/src/d.ts",
  "--- /dev/null",
  "+++ b/src/d.ts",
  "@@ -0,0 +1,2 @@",
  '+import { a } from "./a.js";',
].join("\n");

const goodFinding = (): Finding => ({
  version: 1,
  event: "cycle_grown",
  facts: factsFromEvent(event),
  why_it_matters: "b.ts now imports d.ts, which imports a.ts, so d.ts joins the a-b-c cycle.",
  suggestions: [{ text: "Move what b needs from d into b.", verified: false }],
});

const result = (fields: Record<string, unknown>) =>
  ({ type: "result", subtype: "success", total_cost_usd: 0.02, num_turns: 2, session_id: "s1", is_error: false, ...fields }) as unknown as SDKMessage;

/** A stand-in for the SDK's query(): records the options, makes the given tool calls through the hook, then yields `messages`. */
function stub(messages: SDKMessage[], calls: [string, unknown][] = []) {
  const seen: { options?: Options; prompt?: string; hookResults: unknown[] } = { hookResults: [] };
  const run = (({ prompt, options }: { prompt: string; options: Options }) => {
    seen.options = options;
    seen.prompt = prompt;
    return (async function* () {
      const hook = options.hooks!.PreToolUse![0].hooks[0] as HookCallback;
      for (const [tool_name, tool_input] of calls) {
        seen.hookResults.push(
          await hook({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t", session_id: "s1", transcript_path: "", cwd: root } as never, "t", {
            signal: new AbortController().signal,
          })
        );
      }
      yield* messages;
    })();
  }) as unknown as InvestigationInput["run"];
  return { run, seen };
}

const input = (run: InvestigationInput["run"], extra: Partial<InvestigationInput> = {}): InvestigationInput => ({ event, pr, base, tsconfig: prTsconfig, diff, run, ...extra });

describe("agent runtime: what the agent may touch", () => {
  it("lists the diff's files and the finding's files", () => {
    expect(diffFiles(diff)).toEqual(["src/b.ts", "src/d.ts"]);
    const files = readableFiles(event, diff, root, root);
    expect(files).toHaveLength(3); // a, b, d: the loop, plus b and d from the diff
    expect(files.some((f) => f.endsWith("/src/c.ts"))).toBe(false);
  });

  it("gate: read-only rie tools and Read on listed files, up to the cap", () => {
    const gate = createGate(readableFiles(event, diff, root, root), 3);
    expect(gate.decide("mcp__rie__find_cycle_through_file", {})).toEqual({ allow: true });
    expect(gate.decide("mcp__rie__reindex", {})).toMatchObject({ allow: false });
    expect(gate.decide("Bash", { command: "ls" })).toMatchObject({ allow: false });
    expect(gate.decide("Read", { file_path: join(root, "src", "c.ts") })).toMatchObject({ allow: false });
    expect(gate.decide("Read", { file_path: "src/b.ts" })).toMatchObject({ allow: false }); // relative: refused
    expect(gate.decide("Read", { file_path: join(root, "src", "b.ts") })).toEqual({ allow: true });
    expect(gate.decide("mcp__rie__dependency_path", {})).toEqual({ allow: true });
    expect(gate.used()).toBe(3);
    expect(gate.decide("mcp__rie__find_module", {})).toMatchObject({ allow: false, reason: expect.stringContaining("Write the finding now") });
    // The answer itself goes through the SDK's StructuredOutput tool: allowed past the cap, never counted.
    expect(gate.decide("StructuredOutput", { version: 1 })).toEqual({ allow: true });
    expect(gate.used()).toBe(3);
    expect(READ_ONLY_MCP_TOOLS).not.toContain("mcp__rie__reindex");
  });

  it("starts the session isolated, capped, and asking for a finding", async () => {
    const { run, seen } = stub([result({ structured_output: goodFinding() })]);
    await investigate(input(run, { limits: { maxBudgetUsd: 0.25, maxToolCalls: 6 } }));
    const o = seen.options!;
    expect(o).toMatchObject({
      tools: ["Read"],
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: "dontAsk",
      disallowedTools: ["mcp__rie__reindex"],
      maxBudgetUsd: 0.25,
      maxTurns: 10,
      model: "claude-opus-5-5",
      outputFormat: { type: "json_schema" },
    });
    expect(o.allowedTools).toEqual(["Read", ...READ_ONLY_MCP_TOOLS]);
    expect(o.mcpServers!.rie).toMatchObject({ type: "sdk", name: "rie" });
    const schema = (o.outputFormat as unknown as { schema: { required: string[]; additionalProperties: boolean } }).schema;
    expect(schema.required).toEqual(["version", "event", "facts", "why_it_matters", "suggestions"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema).not.toHaveProperty("$schema"); // the CLI rejects zod's draft 2020-12 URL
    expect(seen.prompt).toBe(buildPrompt(event, root, diff));
    expect(seen.prompt).toContain('"added_in_pr": true');
  });
});

describe("agent runtime: the diff in the prompt", () => {
  it("keeps a short diff whole, and only the finding's files of a long one", () => {
    expect(promptDiff(diff, () => false)).toBe(diff);
    const filler = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${"+x\n".repeat(20_000)}`;
    const long = [filler("src/big.ts"), diff].join("\n");
    const kept = promptDiff(long, (p) => p === "src/b.ts" || p === "src/d.ts");
    expect(kept).toContain('+import { d } from "./d.js";');
    expect(kept).not.toContain("src/big.ts");
    expect(kept).toMatch(/\(1 other file\(s\) changed by this PR are left out of this diff, which was \d+ characters\.\)$/);
  });
});

describe("agent runtime: every draft is verified", () => {
  it("passes a true finding through", async () => {
    const { run } = stub([result({ structured_output: goodFinding() })], [["mcp__rie__find_cycle_through_file", { file_path: "src/d.ts" }]]);
    const r = await investigate(input(run));
    expect(r).toMatchObject({ status: "verified", finding: goodFinding(), errors: [], tool_calls: 1, cost_usd: 0.02, session_id: "s1" });
  });

  it("rejects a draft with a made-up hop, and keeps the draft and the reasons", async () => {
    const draft = goodFinding();
    draft.facts.loops[0].hops[0].line = 7;
    const { run } = stub([result({ structured_output: draft })]);
    const r = await investigate(input(run));
    expect(r.status).toBe("rejected");
    expect(r.draft).toEqual(draft);
    expect(r.errors).toEqual(["facts.loops.0.hops.0: src/b.ts has no import of src/d.ts at line 7 (it imports it at line 2)"]);
  });

  it("records refused tool calls", async () => {
    const { run, seen } = stub([result({ structured_output: goodFinding() })], [
      ["mcp__rie__reindex", {}],
      ["Read", { file_path: join(root, "src", "c.ts") }],
    ]);
    const r = await investigate(input(run));
    expect(r.tool_calls).toBe(0);
    expect(r.refused).toHaveLength(2);
    expect(seen.hookResults[0]).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("reports a spend stop as no draft", async () => {
    const { run } = stub([result({ subtype: "error_max_budget_usd", is_error: true, errors: [] })]);
    expect(await investigate(input(run))).toMatchObject({ status: "no_draft", stop: "error_max_budget_usd" });
  });

  it("stops at the time limit", async () => {
    const run = (({ options }: { options: Options }) =>
      (async function* () {
        await new Promise((_, reject) => options.abortController!.signal.addEventListener("abort", () => reject(new Error("aborted"))));
        yield result({});
      })()) as unknown as InvestigationInput["run"];
    expect(await investigate(input(run, { limits: { timeoutMs: 20 } }))).toMatchObject({ status: "no_draft", stop: "timeout" });
  });
});

/** A query() stand-in for several calls in a row: call i makes calls[i]'s tool calls, then yields replies[i]. */
function stubSequence(replies: SDKMessage[][], calls: [string, unknown][][] = []) {
  const seen: { options: Options[]; prompts: string[] } = { options: [], prompts: [] };
  const run = (({ prompt, options }: { prompt: string; options: Options }) => {
    const i = seen.options.length;
    seen.options.push(options);
    seen.prompts.push(prompt);
    return (async function* () {
      const hook = options.hooks!.PreToolUse![0].hooks[0] as HookCallback;
      for (const [tool_name, tool_input] of calls[i] ?? []) {
        await hook({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t", session_id: "s1", transcript_path: "", cwd: root } as never, "t", {
          signal: new AbortController().signal,
        });
      }
      yield* replies[i];
    })();
  }) as unknown as InvestigationInput["run"];
  return { run, seen };
}

const badDraft = () => {
  const draft = goodFinding();
  draft.facts.loops[0].hops[0].line = 7;
  return draft;
};
const lineError = "facts.loops.0.hops.0: src/b.ts has no import of src/d.ts at line 7 (it imports it at line 2)";

describe("revise loop", () => {
  it("uses a first draft that verifies, with no retry", async () => {
    const { run, seen } = stubSequence([[result({ structured_output: goodFinding() })]]);
    const e = await explain(input(run));
    expect(e).toMatchObject({ source: "agent", finding: goodFinding(), cost_usd: 0.02 });
    expect(seen.options).toHaveLength(1);
  });

  it("retries once in the same session with the verifier's reasons", async () => {
    const { run, seen } = stubSequence([
      [result({ structured_output: badDraft(), total_cost_usd: 0.1 })],
      [result({ structured_output: goodFinding(), total_cost_usd: 0.15 })],
    ]);
    const e = await explain(input(run, { limits: { maxBudgetUsd: 0.4 } }));
    expect(e).toMatchObject({ source: "agent", finding: goodFinding(), cost_usd: 0.15 });
    expect(e.attempts.map((a) => a.status)).toEqual(["rejected", "verified"]);
    expect(seen.options[1].resume).toBe("s1");
    expect(seen.options[1].maxBudgetUsd).toBeCloseTo(0.3);
    expect(seen.prompts[1]).toBe(revisePrompt([lineError]));
    expect(seen.prompts[1]).toContain(`- ${lineError}`);
  });

  it("falls back to the deterministic facts after a second rejection", async () => {
    const { run } = stubSequence([[result({ structured_output: badDraft() })], [result({ structured_output: badDraft() })]]);
    const e = await explain(input(run));
    expect(e.source).toBe("deterministic");
    if (e.source !== "deterministic") return;
    expect(e.facts).toEqual(factsFromEvent(event));
    expect(e.reason).toBe(`the agent's finding failed verification twice: ${lineError}`);
    expect(e.attempts).toHaveLength(2);
  });

  it("doesn't retry a session that ended without a draft", async () => {
    const { run, seen } = stubSequence([[result({ subtype: "error_max_turns", is_error: true, errors: [] })]]);
    const e = await explain(input(run));
    expect(e).toMatchObject({ source: "deterministic", reason: "the agent returned no finding (error_max_turns)" });
    expect(seen.options).toHaveLength(1);
  });

  it("doesn't retry when the first attempt spent the budget", async () => {
    const { run, seen } = stubSequence([[result({ structured_output: badDraft(), total_cost_usd: 0.5 })]]);
    expect((await explain(input(run, { limits: { maxBudgetUsd: 0.5 } }))).source).toBe("deterministic");
    expect(seen.options).toHaveLength(1);
  });

  it("shares the tool-call cap between the attempts", async () => {
    const find = ["mcp__rie__find_cycle_through_file", {}] as [string, unknown];
    const { run, seen } = stubSequence(
      [[result({ structured_output: badDraft() })], [result({ structured_output: goodFinding() })]],
      [[find, find, find], [find, find]]
    );
    const e = await explain(input(run, { limits: { maxToolCalls: 4 } }));
    expect(e.attempts.map((a) => a.tool_calls)).toEqual([3, 1]);
    expect(e.attempts[1].refused).toEqual([expect.stringContaining("Tool-call limit (4) reached")]);
    expect(seen.options[1].maxTurns).toBe(5); // 1 call left + the backstop's 4
  });
});
