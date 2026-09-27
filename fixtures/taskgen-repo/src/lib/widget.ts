// Removing this export breaks five files: one direct importer, three through the
// barrel, and one through the barrel via the @lib path alias.
export function makeWidget(): { kind: string } {
  return { kind: "widget" };
}
