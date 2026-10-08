import { test, expect } from "@playwright/test";
import {
  EMPTY_PROGRESS,
  GATE_PROGRESS_KEY,
  clearSkips,
  gateCounts,
  loadGateProgress,
  markGate,
  nextGate,
  saveGateProgress,
  undoLast,
} from "../src/lib/gate-progress";

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "viewport-independent unit tests");
});

const gates = [{ id: 1 }, { id: 2 }, { id: 3 }];

test("next is the first unmarked gate; done and skipped both move past it", () => {
  let p = markGate(EMPTY_PROGRESS, 1, "done");
  expect(nextGate(gates, p)?.id).toBe(2);
  p = markGate(p, 2, "skipped");
  expect(nextGate(gates, p)?.id).toBe(3);
  expect(gateCounts(gates, p)).toEqual({ total: 3, done: 1, skipped: 1, left: 1 });
  p = markGate(p, 3, "done");
  expect(nextGate(gates, p)).toBeNull();
});

test("undo takes back the latest mark, one at a time", () => {
  let p = markGate(markGate(EMPTY_PROGRESS, 1, "done"), 2, "skipped");
  let r = undoLast(p);
  expect(r.trackId).toBe(2);
  expect(nextGate(gates, r.progress)?.id).toBe(2);
  r = undoLast(r.progress);
  expect(r.trackId).toBe(1);
  expect(undoLast(r.progress).trackId).toBeNull();
});

test("clearing skips puts only skipped gates back; done stays done", () => {
  const p = clearSkips(markGate(markGate(EMPTY_PROGRESS, 1, "done"), 2, "skipped"), [1, 2, 3]);
  expect(gateCounts(gates, p)).toEqual({ total: 3, done: 1, skipped: 0, left: 2 });
  expect(p.history).toEqual(["1"]);
});

test("storage round-trips, and junk or a throwing store reads as empty", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  saveGateProgress(markGate(EMPTY_PROGRESS, 7, "done", new Date("2026-10-08T00:00:00Z")), storage);
  expect(loadGateProgress(storage).marks["7"]).toEqual({ mark: "done", at: "2026-10-08T00:00:00.000Z" });

  store.set(GATE_PROGRESS_KEY, JSON.stringify({ marks: { 8: { mark: "maybe" } }, history: ["8", "9"] }));
  expect(loadGateProgress(storage)).toEqual(EMPTY_PROGRESS);
  store.set(GATE_PROGRESS_KEY, "{not json");
  expect(loadGateProgress(storage)).toEqual(EMPTY_PROGRESS);

  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  expect(loadGateProgress(throwing)).toEqual(EMPTY_PROGRESS);
  expect(() => saveGateProgress(EMPTY_PROGRESS, throwing)).not.toThrow();
});
