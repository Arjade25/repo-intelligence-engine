// Only the outer type name is serialized (`Array`); a class in the type arguments
// is not referenced by the metadata.
import { Injectable } from "./decorators.js";
import { GenericArg } from "./contracts.js";

@Injectable()
export class GenericService {
  constructor(private readonly deps: Array<GenericArg>) {}
}
