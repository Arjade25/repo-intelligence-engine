import { h } from "./h";

export function g(): number {
  return h() === null ? 0 : 1;
}
