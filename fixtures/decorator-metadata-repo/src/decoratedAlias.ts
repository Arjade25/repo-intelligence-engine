// Same for a type alias.
import { Injectable } from "./decorators.js";
import { DepAlias } from "./contracts.js";

@Injectable()
export class AliasService {
  constructor(private readonly dep: DepAlias) {}
}
