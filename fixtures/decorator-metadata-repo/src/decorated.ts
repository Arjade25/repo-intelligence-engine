// Dep appears ONLY in type position - but the class is decorated, so
// emitDecoratorMetadata re-emits the constructor parameter type as a
// `design:paramtypes` value. The import survives; this is a runtime edge.
import { Injectable } from "./decorators.js";
import { Dep } from "./deps.js";

@Injectable()
export class DecoratedService {
  constructor(private readonly dep: Dep) {}
}
