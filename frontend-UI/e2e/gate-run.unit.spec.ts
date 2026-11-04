import { test, expect } from "@playwright/test";
import { parseGateRun, parseGateRunJson, summaryLine, summaryText, hasGateSection } from "../src/lib/gate-run";

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "viewport-independent unit tests");
});

const v1 = { total: 5, index: 2, completed: 2, failed: 1, active: true, downloadedCount: 2, skipped: 0, failures: [] };

test("a v1 payload parses as version 1 with no items", () => {
  const run = parseGateRun(v1)!;
  expect(run.version).toBe(1);
  expect(run).toMatchObject({ total: 5, completed: 2, failed: 1, active: true, items: [] });
  expect(hasGateSection(run)).toBe(false);
});

test("a v2 payload keeps its items; unknown fields and unknown values are tolerated", () => {
  const run = parseGateRun({
    ...v1,
    version: 2,
    runId: "r1",
    notice: "  Keep the lid open  ",
    future: { anything: true },
    items: [
      { id: 1, title: "A", artist: "X", site: "droploud", gateUrl: "https://droploud.com/a", status: "running", step: "repost", extra: 1 },
      { id: 2, title: "B", artist: "Y", site: "cobrand", gateUrl: "javascript:alert(1)", status: "exploded" },
      { id: "nope", title: "C" },
      null,
      7,
    ],
  })!;
  expect(run.version).toBe(2);
  expect(run.notice).toBe("Keep the lid open");
  expect(run.items.map((i) => i.id)).toEqual([1, 2]);
  expect(run.items[0]).toMatchObject({ status: "running", step: "repost", gateUrl: "https://droploud.com/a" });
  expect(run.items[1]).toMatchObject({ status: "waiting", gateUrl: "" });
  expect(hasGateSection(run)).toBe(true);
});

test("a later version is read as v2", () => {
  expect(parseGateRun({ ...v1, version: 3, items: [] })!.version).toBe(2);
});

test("garbage never throws", () => {
  for (const g of [null, undefined, 5, "x", [], [1], true, () => 1, { items: "no", summary: 5, total: "9" }, { version: 2, items: {}, summary: { counts: null, tracks: [] } }]) {
    expect(() => parseGateRun(g)).not.toThrow();
  }
  expect(parseGateRun(null)).toBeNull();
  expect(parseGateRun([])).toBeNull();
  expect(parseGateRun({ total: "9", completed: -3 })).toMatchObject({ total: 0, completed: 0 });
  expect(parseGateRunJson("{not json")).toBeNull();
  expect(parseGateRunJson("")).toBeNull();
  expect(parseGateRunJson(JSON.stringify(v1))!.version).toBe(1);
});

const track = (id: number) => ({ id, title: `T${id}`, artist: `A${id}` });
const summary = {
  runId: "r1",
  startedAt: 1,
  endedAt: 2,
  gates: 9,
  downloaded: 8,
  failed: 1,
  counts: { follow: 9, like: 9, comment: 9, repost: 9, emailSignup: 3, smsSignup: 1 },
  commentText: "fire",
  tracks: { follow: [track(1)], like: [track(1)], comment: [track(1)], repost: [track(1)], emailSignup: [track(1), track(2), track(3)], smsSignup: [track(4)] },
  actionsWithoutFile: [{ ...track(5), site: "droploud", reason: "no download after unlock" }],
};

test("the summary line and the copied text", () => {
  const run = parseGateRun({ ...v1, version: 2, items: [], summary })!;
  expect(summaryLine(run.summary!)).toBe(
    "This run: 9 gates · followed 9 artists · 9 likes · 9 comments (“fire”) · 9 reposts · 3 email signups · 1 SMS signup",
  );
  const text = summaryText(run.summary!);
  expect(text).toContain("Email signups:\n- A1 - T1\n- A2 - T2\n- A3 - T3");
  expect(text).toContain("Actions done without a file:\n- A5 - T5 (Droploud): no download after unlock");
});

test("zero counts are left out and a missing count falls back to the list", () => {
  const run = parseGateRun({ version: 2, summary: { gates: 1, counts: { like: 0 }, tracks: { follow: [track(1)] } } })!;
  expect(summaryLine(run.summary!)).toBe("This run: 1 gate · followed 1 artist");
});
