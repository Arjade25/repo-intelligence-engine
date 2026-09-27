// A real runtime cycle, but only two files long - the minimum-path filter must drop it.
import { y } from "./y";

export function x(): string {
  return typeof y;
}
