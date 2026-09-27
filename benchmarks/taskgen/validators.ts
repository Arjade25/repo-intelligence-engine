import type { CycleTraceTask, ImpactTask, TrapTask } from "./generate.js";

/**
 * Graders for generated tasks. Each takes an already-structured answer (a file
 * list, a yes/no) - turning an agent's free-text reply into that structure is the
 * harness's job, not this module's. Every check reads only what the task carries,
 * so grading needs neither the target repo nor a recompile.
 */

function normalize(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export interface CyclePathVerdict {
  valid: boolean;
  reason?: string;
}

/**
 * Accepts ANY runtime cycle through the start file, not just the example one - a
 * nontrivial SCC has many. Checking against the SCC's own runtime edges is enough:
 * every cycle through `start` stays inside start's SCC by definition.
 */
export function validateCyclePath(task: CycleTraceTask, answer: string[]): CyclePathVerdict {
  const path = answer.map(normalize);
  const { start, scc_runtime_edges } = task.expected;
  if (path.length < 2) return { valid: false, reason: "path needs at least two entries" };
  if (path[0] !== start) return { valid: false, reason: `path must start at ${start}` };
  if (path[path.length - 1] !== start) return { valid: false, reason: `path must end at ${start}` };

  const edges = new Set(scc_runtime_edges.map(([from, to]) => `${from}\u0000${to}`));
  for (let i = 0; i + 1 < path.length; i++) {
    if (!edges.has(`${path[i]}\u0000${path[i + 1]}`)) {
      return { valid: false, reason: `no runtime import ${path[i]} -> ${path[i + 1]}` };
    }
  }
  return { valid: true };
}

export function validateTrapAnswer(task: TrapTask, answer: boolean): boolean {
  return answer === task.expected.answer;
}

export interface ImpactScore {
  precision: number;
  recall: number;
  f1: number;
  missed: string[];
  extra: string[];
}

export function scoreImpact(task: ImpactTask, answer: string[]): ImpactScore {
  const truth = new Set(task.expected.files);
  const given = new Set(answer.map(normalize));
  const hits = [...given].filter((f) => truth.has(f)).length;
  const precision = given.size === 0 ? 0 : hits / given.size;
  const recall = truth.size === 0 ? 1 : hits / truth.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    precision,
    recall,
    f1,
    missed: [...truth].filter((f) => !given.has(f)).sort(),
    extra: [...given].filter((f) => !truth.has(f)).sort(),
  };
}
