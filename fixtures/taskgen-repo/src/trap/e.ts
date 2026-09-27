// e -> f -> g -> h are value imports; h -> e is a plain import used only as a type,
// which the compiler erases. So e..h form a cycle in the source graph but NOT at
// runtime - every pair here is a "no" for the runtime-vs-type trap category.
import { f } from "./f";

export interface EShape {
  id: string;
}

export function e(): number {
  return f();
}
