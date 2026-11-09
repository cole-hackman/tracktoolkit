import { test, expect } from "@playwright/test";
import {
  GATE_REPORTED_CAP,
  GATE_REPORTED_KEY,
  batchReport,
  gateReportKey,
  loadReported,
  pendingGateResults,
  saveReported,
} from "../src/lib/gate-usage";

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "viewport-independent unit tests");
});

const progress = (items: unknown[], extra: Record<string, unknown> = {}) => ({ version: 2, runId: "run-abc-123", items, ...extra });
const item = (id: number, status: string, extra: Record<string, unknown> = {}) => ({ id, site: "hypeddit", title: `T${id}`, artist: "A", status, ...extra });
const none = new Set<string>();

test("only finished gates are reported: done and failed, never waiting, running, saving or skipped", () => {
  const report = pendingGateResults(
    progress([item(1, "done"), item(2, "failed", { reason: "No email set" }), item(3, "waiting"), item(4, "running"), item(5, "saving"), item(6, "skipped", { reason: "Already downloaded" })]),
    none,
  );
  expect(report?.runId).toBe("run-abc-123");
  expect(report?.results.map((r) => [r.id, r.status])).toEqual([[1, "done"], [2, "failed"]]);
  expect(report?.results[1].reason).toBe("No email set");
});

test("carries the title, artist and account actions the extension recorded, and drops what the server does not take", () => {
  const report = pendingGateResults(
    progress([item(7, "done", { site: "droploud", actions: ["follow", "repost", "delete-account", 5] })]),
    none,
  );
  expect(report?.results[0]).toEqual({ id: 7, site: "droploud", status: "done", title: "T7", artist: "A", actions: ["follow", "repost"] });
});

test("a reason only travels with a failure", () => {
  const report = pendingGateResults(progress([item(1, "done", { reason: "stale" })]), none);
  expect(report?.results[0]).not.toHaveProperty("reason");
});

test("what was already reported is not reported again; a failure and a later success are different outcomes", () => {
  const reported = new Set([gateReportKey("run-abc-123", 1, "done"), gateReportKey("run-abc-123", 2, "failed")]);
  const report = pendingGateResults(progress([item(1, "done"), item(2, "done"), item(3, "failed")]), reported);
  expect(report?.results.map((r) => [r.id, r.status])).toEqual([[2, "done"], [3, "failed"]]);
  expect(pendingGateResults(progress([item(1, "done")]), reported)).toBeNull();
});

test("a repeat inside one payload is reported once", () => {
  const report = pendingGateResults(progress([item(1, "done"), item(1, "done")]), none);
  expect(report?.results).toHaveLength(1);
});

test("anything unrecognised reads as nothing: an old extension, a site we do not log, a bad run or track id", () => {
  expect(pendingGateResults({ total: 3, completed: 1 }, none)).toBeNull(); // v1
  expect(pendingGateResults(null, none)).toBeNull();
  expect(pendingGateResults("nope", none)).toBeNull();
  expect(pendingGateResults({ version: 2, runId: null, items: [item(1, "done")] }, none)).toBeNull();
  expect(pendingGateResults({ version: 2, runId: "bad run!", items: [item(1, "done")] }, none)).toBeNull();
  expect(pendingGateResults({ version: 2, runId: "run-1" }, none)).toBeNull();
  expect(pendingGateResults(progress([item(1, "done", { site: "toneden" })]), none)).toBeNull();
  expect(pendingGateResults(progress([item(0, "done"), item(-4, "done"), { id: "9", site: "hypeddit", status: "done" }, null, 7]), none)).toBeNull();
});

test("long text is cut to what the server accepts", () => {
  const report = pendingGateResults(progress([item(1, "failed", { title: "t".repeat(500), reason: "r".repeat(900) })]), none);
  expect(report?.results[0].title).toHaveLength(200);
  expect(report?.results[0].reason).toHaveLength(300);
});

test("a big report is split into calls of at most 50", () => {
  const items = Array.from({ length: 120 }, (_, i) => item(i + 1, "done"));
  const report = pendingGateResults(progress(items), none)!;
  expect(batchReport(report).map((b) => b.results.length)).toEqual([50, 50, 20]);
  expect(batchReport(report).every((b) => b.runId === "run-abc-123")).toBe(true);
});

test("the reported set round-trips through storage, keeps only the newest, and survives junk or a blocked store", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const many = new Set(Array.from({ length: GATE_REPORTED_CAP + 5 }, (_, i) => `run:${i}:done`));
  saveReported(storage, many);
  const loaded = loadReported(storage);
  expect(loaded.size).toBe(GATE_REPORTED_CAP);
  expect(loaded.has("run:0:done")).toBe(false);
  expect(loaded.has(`run:${GATE_REPORTED_CAP + 4}:done`)).toBe(true);

  store.set(GATE_REPORTED_KEY, "{not json");
  expect(loadReported(storage).size).toBe(0);
  store.set(GATE_REPORTED_KEY, JSON.stringify([1, "ok", null]));
  expect([...loadReported(storage)]).toEqual(["ok"]);

  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  expect(loadReported(throwing).size).toBe(0);
  expect(() => saveReported(throwing, many)).not.toThrow();
});
