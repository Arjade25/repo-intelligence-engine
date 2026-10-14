// The class has no decorator, but one constructor parameter does - and that alone
// makes the compiler emit `design:paramtypes` for EVERY parameter, so Dep (type
// position only) survives. immich's NestJS BaseModule is written this way.
import { Inject } from "./decorators.js";
import { Dep } from "./deps.js";

export class ParamDecoratedModule {
  constructor(@Inject() readonly token: string, private readonly dep: Dep) {}
}
