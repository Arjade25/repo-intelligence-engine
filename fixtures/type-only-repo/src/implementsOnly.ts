// The same node kind in an `implements` clause stays a type - erased.
import { Box } from "./generic.js";

export class Crate implements Box<number> {
  value = 1;
}
