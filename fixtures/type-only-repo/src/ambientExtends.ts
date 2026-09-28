// `extends` is normally the one heritage position that survives (see heritage.ts),
// but a `declare class` emits nothing at all, so its import is erased. TypeORM's
// src/driver/mongodb/typings.ts has this shape (`declare class ... extends Readable`).
import { Base } from "./values";

export declare class AmbientDerived extends Base {}
