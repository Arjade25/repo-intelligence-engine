// `X | null`: whether null is skipped depends on strictNullChecks.
import { Injectable } from "./decorators.js";
import { NullableDep } from "./contracts.js";

@Injectable()
export class NullableService {
  constructor(private readonly dep: NullableDep | null) {}
}
