import { dirname, isAbsolute, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createServer } from "../mcp-server/index.js";
import { factsFromEvent, FindingSchema } from "./finding.js";
import { checkFinding } from "./verify.js";
/**
 * The investigation agent's runtime (plan, week 3): one Claude Agent SDK session
 * that explains one `rie check` event and hands back a finding.
 *
 * The agent sees the event, the facts rie check already proved (factsFromEvent),
 * and the PR's diff. It reaches the engine through the same MCP server outside
 * agents use, hosted in-process on the PR snapshot's open index, so it queries
 * exactly the graph rie check compared. It has the read-only tools only - never
 * reindex - plus Read, limited to the files in the finding and the diff. No
 * settings, CLAUDE.md or other MCP servers are loaded.
 *
 * Every draft goes through checkFinding before anyone sees it. Caps: tool calls
 * (counted by the hook that also enforces the file list; turns are a backstop),
 * spend (the SDK's maxBudgetUsd) and wall time (an abort).
 */
export const MCP_SERVER = "rie";
/** The MCP server's tools minus reindex, which rewrites the index. */
export const READ_ONLY_MCP_TOOLS = [
    "find_module",
    "find_related_files",
    "find_symbol_references",
    "dependency_path",
    "find_circular_dependencies",
    "find_cycle_through_file",
].map((t) => `mcp__${MCP_SERVER}__${t}`);
export const DEFAULT_LIMITS = { maxToolCalls: 10, maxBudgetUsd: 0.5, timeoutMs: 180_000 };
const norm = (p) => {
    const s = resolve(p).replace(/\\/g, "/");
    return process.platform === "win32" ? s.toLowerCase() : s;
};
/** Paths a unified diff touches, as written after a/ and b/ ("/dev/null" dropped). */
export function diffFiles(diff) {
    const files = new Set();
    for (const m of diff.matchAll(/^(?:\+\+\+ b\/|--- a\/)(.+?)\s*$/gm))
        files.add(m[1]);
    return [...files].sort();
}
/** Files the agent may Read: every file in the event's evidence or joined list, and every file the diff touches. */
export function readableFiles(event, diff, root, gitRoot) {
    const fromEvent = [...(event.evidence ?? []).flatMap((e) => e.loop), ...(event.joined ?? [])].map((f) => resolve(root, f));
    const fromDiff = diffFiles(diff).map((f) => resolve(gitRoot, f));
    return [...new Set([...fromEvent, ...fromDiff].map(norm))].sort();
}
/** The tool the SDK adds for outputFormat; the agent answers by calling it. */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
/**
 * The one place tool calls are allowed or refused: read-only MCP tools, and Read
 * on the listed files, up to the tool-call cap; and the structured-output tool,
 * always. Everything else is refused.
 */
export function createGate(allowedFiles, maxToolCalls) {
    const files = new Set([...allowedFiles].map(norm));
    let used = 0;
    const decide = (tool, input) => {
        // How the SDK delivers the structured output: the answer itself, never counted or capped.
        if (tool === STRUCTURED_OUTPUT_TOOL)
            return { allow: true };
        if (used >= maxToolCalls) {
            return { allow: false, reason: `Tool-call limit (${maxToolCalls}) reached. Write the finding now from what you have.` };
        }
        if (tool === "Read") {
            const path = input?.file_path;
            if (typeof path !== "string" || !isAbsolute(path) || !files.has(norm(path))) {
                return { allow: false, reason: `Read is limited to the files in the finding and the diff; ${String(path)} is not one of them.` };
            }
        }
        else if (!READ_ONLY_MCP_TOOLS.includes(tool)) {
            return { allow: false, reason: `${tool} is not available to this agent.` };
        }
        used++;
        return { allow: true };
    };
    return { decide, used: () => used };
}
export const SYSTEM_PROMPT = `You explain one finding from rie check, a CI check that fails a pull request when it makes the repository's runtime import cycles worse. Your reader is the PR's author, who wants to know what their change did and how to undo it.

You are given the event, the facts rie check has already proved (each hop of a loop: importing file, imported file, line, statement, whether it survives compilation, whether this PR added it), and the PR's diff. The repository's import graph is available through the rie tools; paths in their results are relative to the repository root you are given. Read is limited to the files in the finding and the diff.

Return a finding in the required JSON format, in three parts kept apart:
- facts: the loops that show the problem. Start from the facts you were given. Change or add a loop only when a tool result shows every hop of it, and copy each hop's line and statement exactly as the tools report them. A program checks every hop against the graph, and one wrong hop rejects the whole finding.
- why_it_matters: a short explanation for the PR author, based only on the facts: which import the PR added, which files it pulls into the cycle, and what that does at load time.
- suggestions: possible fixes, each with verified set to false. Nobody has checked them.

Use few tool calls; the given facts are often enough. Never say a suggestion is tested or safe.`;
/**
 * The finding format as JSON Schema, for the SDK's structured output. zod stamps a
 * draft 2020-12 "$schema" URL, which the CLI's validator rejects (no schema with
 * that key); nothing in the schema needs that draft, so the key is dropped.
 */
const { $schema: _draft, ...FINDING_JSON_SCHEMA } = z.toJSONSchema(FindingSchema);
/** Diffs longer than this keep only the files in the finding; a large refactor's full diff would cost more than it explains. */
export const MAX_DIFF_CHARS = 50_000;
/**
 * The diff as the agent sees it: whole when it is short; otherwise only the
 * sections for files in the finding (per `diff --git` header), with a line saying
 * how many other files were left out.
 */
export function promptDiff(diff, keep) {
    const text = diff.trim();
    if (text.length <= MAX_DIFF_CHARS)
        return text || "(empty)";
    const sections = text.split(/^(?=diff --git )/m);
    const kept = sections.filter((s) => {
        const m = /^diff --git a\/.+? b\/(.+)$/m.exec(s);
        return m !== null && keep(m[1]);
    });
    const omitted = sections.length - kept.length;
    return [...kept.map((s) => s.trimEnd()), `(${omitted} other file(s) changed by this PR are left out of this diff, which was ${text.length} characters.)`].join("\n");
}
/** The first user message: the event, its proved facts, the repository root and the diff. */
export function buildPrompt(event, root, diff, gitRoot = root) {
    const { evidence: _, ...summary } = event;
    const inFinding = new Set([...(event.evidence ?? []).flatMap((e) => e.loop), ...(event.joined ?? [])].map((f) => norm(resolve(root, f))));
    return [
        `Repository root: ${root.replace(/\\/g, "/")}`,
        `Event:\n${JSON.stringify(summary, null, 2)}`,
        `Facts rie check proved:\n${JSON.stringify(factsFromEvent(event), null, 2)}`,
        `PR diff:\n${promptDiff(diff, (path) => inFinding.has(norm(resolve(gitRoot, path))))}`,
    ].join("\n\n");
}
/** One session (or one resumed turn of it), then verify what it returns. */
async function attempt(input, state) {
    const { gate, limits } = state;
    const root = dirname(resolve(input.tsconfig));
    const refused = [];
    const usedBefore = gate.used();
    const preToolUse = async (hookInput) => {
        if (hookInput.hook_event_name !== "PreToolUse")
            return {};
        const d = gate.decide(hookInput.tool_name, hookInput.tool_input);
        if (d.allow)
            return {};
        refused.push(`${hookInput.tool_name}: ${d.reason}`);
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } };
    };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), limits.timeoutMs);
    const options = {
        abortController: abort,
        cwd: input.gitRoot ?? root,
        model: input.model ?? "claude-opus-5-5",
        ...(input.effort && { effort: input.effort }),
        ...(state.resume && { resume: state.resume }),
        systemPrompt: SYSTEM_PROMPT,
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: { [MCP_SERVER]: { type: "sdk", name: MCP_SERVER, instance: createServer(input.pr.db, input.tsconfig) } },
        tools: ["Read"],
        allowedTools: ["Read", ...READ_ONLY_MCP_TOOLS],
        disallowedTools: [`mcp__${MCP_SERVER}__reindex`],
        permissionMode: "dontAsk",
        hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
        // Turns are a backstop; the gate's tool-call count is the real cap.
        maxTurns: Math.max(limits.maxToolCalls - usedBefore, 0) + 4,
        maxBudgetUsd: limits.maxBudgetUsd,
        outputFormat: { type: "json_schema", schema: FINDING_JSON_SCHEMA },
    };
    const started = Date.now();
    let result;
    let stop;
    try {
        for await (const message of (input.run ?? query)({ prompt: state.prompt, options })) {
            if (message.type === "result")
                result = message;
        }
    }
    catch (e) {
        // The SDK can raise the spend stop instead of returning it as a result; it is the cap working, not a failure.
        const message = e.message;
        stop = abort.signal.aborted ? "timeout" : /maximum budget/i.test(message) ? "error_max_budget_usd" : `error: ${message}`;
    }
    finally {
        clearTimeout(timer);
    }
    const base = {
        tool_calls: gate.used() - usedBefore,
        refused,
        cost_usd: result?.total_cost_usd ?? null,
        num_turns: result?.num_turns ?? null,
        wall_ms: Date.now() - started,
        ...(result?.session_id && { session_id: result.session_id }),
    };
    if (result && result.subtype !== "success")
        stop ??= result.subtype;
    const draft = result?.subtype === "success" ? result.structured_output : undefined;
    if (draft === undefined)
        return { status: "no_draft", errors: [], stop: stop ?? "no structured output", ...base };
    const checked = checkFinding(draft, { event: input.event, pr: input.pr, base: input.base, renames: input.renames });
    return checked.ok
        ? { status: "verified", finding: checked.finding, draft, errors: [], ...base }
        : { status: "rejected", draft, errors: checked.errors, ...base };
}
function firstAttempt(input) {
    const limits = { ...DEFAULT_LIMITS, ...input.limits };
    const root = dirname(resolve(input.tsconfig));
    const gate = createGate(readableFiles(input.event, input.diff, root, input.gitRoot ?? root), limits.maxToolCalls);
    return { gate, limits, prompt: buildPrompt(input.event, root, input.diff, input.gitRoot ?? root) };
}
/** One session for one event, verified; no retry. */
export function investigate(input) {
    return attempt(input, firstAttempt(input));
}
/** The retry's message: the verifier's reasons, and what to do about them. */
export function revisePrompt(errors) {
    return [
        "A program checked your finding against the import graph and refused it:",
        ...errors.map((e) => `- ${e}`),
        "",
        "Fix what these errors name. Copy each hop's line and statement from a tool result or from the facts you were given, or drop the loop. Then return the whole finding again.",
    ].join("\n");
}
/**
 * Spend across attempts. A resumed session's result carries the session's running
 * total (checked live: the retry reported $0.066 after a $0.030 first attempt, and
 * the transcript's three API calls come to ~$0.057), so the largest figure is the total.
 */
function spent(attempts) {
    const costs = attempts.map((a) => a.cost_usd).filter((c) => c !== null);
    return costs.length === 0 ? null : Math.max(...costs);
}
/**
 * The revise loop (plan, week 3): one session; if the verifier rejects its draft,
 * one retry in the same session with the verifier's reasons, inside what is left
 * of the caps. A second rejection, or a session that ends without a draft, falls
 * back to the deterministic facts.
 */
export async function explain(input) {
    const state = firstAttempt(input);
    const attempts = [await attempt(input, state)];
    const done = () => {
        const last = attempts.at(-1);
        if (last.status === "verified")
            return { source: "agent", finding: last.finding, attempts, cost_usd: spent(attempts) };
        const reason = last.status === "rejected"
            ? `the agent's finding failed verification${attempts.length > 1 ? " twice" : ""}: ${last.errors.join("; ")}`
            : `the agent returned no finding (${last.stop})`;
        return { source: "deterministic", facts: factsFromEvent(input.event), reason, attempts, cost_usd: spent(attempts) };
    };
    const first = attempts[0];
    if (first.status !== "rejected" || !first.session_id)
        return done();
    const budgetLeft = state.limits.maxBudgetUsd - (first.cost_usd ?? 0);
    const timeLeft = state.limits.timeoutMs - first.wall_ms;
    if (budgetLeft <= 0 || timeLeft <= 0)
        return done();
    attempts.push(await attempt(input, {
        gate: state.gate,
        limits: { ...state.limits, maxBudgetUsd: budgetLeft, timeoutMs: timeLeft },
        prompt: revisePrompt(first.errors),
        resume: first.session_id,
    }));
    return done();
}
//# sourceMappingURL=runtime.js.map