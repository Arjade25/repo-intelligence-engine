import { describe, expect, it } from "vitest";
import { findStronglyConnectedComponents } from "./tarjan.js";

describe("findStronglyConnectedComponents", () => {
  it("reports no components for an acyclic graph", () => {
    const result = findStronglyConnectedComponents([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
    expect(result).toEqual([]);
  });

  it("finds a simple two-file mutual cycle", () => {
    const result = findStronglyConnectedComponents([
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ]);
    expect(result).toEqual([{ files: ["a", "b"] }]);
  });

  it("finds a self-import as its own size-1 component", () => {
    const result = findStronglyConnectedComponents([{ from: "a", to: "a" }]);
    expect(result).toEqual([{ files: ["a"] }]);
  });

  it("does not report a size-1 component with no self-loop", () => {
    const result = findStronglyConnectedComponents([{ from: "a", to: "b" }]);
    expect(result).toEqual([]);
  });

  it("finds two disjoint cycles and orders the larger one first", () => {
    const result = findStronglyConnectedComponents([
      // 3-file cycle
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
      // 2-file cycle, unrelated
      { from: "x", to: "y" },
      { from: "y", to: "x" },
    ]);
    expect(result).toEqual([{ files: ["a", "b", "c"] }, { files: ["x", "y"] }]);
  });

  it("does not merge two cycles joined only by a one-way bridge", () => {
    const result = findStronglyConnectedComponents([
      { from: "a", to: "b" },
      { from: "b", to: "a" },
      { from: "b", to: "c" }, // one-way bridge out of the a<->b cycle
      { from: "c", to: "d" },
      { from: "d", to: "c" },
    ]);
    expect(result).toEqual([{ files: ["a", "b"] }, { files: ["c", "d"] }]);
  });
});
