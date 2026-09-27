// Under verbatimModuleSyntax, a plain import is NEVER elided by usage analysis -
// only an explicit `type` modifier erases it. This same import, used only as a
// type, would be erased under default erasure rules (fixtures/type-only-repo's
// erased.ts is the same shape) but the compiler keeps it here regardless.
import { Widget } from "./values.js";

export interface UsesWidget {
  w: Widget;
}
