import { test, expect } from "@playwright/test";
import { csvEscape } from "../src/lib/csv";
import { followingsToCsv, repostsToCsv, tracksToCsv } from "../src/lib/export";

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "viewport-independent unit tests");
});

/**
 * Adversarial cells for `csvEscape`, the browser's one CSV cell writer
 * (downloadCsv, the Export tool's escapeCsvCell, the resolver's CSV).
 */
const GUARDED: Array<[string, string, string]> = [
  ["CR then =", "\r=1+1", "\"'\r=1+1\""],
  ["tab then =", "\t=1+1", "\"'\t=1+1\""],
  ["a lone -", "-", "\"'-\""],
  ["a lone +", "+", "\"'+\""],
  ["+1 as a string", "+1", "\"'+1\""],
  ["-1 as a string", "-1", "\"'-1\""],
  ["quotes after =", '="a""b"', "\"'=\"\"a\"\"\"\"b\"\"\""],
  ["newline inside a prefixed cell", "=1+1\n=2+2", "\"'=1+1\n=2+2\""],
  ["comma after @", "@SUM(1,2)", "\"'@SUM(1,2)\""],
];

for (const [label, value, expected] of GUARDED) {
  test(`csvEscape guards ${label}`, () => {
    expect(csvEscape(value)).toBe(expected);
  });
}

// Not on the guarded list (= + - @ tab CR, OWASP's set). Pinned so a change is
// deliberate. Excel and LibreOffice import ` =1+1` as text.
const PASSED_THROUGH: Array<[string, string]> = [
  ["leading space then =", " =1+1"],
  ["full-width equals", "＝1+1"],
  ["BOM then =", "﻿=1+1"],
  ["= in the middle", "a=b"],
];

for (const [label, value] of PASSED_THROUGH) {
  test(`csvEscape passes ${label} through unprefixed (documented residual)`, () => {
    expect(csvEscape(value)).toBe(`"${value}"`);
  });
}

test("csvEscape: null and undefined are empty cells", () => {
  expect(csvEscape(null)).toBe('""');
  expect(csvEscape(undefined)).toBe('""');
});

test("csvEscape: booleans, bigints and negative numbers are not prefixed", () => {
  expect(csvEscape(true)).toBe('"true"');
  expect(csvEscape(BigInt(-5))).toBe('"-5"');
  expect(csvEscape(-0.5)).toBe('"-0.5"');
});

// The typeof-string check means an array or object whose String() opens with a
// formula character is not guarded. No caller passes one today: every
// user-text column in downloadCsv's callers, the export writers and the
// resolver is a string. This pins the behaviour so a new caller is a choice.
test("csvEscape: a non-string object is stringified unprefixed (no caller passes one today)", () => {
  expect(csvEscape(["=1+1"])).toBe('"=1+1"');
  expect(csvEscape({ toString: () => "=1+1" })).toBe('"=1+1"');
});

test("tracksToCsv: a numeric id stays a bare number, a hostile title does not", () => {
  const csv = tracksToCsv([{ id: -1, title: "-1", user: { username: "+1" }, permalink_url: "" }]);
  expect(csv.split("\n")[1]).toBe(`"'-1","'+1","","-1"`);
});

test("followingsToCsv: zero counts are not prefixed", () => {
  const csv = followingsToCsv([
    { id: 1, username: "@me", full_name: "", permalink_url: "", followers_count: 0, track_count: 0 },
  ]);
  expect(csv.split("\n")[1]).toBe(`"'@me","","","0","0","1"`);
});

test("repostsToCsv: a playlist reposted with a formula title is guarded", () => {
  const csv = repostsToCsv([
    { id: 2, resourceType: "playlist", title: "=IMPORTXML(1)", user: { username: "u" }, permalink_url: "", created_at: "" },
  ]);
  expect(csv.split("\n")[1]).toBe(`"playlist","'=IMPORTXML(1)","u","","","2"`);
});

test("no writer adds a BOM or CRLF line endings", () => {
  const csv = tracksToCsv([{ id: 1, title: "a", user: { username: "b" }, permalink_url: "" }]);
  expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  expect(csv).not.toContain("\r\n");
});
