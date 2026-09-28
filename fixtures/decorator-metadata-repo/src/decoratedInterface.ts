// Decorated, but the parameter type is an interface: metadata serializes it as
// `Object`, so the import is still dropped.
import { Injectable } from "./decorators.js";
import { DepContract } from "./contracts.js";

@Injectable()
export class InterfaceService {
  constructor(private readonly dep: DepContract) {}
}
