import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { mockApi } from "./fixtures/api";

/**
 * The Link Resolver's "Export CSV", end to end: resolve several links, press
 * the button, and read the file the browser saved. The cells come from other
 * people (titles, usernames) and from the paste box, so a spreadsheet must
 * open every one of them as text. resolver-csv.unit.spec.ts covers the writer
 * cell by cell; this pins that the button really uses it.
 */
const HOSTILE = {
  results: [
    {
      index: 0,
      url: "https://soundcloud.com/a/one",
      status: "ok",
      data: {
        type: "track",
        id: 100,
        title: '=HYPERLINK("http://evil.example.com","click")',
        user: { username: "+cmd|' /C calc'!A0" },
        duration_ms: 200000,
        permalink_url: "https://soundcloud.com/a/one",
      },
    },
    {
      index: 1,
      url: "https://soundcloud.com/a/sets/two",
      status: "ok",
      data: {
        type: "playlist",
        id: 1,
        title: " =1+1",
        user: { username: "＠SUM(A1)" },
        track_count: 12,
        permalink_url: "https://soundcloud.com/a/sets/two",
      },
    },
    {
      index: 2,
      url: "https://soundcloud.com/three",
      status: "ok",
      data: { type: "user", id: 9, username: "-2+3", followers_count: 5, permalink_url: "https://soundcloud.com/three" },
    },
    { index: 3, url: "https://soundcloud.com/a/missing", status: "error", error: "Not found on SoundCloud, or private" },
  ],
  summary: { total: 4, ok: 3, error: 1 },
  meta: { version: "2", resolved_at: "2026-09-22T12:00:00.000Z" },
};

const EXPECTED = [
  "index,status,type,title,artist,url,permalink",
  `"0","ok","track","'=HYPERLINK(""http://evil.example.com"",""click"")","'+cmd|' /C calc'!A0","https://soundcloud.com/a/one","https://soundcloud.com/a/one"`,
  `"1","ok","playlist","' =1+1","'＠SUM(A1)","https://soundcloud.com/a/sets/two","https://soundcloud.com/a/sets/two"`,
  `"2","ok","user","'-2+3","'-2+3","https://soundcloud.com/three","https://soundcloud.com/three"`,
  `"3","error","","","","https://soundcloud.com/a/missing",""`,
].join("\n");

test("link-resolver: Export CSV saves every hostile cell as literal text", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the file is the same at every width");

  await mockApi(page);
  await page.route("**/api/resolve/batch**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HOSTILE) }),
  );
  await page.goto("/link-resolver/");

  await page.getByLabel("SoundCloud links").fill(HOSTILE.results.map((r) => r.url).join("\n"));
  await page.getByRole("button", { name: "Resolve 4 links" }).click();
  await page.getByRole("heading", { name: "Results" }).waitFor();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe("resolver-results.csv");
  const saved = await readFile(await download.path(), "utf8");
  expect(saved).toBe(EXPECTED);
});
