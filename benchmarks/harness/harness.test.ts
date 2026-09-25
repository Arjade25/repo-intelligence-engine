import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { generateTasks, type CycleTraceTask, type ImpactTask, type Task, type TrapTask } from "../taskgen/generate.js";
import { extractAnswerJson, gradeAnswer, toRepoRelative } from "./grade.js";
import { runBenchmark, summarize, type Runner } from "./bench.js";
import { parseTranscript, type TranscriptMetrics } from "./claude.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "../../fixtures/taskgen-repo").replace(/\\/g, "/");
const set = generateTasks({ tsconfigPath: `${FIXTURE}/tsconfig.json`, repo: "fixture", idPrefix: "fx" });
const cycle = set.tasks.find((t): t is CycleTraceTask => t.category === "cycle_trace")!;
const trap = set.tasks.find((t): t is TrapTask => t.category === "runtime_type_trap")!;
const impact = set.tasks.find((t): t is ImpactTask => t.category === "change_impact")!;

const json = (value: unknown) => `Some reasoning.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;

describe("extractAnswerJson", () => {
  it("takes the last fenced block that parses", () => {
    const text = `${json({ answer: "no" })}\nOn reflection:\n${json({ answer: "yes" })}\n\`\`\`json\n{ not json\n\`\`\``;
    expect(extractAnswerJson(text)).toEqual({ answer: "yes" });
  });

  it("accepts an untagged fence and returns undefined when there is no block", () => {
    expect(extractAnswerJson('```\n{"files": []}\n```')).toEqual({ files: [] });
    expect(extractAnswerJson('The answer is {"answer": "yes"}')).toBeUndefined();
  });
});

describe("toRepoRelative", () => {
  it("strips the repo root case-insensitively and normalizes separators", () => {
    const root = "D:/RIE/repo";
    expect(toRepoRelative("d:\\RIE\\repo\\src\\a.ts", root)).toBe("src/a.ts");
    expect(toRepoRelative("./src/a.ts", root)).toBe("src/a.ts");
    expect(toRepoRelative("`src/a.ts`", root)).toBe("src/a.ts");
  });
});

describe("gradeAnswer", () => {
  it("grades a cycle given as absolute Windows paths", () => {
    const abs = cycle.expected.example_cycle.map((f) => `${FIXTURE}/${f}`.replace(/\//g, "\\"));
    expect(gradeAnswer(cycle, json({ path: abs }), FIXTURE)).toMatchObject({ parsed: true, correct: true, score: 1 });
  });

  it("reads yes/no answers leniently but only from the answer field", () => {
    const want = trap.expected.answer;
    expect(gradeAnswer(trap, json({ answer: want ? "Yes." : "No." }), FIXTURE).correct).toBe(true);
    expect(gradeAnswer(trap, json({ answer: !want }), FIXTURE).correct).toBe(false);
    expect(gradeAnswer(trap, json({ answer: "maybe" }), FIXTURE).parsed).toBe(false);
  });

  it("gives partial credit on impact but only counts an exact set as correct", () => {
    const g = gradeAnswer(impact, json({ files: impact.expected.files.slice(0, 4) }), FIXTURE);
    expect(g.correct).toBe(false);
    expect(g.score).toBeCloseTo(2 * (1 * 0.8) / 1.8);
    expect(gradeAnswer(impact, json({ files: impact.expected.files }), FIXTURE).correct).toBe(true);
  });

  it("marks a reply with no answer block as unparseable, never as a guess", () => {
    const g = gradeAnswer(impact, `The files are ${impact.expected.files.join(", ")}.`, FIXTURE);
    expect(g).toMatchObject({ parsed: false, correct: false, score: 0 });
  });
});

describe("runBenchmark + summarize", () => {
  const metrics = (tokens: number): TranscriptMetrics => ({
    tool_calls: 2,
    tool_calls_by_name: { Read: 2 },
    total_tokens: tokens,
    input_tokens: tokens,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    models: ["claude-test"],
  });

  it("gives every arm the identical prompt, rotates arm order, and scores errors as wrong runs", () => {
    const calls: { prompt: string; mcp?: string }[] = [];
    const truth = trap.expected.answer ? "yes" : "no";
    const wrong = trap.expected.answer ? "no" : "yes";
    // "good" answers correctly for 100 tokens; "bad" costs 300 and is right on its first run only; "flaky" crashes.
    const runner: Runner = (req) => {
      calls.push({ prompt: req.prompt, mcp: req.mcpConfigPath });
      if (req.mcpConfigPath === "flaky.json") throw new Error("claude exited 1");
      const right = req.mcpConfigPath === "good.json" || calls.filter((c) => c.mcp === "bad.json").length === 1;
      return {
        session_id: "s",
        final_text: json({ answer: right ? truth : wrong }),
        metrics: metrics(req.mcpConfigPath === "good.json" ? 100 : 300),
        wall_ms: 10,
        cost_usd: null,
        num_turns: 1,
      };
    };
    const tasks: Task[] = [trap];
    const records = runBenchmark({
      tasks,
      tools: [
        { name: "good", mcpConfigPath: "good.json" },
        { name: "bad", mcpConfigPath: "bad.json" },
        { name: "flaky", mcpConfigPath: "flaky.json" },
      ],
      runs: 3,
      runner,
      repoRoot: FIXTURE,
    });

    expect(new Set(calls.map((c) => c.prompt)).size).toBe(1);
    expect(calls.slice(0, 3).map((c) => c.mcp)).toEqual(["good.json", "bad.json", "flaky.json"]);
    expect(calls.slice(3, 6).map((c) => c.mcp)).toEqual(["bad.json", "flaky.json", "good.json"]);

    const byTool = Object.fromEntries(summarize(records).overall.map((c) => [c.tool, c]));
    expect(byTool.good).toMatchObject({ runs: 3, correct: 3, accuracy: 1, tokens_per_correct: 100, median_tokens: 100 });
    expect(byTool.bad).toMatchObject({ runs: 3, correct: 1, tokens_per_correct: 900 });
    expect(byTool.flaky).toMatchObject({ runs: 3, errors: 3, correct: 0, accuracy: 0, tokens_per_correct: null });
  });
});

describe("parseTranscript", () => {
  it("counts main-thread tool calls and tokens, skips sidechains, and records models", () => {
    const dir = mkdtempSync(join(tmpdir(), "rie-transcript-"));
    const path = join(dir, "t.jsonl");
    const turn = (sidechain: boolean, model: string, tools: string[], tokens: number) =>
      JSON.stringify({
        type: "assistant",
        isSidechain: sidechain,
        message: {
          model,
          usage: { input_tokens: tokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 },
          content: tools.map((name) => ({ type: "tool_use", name, input: {} })),
        },
      });
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { content: "q" } }),
        turn(false, "m1", ["Grep", "mcp__rie__find_circular_dependencies"], 100),
        turn(true, "m2", ["Read", "Read"], 5000),
        turn(false, "m1", ["Grep"], 50),
        "not json",
      ].join("\n")
    );
    const m = parseTranscript(path);
    expect(m.tool_calls).toBe(3);
    expect(m.tool_calls_by_name).toEqual({ Grep: 2, mcp__rie__find_circular_dependencies: 1 });
    expect(m.total_tokens).toBe(100 + 1 + 10 + 50 + 1 + 10);
    expect(m.models).toEqual(["m1"]);
  });
});
