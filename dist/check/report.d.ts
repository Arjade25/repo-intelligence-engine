import type { PrExplanation } from "../agent/pr.js";
import type { CycleCheckResult, Evidence } from "./index.js";
export declare function formatLoop(ev: Evidence, indent?: string): string[];
export declare function formatReport(result: CycleCheckResult): string;
/** Marks the PR comment, so the action updates its own comment instead of adding one per push. */
export declare const COMMENT_MARKER = "<!-- rie-check -->";
/**
 * The PR comment and job summary: a table of every event, then the loops behind
 * each fail or warn. Pass events get a row and nothing else.
 */
export declare function formatMarkdown(result: CycleCheckResult, context?: {
    baseCommit?: string;
    baseRef?: string;
}, explanations?: PrExplanation[]): string;
/**
 * The agent's text, made safe to post: it is model output written after reading a
 * diff the PR's author controls. No HTML, no @-mentions that would ping anyone,
 * and a length cap.
 */
export declare function safeProse(text: string): string;
/**
 * The agent's part of one event: its explanation and the loops it cites when they
 * differ from rie check's (each hop of those passed the verifier), then its
 * suggestions, which nobody has checked. Without a verified finding, one line says
 * why there is no explanation, and none of the agent's text is shown.
 */
export declare function formatExplanation(x: PrExplanation["explanation"], evidence?: Evidence[]): string[];
