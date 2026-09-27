// Reached through a NAMED re-export (gadget/index.ts). Removing this export breaks
// the four direct importers and the re-export line itself - but TypeScript's error
// recovery still resolves makeGadget through that broken line, so the barrel's own
// importer (via-barrel.ts) keeps compiling. The generator must drop this task.
export function makeGadget(): { kind: string } {
  return { kind: "gadget" };
}
