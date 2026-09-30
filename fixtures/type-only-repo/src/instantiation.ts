// `Box<string>` here is an instantiation expression (TS 4.7+): a value with type
// arguments attached. The type arguments erase, `Box` itself is emitted. This is
// element-web's AddThreepid.ts shape (`Modal.createDialog(Dialog<Body>, ...)`),
// which the indexer once reported as erased.
import { Box } from "./generic.js";

const makeBox = (ctor: new (v: string) => Box<string>) => new ctor("x");
export const boxed = makeBox(Box<string>);
