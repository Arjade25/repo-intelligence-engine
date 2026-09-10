// The other half of the type-only cycle a <-> b.
import type { A } from "./a";

export interface B {
  a: A | null;
}
