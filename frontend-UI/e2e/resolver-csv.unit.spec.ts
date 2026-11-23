import { test, expect } from "@playwright/test";
import { resolvedRowsToCsv, type BatchResolveRow } from "../src/lib/resolver";

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "viewport-independent unit tests");
});

/**
 * The Link Resolver's "Export CSV". Titles and usernames are written by other
 * SoundCloud users and the link is whatever was pasted, so every cell goes
 * through `csvEscape`: quoted, and prefixed with an apostrophe when a
 * spreadsheet would read it as a formula.
 */
const HEADER = "index,status,type,title,artist,url,permalink";

const track = (over: Partial<BatchResolveRow> & { title?: string; artist?: string } = {}): BatchResolveRow => ({
  index: 0,
  url: "https://soundcloud.com/a/b",
  status: "ok",
  data: {
    type: "track",
    id: 1,
    title: over.title ?? "Song",
    user: { username: over.artist ?? "artist" },
    permalink_url: "https://soundcloud.com/a/b",
  } as BatchResolveRow["data"],
  ...over,
});

const lines = (rows: BatchResolveRow[]) => resolvedRowsToCsv(rows).split("\n");

test("the first line is the fixed header, with no BOM in front of it", () => {
  const csv = resolvedRowsToCsv([track()]);
  expect(csv.split("\n")[0]).toBe(HEADER);
  expect(csv.charCodeAt(0)).not.toBe(0xfeff);
});

test("a plain track row: every cell quoted, nothing prefixed", () => {
  expect(lines([track()])[1]).toBe(
    '"0","ok","track","Song","artist","https://soundcloud.com/a/b","https://soundcloud.com/a/b"',
  );
});

const FORMULAS: Array<[string, string]> = [
  ["=", '=HYPERLINK("http://evil.example.com","click")'],
  ["+", "+cmd|' /C calc'!A0"],
  ["-", "-2+3"],
  ["@", "@SUM(A1)"],
  ["tab", "\t=1+1"],
  ["CR", "\r=1+1"],
  ["line feed", "\n=1+1"],
  ["a leading space", " =1+1"],
  ["a full-width equals", "＝1+1"],
  ["a zero-width space", "​=1+1"],
];

for (const [label, value] of FORMULAS) {
  const guarded = `"'${value.replaceAll('"', '""')}"`;

  test(`a title starting with ${label} is literal text`, () => {
    const row = resolvedRowsToCsv([track({ title: value })]).slice(HEADER.length + 1);
    expect(row).toBe(`"0","ok","track",${guarded},"artist","https://soundcloud.com/a/b","https://soundcloud.com/a/b"`);
  });

  test(`an artist starting with ${label} is literal text`, () => {
    const row = resolvedRowsToCsv([track({ artist: value })]).slice(HEADER.length + 1);
    expect(row).toBe(`"0","ok","track","Song",${guarded},"https://soundcloud.com/a/b","https://soundcloud.com/a/b"`);
  });

  test(`a pasted link starting with ${label} is literal text, on a failed row too`, () => {
    const row = resolvedRowsToCsv([{ index: 3, url: value, status: "error", error: "Resolve failed" }]).slice(HEADER.length + 1);
    expect(row).toBe(`"3","error","","","",${guarded},""`);
  });
}

test("a profile row: the username is the title and the artist", () => {
  const row = lines([{
    index: 1,
    url: "https://soundcloud.com/evil",
    status: "ok",
    data: { type: "user", id: 9, username: "=cmd", permalink_url: "https://soundcloud.com/evil" } as BatchResolveRow["data"],
  }])[1];
  expect(row).toBe(`"1","ok","user","'=cmd","'=cmd","https://soundcloud.com/evil","https://soundcloud.com/evil"`);
});

test("a playlist row falls back to its own username when it has no user", () => {
  const row = lines([{
    index: 2,
    url: "https://soundcloud.com/u/sets/s",
    status: "ok",
    data: { type: "playlist", id: 4, title: "Set", username: "@owner", permalink_url: "https://soundcloud.com/u/sets/s" } as BatchResolveRow["data"],
  }])[1];
  expect(row).toBe(`"2","ok","playlist","Set","'@owner","https://soundcloud.com/u/sets/s","https://soundcloud.com/u/sets/s"`);
});

test("quotes, commas and a newline in a title stay inside one cell", () => {
  const csv = resolvedRowsToCsv([track({ title: 'He said "hi", twice\nthen left' })]);
  expect(csv.slice(HEADER.length + 1)).toBe(
    '"0","ok","track","He said ""hi"", twice\nthen left","artist","https://soundcloud.com/a/b","https://soundcloud.com/a/b"',
  );
});

test("the numeric index is never prefixed, and ordinary text is unchanged", () => {
  const row = lines([track({ index: 12, title: "Artist - Title (re-edit)", artist: "a@b" })])[1];
  expect(row).toBe('"12","ok","track","Artist - Title (re-edit)","a@b","https://soundcloud.com/a/b","https://soundcloud.com/a/b"');
});

test("rows come out in the order given, one line each", () => {
  const out = lines([track({ index: 0 }), { index: 1, url: "https://soundcloud.com/x", status: "error", error: "x" }, track({ index: 2 })]);
  expect(out).toHaveLength(4);
  expect(out.slice(1).map((l) => l.split(",")[0])).toEqual(['"0"', '"1"', '"2"']);
});
