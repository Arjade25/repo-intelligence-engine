import type { CycleTraceTask, DependencyPathTask, ImpactTask, TrapTask } from "./generate.js";

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

  // The edge set covers only start's SCC, so a step to a file outside it is not
  // necessarily a missing import - it may be a real one that simply can't lead
  // back. Say which: an element-web answer was once blamed on a valid import
  // (EventTileFactory -> Api) when its actual break was two steps later, a hop that
  // existed only as a dynamic import().
  const edges = new Set(scc_runtime_edges.map(([from, to]) => `${from}\u0000${to}`));
  const members = new Set(task.expected.scc_members);
  for (let i = 0; i + 1 < path.length; i++) {
    const [from, to] = [path[i], path[i + 1]];
    if (edges.has(`${from}\u0000${to}`)) continue;
    if (!members.has(to)) {
      return {
        valid: false,
        reason: `${to} is not in ${start}'s runtime cycle group, so no runtime import chain from it leads back (step ${from} -> ${to})`,
      };
    }
    return { valid: false, reason: `no runtime import ${from} -> ${to}` };
  }
  return { valid: true };
}

/**
 * A dependency-path answer is a chain, or null for "no path". Any chain from `from`
 * to `to` whose every hop is a real import is accepted - `path_edges` holds every
 * edge that lies on some such chain, so no valid answer is missing from it.
 */
export function validateImportPath(task: DependencyPathTask, answer: string[] | null): CyclePathVerdict {
  const { from, to, reachable, path_edges } = task.expected;
  if (!reachable) {
    return answer === null || answer.length === 0 ? { valid: true } : { valid: false, reason: "there is no such path" };
  }
  if (answer === null || answer.length === 0) return { valid: false, reason: "a path exists" };
  const path = answer.map(normalize);
  if (path[0] !== from) return { valid: false, reason: `path must start at ${from}` };
  if (path[path.length - 1] !== to) return { valid: false, reason: `path must end at ${to}` };
  const edges = new Set(path_edges.map(([a, b]) => `${a}\u0000${b}`));
  for (let i = 0; i + 1 < path.length; i++) {
    if (!edges.has(`${path[i]}\u0000${path[i + 1]}`)) {
      return { valid: false, reason: `no import ${path[i]} -> ${path[i + 1]}` };
    }
  }
  return { valid: true };
}

/** Which direction(s) of a "no" trap pair have no runtime import path. */
export type BrokenDirection = "a_to_b" | "b_to_a" | "both";

/**
 * "yes" must match a real runtime cycle. "no" must also name the direction(s) with
 * no runtime path: on a repo with no runtime cycles every trap is a "no", so yes/no
 * alone rewards a blanket "no". Task files generated before the runtime_* fields
 * existed carry no direction truth and are graded on yes/no only.
 */
export function validateTrapAnswer(task: TrapTask, answer: boolean, broken?: BrokenDirection): CyclePathVerdict {
  const { answer: truth, runtime_a_to_b, runtime_b_to_a } = task.expected;
  if (answer !== truth) return { valid: false, reason: truth ? "a runtime cycle exists" : "there is no runtime cycle" };
  if (truth || runtime_a_to_b === undefined || runtime_b_to_a === undefined) return { valid: true };

  const actual: BrokenDirection = !runtime_a_to_b && !runtime_b_to_a ? "both" : !runtime_a_to_b ? "a_to_b" : "b_to_a";
  if (broken === undefined) return { valid: false, reason: `"no" without naming the broken direction (it is ${actual})` };
  return broken === actual ? { valid: true } : { valid: false, reason: `broken direction is ${actual}, not ${broken}` };
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
