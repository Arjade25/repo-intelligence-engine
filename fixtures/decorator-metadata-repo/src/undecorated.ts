// Byte-for-byte the same type-position usage as decorated.ts, minus the
// decorator. No metadata is emitted, so this import really is erased.
import { Dep } from "./deps.js";

export class PlainService {
  constructor(private readonly dep: Dep) {}
}
