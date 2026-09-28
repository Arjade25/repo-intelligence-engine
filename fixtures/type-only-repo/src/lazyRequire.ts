// A `require()` nested inside a function runs only when the function is called,
// not when this module loads, so it can't take part in an initialization cycle.
// Same rule the emitted-JS oracle applies (and the reason a downleveled dynamic
// `import()` - `Promise.resolve().then(() => require(X))` - isn't an edge either).
export function loadLater(): unknown {
  return require("./d");
}
