import { test, expect } from "@playwright/test";
import { csvEscape } from "../src/lib/csv";
import { escapeCsvCell, followingsToCsv, repostsToCsv, tracksToCsv } from "../src/lib/export";

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "viewport-independent unit tests");
});

/**
 * Spreadsheet formula injection in the Export tool's CSVs. Titles, artist
 * names and usernames are written by other SoundCloud users, and Excel /
 * Sheets / LibreOffice execute a cell that opens with =, +, -, @, tab or CR.
 * Every writer must prefix such a cell with an apostrophe so it opens as text.
 */
const PREFIXES: Array<[string, string]> = [
  ["=", '=HYPERLINK("http://evil.example.com","click")'],
  ["+", "+cmd"],
  ["-", "-2+3"],
  ["@", "@SUM(A1)"],
  ["tab", "\t=1+1"],
  ["CR", "\r=1+1"],
];

for (const [label, value] of PREFIXES) {
  test(`csvEscape neutralises a cell starting with ${label}`, () => {
    expect(csvEscape(value)).toBe(`"'${value.replaceAll('"', '""')}"`);
  });

  test(`escapeCsvCell neutralises a cell starting with ${label}`, () => {
    expect(escapeCsvCell(value)).toBe(`"'${value.replaceAll('"', '""')}"`);
  });

  test(`tracksToCsv neutralises a title and an artist starting with ${label}`, () => {
    const csv = tracksToCsv([
      { id: 7, title: value, user: { username: value }, permalink_url: "https://soundcloud.com/a/b" },
    ]);
    const row = csv.split("\n").slice(1).join("\n");
    // Title and artist are trimmed by the writer, so a leading tab or CR is
    // gone before escaping; what is left (`=1+1`) must still be guarded.
    const cell = csvEscape(value.trim());
    expect(cell.startsWith(`"'`)).toBe(true);
    expect(row).toBe(`${cell},${cell},"https://soundcloud.com/a/b","7"`);
  });

  test(`followingsToCsv neutralises a username and a name starting with ${label}`, () => {
    const csv = followingsToCsv([
      { id: 9, username: value, full_name: value, permalink_url: "https://soundcloud.com/u", followers_count: 3, track_count: 0 },
    ]);
    const row = csv.split("\n").slice(1).join("\n");
    const cell = csvEscape(value);
    expect(cell.startsWith(`"'`)).toBe(true);
    expect(row).toBe(`${cell},${cell},"https://soundcloud.com/u","3","0","9"`);
  });

  test(`repostsToCsv neutralises a title and an artist starting with ${label}`, () => {
    const csv = repostsToCsv([
      {
        id: 11,
        resourceType: "track",
        title: value,
        user: { display_name: value },
        permalink_url: "https://soundcloud.com/x",
        created_at: "2026-11-01T00:00:00Z",
      },
    ]);
    const row = csv.split("\n").slice(1).join("\n");
    const title = csvEscape(value);
    const artist = csvEscape(value.trim()); // getArtistName trims
    expect(title.startsWith(`"'`)).toBe(true);
    expect(artist.startsWith(`"'`)).toBe(true);
    expect(row).toBe(`"track",${title},${artist},"https://soundcloud.com/x","2026-11-01T00:00:00Z","11"`);
  });
}

test("ordinary values are quoted but not prefixed", () => {
  expect(csvEscape("Night Drive")).toBe('"Night Drive"');
  expect(csvEscape('Say "hi", then go')).toBe('"Say ""hi"", then go"');
  expect(csvEscape("a-b")).toBe('"a-b"');
  expect(csvEscape(null)).toBe('""');
  expect(csvEscape(undefined)).toBe('""');
});

test("a number is never prefixed, even a negative one", () => {
  // A JS number cannot carry a formula; prefixing -1 would turn a count into text.
  expect(csvEscape(-1)).toBe('"-1"');
  expect(csvEscape(0)).toBe('"0"');
  expect(escapeCsvCell(-42)).toBe('"-42"');
});

test("the header row of each writer is unchanged", () => {
  expect(tracksToCsv([]).split("\n")[0]).toBe("title,artist,permalink_url,track_id");
  expect(followingsToCsv([]).split("\n")[0]).toBe(
    "username,display_name,permalink_url,followers_count,track_count,user_id"
  );
  expect(repostsToCsv([]).split("\n")[0]).toBe("type,title,artist,permalink_url,created_at,id");
});
