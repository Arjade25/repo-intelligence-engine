// Same for a method: no method decorator, but one decorated parameter emits
// `design:paramtypes` for all of them, Dep included.
import { Inject } from "./decorators.js";
import { Dep } from "./deps.js";

export class MethodParamDecorated {
  run(@Inject() token: string, dep: Dep): void {
    void token;
    void dep;
  }
}
