// Value import: a real runtime edge. c <-> d is a genuine runtime cycle.
import { d } from "./d";

export function c(): number {
  return d();
}
