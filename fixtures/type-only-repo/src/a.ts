// Type-only import: erased at compile time, so a -> b is NOT a runtime edge.
import type { B } from "./b";

export interface A {
  b: B | null;
}

export const aValue = 1;
