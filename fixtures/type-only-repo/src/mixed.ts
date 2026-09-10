// One statement, two edge kinds: `type A` is inline type-only, `aValue` is a value.
import { type A, aValue } from "./a";

// Type-only re-export.
export type { B } from "./b";

export const usesA: A | null = null;
export const total = aValue;
