import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import { mockApi } from "./fixtures/api";

/**
 * /rekordbox-gaps compares a SoundCloud source with a Rekordbox collection
 * export read in the browser. The fixture XML is synthetic
 * (fixtures/rekordbox-collection.xml): two tracks the likes below have, one
 * unrelated, and an empty TRACK Rekordbox sometimes writes.
 */

const XML = path.join(__dirname, "fixtures", "rekordbox-collection.xml");
const base = { artwork_url: null as string | null, duration: 200000, access: "playable" };
const LIKES = [
  // Owned: same remix (Rekordbox keeps it in Mix).
  { ...base, id: 1, title: "RÜFUS DU SOL - INNERBLOOM (MACHAKI REMIX)", user: { username: "MACHAKI" }, permalink_url: "https://soundcloud.com/m/1" },
  // Other version: Rekordbox has the Dennett remix, this is another.
  { ...base, id: 2, title: "John Summit - Lights Go Out (Somebody VIP)", user: { username: "Somebody" }, permalink_url: "https://soundcloud.com/s/2" },
  // Missing, SoundCloud download enabled.
  { ...base, id: 3, title: "Fresh One", user: { username: "New Artist" }, permalink_url: "https://soundcloud.com/n/3", downloadable: true, download_url: "https://api.soundcloud.com/tracks/soundcloud:tracks:3/download" },
  // Missing, free gate.
  { ...base, id: 4, title: "Gated One", user: { username: "Gate Artist" }, permalink_url: "https://soundcloud.com/g/4", purchase_url: "https://hypeddit.com/g/four" },
  // Missing, store.
  { ...base, id: 5, title: "Store One", user: { username: "Store Artist" }, permalink_url: "https://soundcloud.com/st/5", purchase_url: "https://www.beatport.com/track/one/5", purchase_title: "Buy" },
];

async function open(page: Page, { owner = true } = {}) {
  await mockApi(page);
  await page.route((url) => url.pathname === "/api/likes", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ collection: LIKES, total: LIKES.length }) }),
  );
  await page.route((url) => url.pathname === "/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ userId: "u1", soundcloudId: 1000001, username: "testuser", displayName: "Test User", avatarUrl: null, isAdmin: false, canDownload: owner }),
    }),
  );
  await page.goto("/rekordbox-gaps/");
}

test("reads the export in the browser — nothing is uploaded — and sorts the likes into have / other version / missing", async ({ page }) => {
  await open(page);
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") sent.push(`${r.method()} ${r.url()}`);
    if ((r.postData() ?? "").includes("DJ_PLAYLISTS")) sent.push(`XML in ${r.url()}`);
  });

  await page.getByLabel("Rekordbox collection (XML)").setInputFiles(XML);
  const main = page.locator("main");
  await expect(main.getByText("rekordbox-collection.xml: 3 tracks · rekordbox 7.2.8")).toBeVisible();
  await expect(main.getByText("Of 5 tracks: 1 already in Rekordbox · 1 in a different version · 3 missing")).toBeVisible();
  expect(sent).toEqual([]);

  // Missing (the default view): each says where to get it.
  await expect(page.getByRole("button", { name: "Download Fresh One (free download)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download Gated One via Hypeddit" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Buy Store One on Beatport" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download missing (1)" })).toBeVisible();

  await page.getByLabel("Show").selectOption("other-version");
  await expect(main.getByText("You have: John Summit - Lights Go Out (Dennett Remix)")).toBeVisible();

  await page.getByLabel("Show").selectOption("owned");
  await expect(main.getByText(/In Rekordbox: RÜFUS DU SOL - Innerbloom · 124 BPM · 8A/)).toBeVisible();
});

test("the shopping list CSV has every track you don't have, with where to get it", async ({ page }) => {
  await open(page);
  await page.getByLabel("Rekordbox collection (XML)").setInputFiles(XML);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export shopping list (CSV)" }).click();
  const download = await downloadPromise;
  const csv = fs.readFileSync(await download.path(), "utf8");
  // lib/csv quotes every cell (and starts with a BOM for Excel).
  expect(csv).toContain('"Artist","Title","In Rekordbox","Where to get it","Link","Note"');
  expect(csv).toContain('"Somebody","John Summit - Lights Go Out (Somebody VIP)","different version"');
  expect(csv).toContain('"Gate Artist","Gated One","missing","Free gate · Hypeddit","https://hypeddit.com/g/four"');
  expect(csv).toContain('"Store Artist","Store One","missing","Buy · Beatport","https://www.beatport.com/track/one/5"');
  expect(csv).not.toContain("INNERBLOOM");
});

test("a file that isn't a Rekordbox collection export says so", async ({ page }) => {
  await open(page);
  await page.getByLabel("Rekordbox collection (XML)").setInputFiles({ name: "itunes.xml", mimeType: "text/xml", buffer: Buffer.from('<?xml version="1.0"?><plist><dict/></plist>') });
  await expect(page.locator("main").getByText(/not a Rekordbox collection export/)).toBeVisible();
});

test("accounts without download access see why, not the tool", async ({ page }) => {
  await open(page, { owner: false });
  await expect(page.locator("main").getByText("Not available on this account")).toBeVisible();
  await expect(page.getByLabel("Rekordbox collection (XML)")).toHaveCount(0);
});

test("axe-clean and no overflow in every view", async ({ page }) => {
  await open(page);
  await page.getByLabel("Rekordbox collection (XML)").setInputFiles(XML);
  await expect(page.locator("main").getByText(/Of 5 tracks/)).toBeVisible();
  for (const view of ["missing", "other-version", "owned"]) {
    await page.getByLabel("Show").selectOption(view);
    await page.mouse.move(0, 0);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical"), view).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, view).toBeLessThanOrEqual(0);
  }
});
