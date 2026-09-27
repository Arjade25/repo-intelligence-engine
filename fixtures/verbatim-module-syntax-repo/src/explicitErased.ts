// The explicit `type` modifier still erases under verbatimModuleSyntax - it's the
// ONLY thing that does.
import type { Widget } from "./values.js";

export interface UsesWidgetToo {
  w: Widget;
}
