import { aFn } from "./index";

export function cFn(): number {
  return typeof aFn === "function" ? 1 : 0;
}
