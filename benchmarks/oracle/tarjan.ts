/**
 * Tarjan's SCC algorithm over a plain file-level edge list, independent of
 * src/engine/index.ts's own findCircularDependencies. The whole point of this
 * oracle package is to not share code with what it's validating - two
 * implementations agreeing is evidence, one implementation agreeing with itself
 * is not.
 */
export interface StronglyConnectedComponent {
  files: string[];
}

export function findStronglyConnectedComponents(
  edges: { from: string; to: string }[]
): StronglyConnectedComponent[] {
  const adjacency = new Map<string, string[]>();
  const selfLoop = new Set<string>();
  for (const { from, to } of edges) {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)!.push(to);
    if (!adjacency.has(to)) adjacency.set(to, []);
    if (from === to) selfLoop.add(from);
  }

  let counter = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const strongConnect = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!index.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  };

  for (const file of adjacency.keys()) {
    if (!index.has(file)) strongConnect(file);
  }

  // A component only counts as a real cycle at size 2+, or size 1 with a
  // self-import - matches the "component" semantics findCircularDependencies uses,
  // so results from the two implementations are directly comparable.
  return components
    .filter((c) => c.length > 1 || selfLoop.has(c[0]))
    .map((files) => ({ files: [...files].sort() }))
    .sort((a, b) => b.files.length - a.files.length || a.files[0].localeCompare(b.files[0]));
}
