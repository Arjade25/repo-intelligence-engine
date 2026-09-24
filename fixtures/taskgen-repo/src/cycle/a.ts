// Runtime cycle a -> b -> c -> index (barrel) -> a: four files, passes the
// minimum-path filter, and routes through a barrel.
import { bFn } from "./b";

export function aFn(): number {
  return bFn() + 1;
}
