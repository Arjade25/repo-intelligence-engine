import type { Task } from "../taskgen/generate.js";
import { scoreImpact, validateCyclePath, validateTrapAnswer } from "../taskgen/validators.js";

/**
 * Turns an agent's free-text reply into a graded result. The task prompt is
 * followed by the same fixed answer-format instruction on every tool arm, so no
 * arm is advantaged by how it is asked to answer. Only the LAST fenced JSON block
 * counts. A reply without one is graded wrong ("unparseable"), not guessed at:
 * scraping prose for file paths would make the grade depend on writing style.
 */

const ANSWER_FORMATS: Record<Task["category"], string> = {
  cycle_trace:
    'End your reply with a fenced ```json code block of the form {"path": ["<file>", "<file>", ...]} ' +
    "listing the chain in order, starting and ending with the start file. Use paths relative to the repository root.",
  runtime_type_trap: 'End your reply with a fenced ```json code block of the form {"answer": "yes"} or {"answer": "no"}.',
  change_impact:
    'End your reply with a fenced ```json code block of the form {"files": ["<file>", ...]}. ' +
    "Use paths relative to the repository root. Use an empty list if no file would fail.",
};

export function buildPrompt(task: Task): string {
  return `${task.prompt}\n\n${ANSWER_FORMATS[task.category]}`;
}

/** Last fenced code block whose body parses as JSON (tagged json or untagged). */
export function extractAnswerJson(text: string): unknown {
  const blocks = [...text.matchAll(/```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)].map((m) => m[1]);
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(blocks[i]);
    } catch {
      // try the previous block
    }
  }
  return undefined;
}

/** Agents cite files every way they can: absolute, backslashed, ./-prefixed. */
export function toRepoRelative(file: string, repoRoot: string): string {
  let p = file.trim().replace(/^["'`]|["'`]$/g, "").replace(/\\/g, "/");
  const root = repoRoot.replace(/\\/g, "/").replace(/\/$/, "");
  if (p.toLowerCase().startsWith(root.toLowerCase() + "/")) p = p.slice(root.length + 1);
  return p.replace(/^\.\//, "");
}

export interface Grade {
  parsed: boolean;
  correct: boolean;
  /** 1/0 for cycle and trap tasks; F1 for change impact, where partial credit is meaningful. */
  score: number;
  reason?: string;
  answer?: unknown;
}

export function gradeAnswer(task: Task, finalText: string, repoRoot: string): Grade {
  const json = extractAnswerJson(finalText) as Record<string, unknown> | undefined;
  const fail = (reason: string, answer?: unknown): Grade => ({ parsed: false, correct: false, score: 0, reason, answer });
  if (!json || typeof json !== "object") return fail("no parseable ```json answer block");

  const stringList = (value: unknown) =>
    Array.isArray(value) && value.every((v) => typeof v === "string")
      ? (value as string[]).map((f) => toRepoRelative(f, repoRoot))
      : undefined;

  switch (task.category) {
    case "cycle_trace": {
      const path = stringList(json.path);
      if (!path) return fail('expected {"path": [...]}', json);
      const verdict = validateCyclePath(task, path);
      return { parsed: true, correct: verdict.valid, score: verdict.valid ? 1 : 0, reason: verdict.reason, answer: path };
    }
    case "runtime_type_trap": {
      const raw = json.answer;
      const answer =
        raw === true || (typeof raw === "string" && /^\s*yes\b/i.test(raw))
          ? true
          : raw === false || (typeof raw === "string" && /^\s*no\b/i.test(raw))
            ? false
            : undefined;
      if (answer === undefined) return fail('expected {"answer": "yes"|"no"}', json);
      const correct = validateTrapAnswer(task, answer);
      return { parsed: true, correct, score: correct ? 1 : 0, answer };
    }
    case "change_impact": {
      const files = stringList(json.files);
      if (!files) return fail('expected {"files": [...]}', json);
      const s = scoreImpact(task, files);
      // Exact set match counts as correct; F1 is kept as the partial-credit score.
      const correct = s.precision === 1 && s.recall === 1;
      const reason = correct ? undefined : `missed ${s.missed.length}, extra ${s.extra.length}`;
      return { parsed: true, correct, score: s.f1, reason, answer: files };
    }
  }
}
