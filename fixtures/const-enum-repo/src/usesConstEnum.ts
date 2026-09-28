// A value use of a const enum member: the compiler inlines "red" and, unless
// isolatedModules is set, drops the import.
import { Color } from "./enums.js";

export const favorite = Color.Red;
