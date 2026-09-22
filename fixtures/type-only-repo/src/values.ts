export class Widget {
  kind = "widget";
}
export const WIDGET_TOKEN = "widget-token";
export class Base {
  greet(): string {
    return "hi";
  }
}
export interface Contract {
  id: string;
}
