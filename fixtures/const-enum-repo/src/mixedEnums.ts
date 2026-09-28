// One statement, both kinds: the regular enum keeps the import alive.
import { Color, Size } from "./enums.js";

export const both = [Color.Blue, Size.Small];
