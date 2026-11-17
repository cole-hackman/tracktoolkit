import { test, expect } from "@playwright/test";
import { moveSelected } from "../src/lib/move-selection";

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "viewport-independent unit tests");
});

/**
 * Multi-select move in Playlist Modifier (user feedback 2026-11-03: tracks
 * added to a playlist land at the bottom). Selected rows keep their order
 * relative to each other in every direction.
 */
const ids = (xs: number[]) => xs;
const id = (x: number) => x;
const move = (list: number[], picked: number[], dir: "top" | "up" | "down" | "bottom") =>
  moveSelected(ids(list), new Set(picked), id, dir);

test("to top / to bottom keep the selected block in its own order", () => {
  expect(move([1, 2, 3, 4, 5, 6], [5, 2, 6], "top")).toEqual([2, 5, 6, 1, 3, 4]);
  expect(move([1, 2, 3, 4, 5, 6], [1, 4], "bottom")).toEqual([2, 3, 5, 6, 1, 4]);
});

test("the common case: newly added tracks at the bottom go to the top", () => {
  expect(move([1, 2, 3, 4, 10, 11, 12], [10, 11, 12], "top")).toEqual([10, 11, 12, 1, 2, 3, 4]);
});

test("up / down move each selected block one step", () => {
  expect(move([1, 2, 3, 4, 5], [3, 5], "up")).toEqual([1, 3, 2, 5, 4]);
  expect(move([1, 2, 3, 4, 5], [3, 4], "up")).toEqual([1, 3, 4, 2, 5]);
  expect(move([1, 2, 3, 4, 5], [1, 3], "down")).toEqual([2, 1, 4, 3, 5]);
});

test("rows already at the edge stay put, and the rest still move", () => {
  expect(move([1, 2, 3, 4], [1, 2, 4], "up")).toEqual([1, 2, 4, 3]);
  expect(move([1, 2, 3, 4], [1, 3, 4], "down")).toEqual([2, 1, 3, 4]);
});

test("nothing to move returns the same array, never a mutated input", () => {
  const list = [1, 2, 3];
  expect(moveSelected(list, new Set([1]), id, "up")).toBe(list);
  expect(moveSelected(list, new Set([1, 2]), id, "top")).toBe(list);
  expect(moveSelected(list, new Set<number>(), id, "bottom")).toBe(list);
  expect(moveSelected(list, new Set([99]), id, "top")).toBe(list);
  const copy = [...list];
  moveSelected(list, new Set([3]), id, "top");
  expect(list).toEqual(copy);
});
