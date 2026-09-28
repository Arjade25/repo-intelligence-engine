// A union of two different classes serializes as `Object`.
import { Injectable } from "./decorators.js";
import { UnionA, UnionB } from "./contracts.js";

@Injectable()
export class UnionService {
  constructor(private readonly dep: UnionA | UnionB) {}
}
