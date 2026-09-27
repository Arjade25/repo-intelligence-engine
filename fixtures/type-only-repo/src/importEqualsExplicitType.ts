// The explicit `import type x = require(...)` form (legal since TS 3.8) erases
// regardless of usage, same as `import type { x }`.
import type widgetNs = require("./values");

export interface UsesImportEqualsExplicitType {
  w: widgetNs.Widget;
}
