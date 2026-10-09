import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  generateTasks,
  type CycleTraceTask,
  type DependencyPathTask,
  type ImpactTask,
  type Task,
  type TrapTask,
} from "../taskgen/generate.js";
import { extractAnswerJson, gitRootPrefix, gradeAnswer, toRepoRelative } from "./grade.js";
import { runBenchmark, summarize, type Runner } from "./bench.js";
import { agentEnv, claudeArgs, parseTranscript, type TranscriptMetrics } from "./claude.js";
import { leakReason } from "./audit.js";
import { estimateCost, loadReusedArm } from "./budget.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "../../fixtures/taskgen-repo").replace(/\\/g, "/");
const set = generateTasks({ tsconfigPath: `${FIXTURE}/tsconfig.json`, repo: "fixture", idPrefix: "fx" });
const cycle = set.tasks.find((t): t is CycleTraceTask => t.category === "cycle_trace")!;
const traps = set.tasks.filter((t): t is TrapTask => t.category === "runtime_type_trap");
// A "yes" trap: its correct answer needs no direction, which keeps the runBenchmark test simple.
const trap = traps.find((t) => t.expected.answer)!;
const impact = set.tasks.find((t): t is ImpactTask => t.category === "change_impact")!;
const pathTask = set.tasks.find((t): t is DependencyPathTask => t.category === "dependency_path")!;

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

  // directus/api and element-web/apps/web are packages inside a monorepo checkout;
  // "relative to the repository root" legitimately reads as relative to the git root.
  describe("in a monorepo package", () => {
    const mono = mkdtempSync(join(tmpdir(), "rie-mono-"));
    const pkg = join(mono, "api");
    mkdirSync(join(mono, ".git"));
    mkdirSync(join(pkg, "src"), { recursive: true });
    mkdirSync(join(pkg, "api"));
    writeFileSync(join(pkg, "src", "a.ts"), "");
    writeFileSync(join(pkg, "api", "real.ts"), "");

    it("finds the package's path inside the git checkout", () => {
      expect(gitRootPrefix(pkg)).toBe("api/");
      expect(gitRootPrefix(mono)).toBe("");
    });

    it("accepts a path given relative to the git root", () => {
      expect(toRepoRelative("api/src/a.ts", pkg)).toBe("src/a.ts");
      expect(toRepoRelative("API\\src\\a.ts", pkg)).toBe("src/a.ts");
    });

    it("leaves a path alone when it exists as written - a real api/ folder inside the package", () => {
      expect(toRepoRelative("api/real.ts", pkg)).toBe("api/real.ts");
    });

    it("leaves a path alone when stripping doesn't produce a real file either", () => {
      expect(toRepoRelative("api/src/missing.ts", pkg)).toBe("api/src/missing.ts");
    });
  });
});

describe("gradeAnswer", () => {
  it("grades a cycle given as absolute Windows paths", () => {
    const abs = cycle.expected.example_cycle.map((f) => `${FIXTURE}/${f}`.replace(/\//g, "\\"));
    expect(gradeAnswer(cycle, json({ path: abs }), FIXTURE)).toMatchObject({ parsed: true, correct: true, score: 1 });
  });

  it("grades a dependency path, reading {path: null} as 'no such chain'", () => {
    const abs = pathTask.expected.example_path!.map((f) => `${FIXTURE}/${f}`.replace(/\//g, "\\"));
    expect(gradeAnswer(pathTask, json({ path: abs }), FIXTURE)).toMatchObject({ parsed: true, correct: true, score: 1 });
    expect(gradeAnswer(pathTask, json({ path: null }), FIXTURE)).toMatchObject({ parsed: true, correct: false, reason: "a path exists" });
    expect(gradeAnswer(pathTask, json({ path: "src/paths/s5.ts" }), FIXTURE).parsed).toBe(false);
  });

  it("reads yes/no answers leniently but only from the answer field", () => {
    const yes = traps.find((t) => t.expected.answer)!;
    expect(gradeAnswer(yes, json({ answer: "Yes." }), FIXTURE).correct).toBe(true);
    expect(gradeAnswer(yes, json({ answer: false, no_runtime_path: "both" }), FIXTURE).correct).toBe(false);
    expect(gradeAnswer(yes, json({ answer: "maybe" }), FIXTURE).parsed).toBe(false);
  });

  it("grades a 'no' on the direction it names, and marks a malformed direction unparseable", () => {
    const no = traps.find((t) => !t.expected.answer)!;
    const broken = no.expected.runtime_a_to_b ? "b_to_a" : "a_to_b";
    expect(gradeAnswer(no, json({ answer: "No", no_runtime_path: broken }), FIXTURE)).toMatchObject({ parsed: true, correct: true });
    expect(gradeAnswer(no, json({ answer: "No", no_runtime_path: "both" }), FIXTURE)).toMatchObject({ parsed: true, correct: false });
    expect(gradeAnswer(no, json({ answer: "No" }), FIXTURE)).toMatchObject({ parsed: true, correct: false });
    expect(gradeAnswer(no, json({ answer: "No", no_runtime_path: "sideways" }), FIXTURE).parsed).toBe(false);
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

  it("resumes: carries over earlier successes, re-runs failed launches and missing runs only", () => {
    const truth = trap.expected.answer ? "yes" : "no";
    const ran: string[] = [];
    const runner: Runner = (req) => {
      ran.push(req.mcpConfigPath!);
      return { session_id: "new", final_text: json({ answer: truth }), metrics: metrics(50), wall_ms: 1, cost_usd: null, num_turns: 1 };
    };
    const earlier = (tool: string, run: number, ok: boolean) => ({
      task_id: trap.id,
      category: trap.category,
      tool,
      run,
      ok,
      ...(ok ? { session_id: "old", metrics: metrics(70) } : { error: "claude exited 3221225794" }),
      grade: ok ? { parsed: true, correct: true, score: 1 } : { parsed: false, correct: false, score: 0 },
    });
    // a: run 0 succeeded earlier. b: run 0 failed to launch. Run 1 never happened for either.
    const keep = [earlier("a", 0, true), earlier("b", 0, false)];
    const seen: [string, number, boolean][] = [];
    const records = runBenchmark({
      tasks: [trap],
      tools: [
        { name: "a", mcpConfigPath: "a.json" },
        { name: "b", mcpConfigPath: "b.json" },
      ],
      runs: 2,
      runner,
      repoRoot: FIXTURE,
      keep: keep.filter((r) => r.ok),
      onRun: (r, _done, _total, wasKept) => seen.push([r.tool, r.run, wasKept]),
    });

    expect(ran.sort()).toEqual(["a.json", "b.json", "b.json"]);
    expect(records).toHaveLength(4);
    expect(records.find((r) => r.tool === "a" && r.run === 0)).toBe(keep[0]);
    expect(records.filter((r) => r.session_id === "new")).toHaveLength(3);
    expect(seen.filter(([, , wasKept]) => wasKept)).toEqual([["a", 0, true]]);
  });

  it("stops launching once shouldStop says so, and counts capped runs apart from errors", () => {
    const truth = trap.expected.answer ? "yes" : "no";
    let launched = 0;
    const runner: Runner = () => {
      launched++;
      // The second session hits the turn cap: no answer, but a real, finished session.
      return launched === 2
        ? { session_id: "c", final_text: "", metrics: metrics(900), wall_ms: 1, cost_usd: 0.5, num_turns: 151, capped: true }
        : { session_id: "s", final_text: json({ answer: truth }), metrics: metrics(50), wall_ms: 1, cost_usd: 0.5, num_turns: 3 };
    };
    let spent = 0;
    const records = runBenchmark({
      tasks: [trap],
      tools: [{ name: "a", mcpConfigPath: "a.json" }],
      runs: 5,
      runner,
      repoRoot: FIXTURE,
      onRun: (r) => (spent += r.cost_usd ?? 0),
      shouldStop: () => spent >= 1.5,
    });

    expect(launched).toBe(3); // $0.50 each: stopped before the 4th, with $1.50 spent
    expect(records).toHaveLength(3);
    expect(records[1]).toMatchObject({ ok: true, capped: true, grade: { correct: false } });
    expect(summarize(records).overall[0]).toMatchObject({ runs: 3, correct: 2, errors: 0, capped: 1 });
  });
});

describe("spending controls", () => {
  const past = (tool: string, category: string, cost_usd: number, repo = "fixture") => ({ repo, tool, category, cost_usd });

  it("estimates from the closest past match: same repo and category, then any repo, then any task", () => {
    const history = [
      past("rie", "runtime_type_trap", 0.2),
      past("rie", "runtime_type_trap", 0.4),
      past("rie", "cycle_trace", 9, "other"), // a different category, ignored while a closer match exists
      past("madge", "runtime_type_trap", 1, "other"),
      past("grep", "cycle_trace", 2, "other"),
    ];
    const est = estimateCost(history, "fixture", [trap], ["rie", "madge", "grep", "new"], 5);
    const byTool = Object.fromEntries(est.arms.map((a) => [a.tool, a]));
    expect(byTool.rie.usd).toBeCloseTo(1.5); // mean 0.30 x 5 runs
    expect(byTool.rie.basis).toBe("fixture runtime_type_trap (n=2)");
    expect(byTool.madge).toMatchObject({ usd: 5, basis: "any repo, runtime_type_trap (n=1)" });
    expect(byTool.grep).toMatchObject({ usd: 10, basis: "any task (n=1)" });
    expect(byTool.new).toMatchObject({ usd: null, basis: "none", sessions: 5 });
    expect(est.total_usd).toBeNull(); // one arm has no history, so no total is claimed

    expect(estimateCost(history, "fixture", [trap], ["rie", "madge"], 5).total_usd).toBeCloseTo(6.5);
  });

  describe("loadReusedArm", () => {
    const dir = mkdtempSync(join(tmpdir(), "rie-reuse-"));
    const record = (run: number, ok = true) => ({
      task_id: trap.id,
      category: trap.category,
      tool: "baseline",
      run,
      ok,
      cost_usd: 0.3,
      grade: { parsed: true, correct: true, score: 1 },
    });
    const write = (name: string, runs: unknown[], tasks?: Task[]) => {
      const path = join(dir, `${name}.json`);
      writeFileSync(path, JSON.stringify({ meta: { claude_version: "2.1.289" }, runs }));
      if (tasks) writeFileSync(join(dir, `${name}.tasks.json`), JSON.stringify({ tasks }));
      return path;
    };

    it("takes the arm's sessions for the same tasks and run numbers, marked as reused", () => {
      const path = write("full", [record(0), record(1), record(2)], [trap]);
      const arm = loadReusedArm({ tool: "baseline", path }, [trap], 2);
      expect(arm.records.map((r) => r.run)).toEqual([0, 1]);
      expect(arm.records[0].reused_from).toBe(path.replace(/\\/g, "/"));
      expect(arm.prompts_verified).toBe(true);
      expect(arm.source_meta.claude_version).toBe("2.1.289");
    });

    it("refuses when a session is missing or failed, or a prompt changed", () => {
      const gaps = write("gaps", [record(0), record(1, false)], [trap]);
      expect(() => loadReusedArm({ tool: "baseline", path: gaps }, [trap], 2)).toThrow(/run 2: no successful baseline session/);

      const reworded = write("reworded", [record(0)], [{ ...trap, prompt: "an older wording" } as Task]);
      expect(() => loadReusedArm({ tool: "baseline", path: reworded }, [trap], 1)).toThrow(/prompt changed/);
    });

    it("uses a source with no saved task set, but says its prompts weren't checked", () => {
      const old = write("old", [record(0)]);
      expect(loadReusedArm({ tool: "baseline", path: old }, [trap], 1).prompts_verified).toBe(false);
    });
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

describe("per-arm launch settings (CLI competitors like bash-madge)", () => {
  it("passes the arm's built-in tools and system note to claude, defaulting to Read/Grep/Glob", () => {
    expect(claudeArgs({ prompt: "p", cwd: ".", maxTurns: 150 }, "s").join(" ")).toContain("--max-turns 150");
    expect(claudeArgs({ prompt: "p", cwd: ".", maxTurns: 0 }, "s")).not.toContain("--max-turns");
    const plain = claudeArgs({ prompt: "p", cwd: "." }, "s");
    expect(plain[plain.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(plain).not.toContain("--append-system-prompt");

    const arm = claudeArgs({ prompt: "p", cwd: ".", builtinTools: "Read,Grep,Glob,Bash", appendSystemPrompt: "madge is on PATH" }, "s");
    expect(arm[arm.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Bash");
    expect(arm[arm.indexOf("--append-system-prompt") + 1]).toBe("madge is on PATH");
  });

  it("prepends to the existing PATH entry whatever its casing, and adds the arm's env", () => {
    const sep = process.platform === "win32" ? ";" : ":";
    const env = agentEnv({ pathPrepend: ["/bin/madge"], env: { madge_x: "true" } }, { Path: "/usr/bin", HOME: "/h" });
    expect(env).toEqual({ Path: `/bin/madge${sep}/usr/bin`, HOME: "/h", madge_x: "true" });
    expect(agentEnv({}, { Path: "/usr/bin" })).toEqual({ Path: "/usr/bin" });
  });
});

describe("leakReason (answer-leakage audit)", () => {
  const project = "D:/RIE/repo-intelligence-engine";
  const checkout = "D:/RIE/repo-intelligence-engine/benchmarks/candidates/directus";
  const why = (name: string, input: unknown) => leakReason({ name, input }, project, checkout, 1);

  it("allows anything inside the target checkout, in every path spelling", () => {
    expect(why("Read", { file_path: String.raw`D:\RIE\repo-intelligence-engine\benchmarks\candidates\directus\api\src\app.ts` })).toBeNull();
    expect(why("Bash", { command: "cd /d/RIE/repo-intelligence-engine/benchmarks/candidates/directus && ls" })).toBeNull();
    expect(why("Bash", { command: "madge --circular --ts-config tsconfig.rie.json src" })).toBeNull();
    expect(why("Bash", { command: "cat ../package.json" })).toBeNull(); // one level up = the monorepo root, still the target
  });

  it("flags a path into the project outside the target checkout", () => {
    expect(why("Read", { file_path: "D:/RIE/repo-intelligence-engine/benchmarks/generated/directus.json" })).toMatch(/outside the target checkout/);
    expect(why("Bash", { command: "ls /d/RIE/repo-intelligence-engine/benchmarks" })).toMatch(/outside the target checkout/);
    expect(why("Grep", { pattern: "x", path: String.raw`D:\RIE\repo-intelligence-engine\benchmarks\candidates\directus-other` })).toMatch(/outside/);
  });

  it("does not flag import specifiers the agent greps for (the first bash-madge run's 7 false hits)", () => {
    expect(why("Bash", { command: `cd api/src && grep -n "from '../../services/" ai/mcp/server.ts` })).toBeNull();
    expect(why("Bash", { command: `f permissions/utils/fetch-dynamic-variable-data.ts '../../services/policies.js'` })).toBeNull();
  });

  it("flags any reference to the answer files, quoted or not", () => {
    expect(why("Bash", { command: `cat '../../../generated/directus.json'` })).toMatch(/benchmark answers/);
    expect(why("Read", { file_path: "../../../tasks-directus.json" })).toMatch(/benchmark answers/);
    expect(why("Bash", { command: "ls ../../../results/harness" })).toMatch(/benchmark answers/);
  });

  it("flags relative paths that climb out of the checkout", () => {
    expect(why("Bash", { command: "ls ../../" })).toMatch(/climbing out/);
    expect(why("Bash", { command: "cd ../.. && ls" })).toMatch(/climbing out/);
    expect(why("Read", { file_path: String.raw`..\..\generated\directus.json` })).toMatch(/benchmark answers/);
    expect(why("Read", { file_path: String.raw`..\..\src\engine\index.ts` })).toMatch(/climbing out/);
  });
});
