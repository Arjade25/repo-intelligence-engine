import { query, type EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { CycleEvent, CycleGraph, Snapshot } from "../check/index.js";
import { type Finding } from "./finding.js";
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
export declare const MCP_SERVER = "rie";
/** The MCP server's tools minus reindex, which rewrites the index. */
export declare const READ_ONLY_MCP_TOOLS: string[];
export interface Limits {
    /** Tool calls allowed; the next is refused with a request to answer now. */
    maxToolCalls: number;
    /** The SDK's spend stop, in USD. */
    maxBudgetUsd: number;
    /** Wall-clock stop. */
    timeoutMs: number;
}
export declare const DEFAULT_LIMITS: Limits;
export interface InvestigationInput {
    /** The fail or warn event to explain. */
    event: CycleEvent;
    /** The PR snapshot, index open; the agent's MCP server runs on it. */
    pr: Snapshot;
    base: CycleGraph;
    renames?: Record<string, string>;
    /** The PR snapshot's tsconfig; event paths are relative to its directory. */
    tsconfig: string;
    /** The PR's unified diff (git diff base...pr). */
    diff: string;
    /** Directory the diff's paths are relative to. Defaults to the tsconfig's directory. */
    gitRoot?: string;
    model?: string;
    effort?: EffortLevel;
    limits?: Partial<Limits>;
    /** The SDK's session function; tests pass a stub. */
    run?: typeof query;
}
export interface InvestigationResult {
    /**
     * verified: the draft passed checkFinding. rejected: it didn't (errors say why).
     * no_draft: the session ended without one (stop says why).
     */
    status: "verified" | "rejected" | "no_draft";
    finding?: Finding;
    /** What the agent returned, verified or not. */
    draft?: unknown;
    errors: string[];
    /** Why a session ended early: an SDK error subtype, "timeout", or an exception. */
    stop?: string;
    tool_calls: number;
    /** Tool calls the gate refused, with the reason. */
    refused: string[];
    cost_usd: number | null;
    num_turns: number | null;
    wall_ms: number;
    session_id?: string;
}
/** Paths a unified diff touches, as written after a/ and b/ ("/dev/null" dropped). */
export declare function diffFiles(diff: string): string[];
/** Files the agent may Read: every file in the event's evidence or joined list, and every file the diff touches. */
export declare function readableFiles(event: CycleEvent, diff: string, root: string, gitRoot: string): string[];
/** The tool the SDK adds for outputFormat; the agent answers by calling it. */
export declare const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
export type GateDecision = {
    allow: true;
} | {
    allow: false;
    reason: string;
};
/**
 * The one place tool calls are allowed or refused: read-only MCP tools, and Read
 * on the listed files, up to the tool-call cap; and the structured-output tool,
 * always. Everything else is refused.
 */
export declare function createGate(allowedFiles: Iterable<string>, maxToolCalls: number): {
    decide: (tool: string, input: unknown) => GateDecision;
    used: () => number;
};
export declare const SYSTEM_PROMPT = "You explain one finding from rie check, a CI check that fails a pull request when it makes the repository's runtime import cycles worse. Your reader is the PR's author, who wants to know what their change did and how to undo it.\n\nYou are given the event, the facts rie check has already proved (each hop of a loop: importing file, imported file, line, statement, whether it survives compilation, whether this PR added it), and the PR's diff. The repository's import graph is available through the rie tools; paths in their results are relative to the repository root you are given. Read is limited to the files in the finding and the diff.\n\nReturn a finding in the required JSON format, in three parts kept apart:\n- facts: the loops that show the problem. Start from the facts you were given. Change or add a loop only when a tool result shows every hop of it, and copy each hop's line and statement exactly as the tools report them. A program checks every hop against the graph, and one wrong hop rejects the whole finding.\n- why_it_matters: a short explanation for the PR author, based only on the facts: which import the PR added, which files it pulls into the cycle, and what that does at load time.\n- suggestions: possible fixes, each with verified set to false. Nobody has checked them.\n\nUse few tool calls; the given facts are often enough. Never say a suggestion is tested or safe.";
/** Diffs longer than this keep only the files in the finding; a large refactor's full diff would cost more than it explains. */
export declare const MAX_DIFF_CHARS = 50000;
/**
 * The diff as the agent sees it: whole when it is short; otherwise only the
 * sections for files in the finding (per `diff --git` header), with a line saying
 * how many other files were left out.
 */
export declare function promptDiff(diff: string, keep: (path: string) => boolean): string;
/** The first user message: the event, its proved facts, the repository root and the diff. */
export declare function buildPrompt(event: CycleEvent, root: string, diff: string, gitRoot?: string): string;
/** One session for one event, verified; no retry. */
export declare function investigate(input: InvestigationInput): Promise<InvestigationResult>;
/** The retry's message: the verifier's reasons, and what to do about them. */
export declare function revisePrompt(errors: string[]): string;
/**
 * What goes on the PR for one event. "agent": a finding that passed the verifier.
 * "deterministic": the agent had no verified finding, so only rie check's own
 * facts are shown, without any of the agent's text.
 */
export type Explanation = {
    source: "agent";
    finding: Finding;
    attempts: InvestigationResult[];
    cost_usd: number | null;
} | {
    source: "deterministic";
    facts: Finding["facts"];
    reason: string;
    attempts: InvestigationResult[];
    cost_usd: number | null;
};
/**
 * The revise loop (plan, week 3): one session; if the verifier rejects its draft,
 * one retry in the same session with the verifier's reasons, inside what is left
 * of the caps. A second rejection, or a session that ends without a draft, falls
 * back to the deterministic facts.
 */
export declare function explain(input: InvestigationInput): Promise<Explanation>;
