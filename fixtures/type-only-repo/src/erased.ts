// No `type` keyword anywhere, yet every one of these is erased by the compiler.
// This is the nestjs/nest shape: plain `import { X }` used only in type position.
import { B } from "./b";
import { Widget, WIDGET_TOKEN } from "./values";
import * as ns from "./values";

// B, Widget and ns are referenced - but only from type positions.
export interface UsesErased {
  b: B;
  w: Widget;
  n: ns.Widget;
}

// A value use of WIDGET_TOKEN keeps that ONE name's edge alive, even though it
// shares a statement with the erased `Widget`.
export const token = WIDGET_TOKEN;
