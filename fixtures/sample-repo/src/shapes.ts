export interface Shape {
  area(): number;
}

export type ShapeKind = "circle" | "square";

export class Circle implements Shape {
  constructor(private radius: number) {}

  area(): number {
    return Math.PI * this.radius * this.radius;
  }
}