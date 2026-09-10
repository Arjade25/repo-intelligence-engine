import { c } from "./c";

export function d(): number {
  return typeof c === "function" ? 1 : 0;
}
