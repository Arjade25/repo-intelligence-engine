import { add, PI } from "./index";
import { Circle } from "./shapes";
import "./sideEffect";

export function run(): number {
  const c = new Circle(2);
  return add(PI, c.area());
}