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

async function open(page: Page, { owner = true, likes = LIKES } = {}) {
  await mockApi(page);
  await page.route((url) => url.pathname === "/api/likes", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ collection: likes, total: likes.length }) }),
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
  await expect(page.getByRole("button", { name: "Download direct (1)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export Hypeddit queue (1)" })).toBeVisible();

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

test("the Hypeddit queue has only gates for tracks you don't have, in the runner's format", async ({ page }) => {
  const likes = [
    ...LIKES,
    // Different version behind a Hypeddit gate: wanted.
    { ...base, id: 6, title: "John Summit - Lights Go Out (Gate Remix)", user: { username: "Gate Remixer" }, permalink_url: "https://soundcloud.com/g/6", purchase_url: "https://hypeddit.com/g/six" },
    // Already in Rekordbox, also behind a gate: must not be queued.
    { ...base, id: 7, title: "RÜFUS DU SOL - INNERBLOOM (MACHAKI REMIX)", user: { username: "MACHAKI" }, permalink_url: "https://soundcloud.com/m/7", purchase_url: "https://hypeddit.com/g/seven" },
    // Missing, but a Droploud gate: the runner only does Hypeddit.
    { ...base, id: 8, title: "Droploud One", user: { username: "Drop Artist" }, permalink_url: "https://soundcloud.com/d/8", purchase_url: "https://droploud.com/x/8" },
  ];
  await open(page, { likes });
  await page.getByLabel("Rekordbox collection (XML)").setInputFiles(XML);
  await expect(page.locator("main").getByText(/Of 8 tracks/)).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Hypeddit queue (2)" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("hypeddit-queue-not-in-rekordbox.json");
  const file = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  expect(file).toEqual({
    queue: [
      { id: 4, title: "Gated One", artist: "Gate Artist", hypedditUrl: "https://hypeddit.com/g/four" },
      { id: 6, title: "John Summit - Lights Go Out (Gate Remix)", artist: "Gate Remixer", hypedditUrl: "https://hypeddit.com/g/six" },
    ],
  });
});

test("work through gates: opens each gate in a new tab, remembers done and skipped across a reload", async ({ page, context }) => {
  // The gates themselves are other sites; stand them in so nothing leaves the test.
  await context.route(/^https:\/\/(hypeddit|droploud)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>gate</title>" }),
  );
  const likes = [
    ...LIKES,
    { ...base, id: 6, title: "John Summit - Lights Go Out (Gate Remix)", user: { username: "Gate Remixer" }, permalink_url: "https://soundcloud.com/g/6", purchase_url: "https://hypeddit.com/g/six" },
    { ...base, id: 7, title: "RÜFUS DU SOL - INNERBLOOM (MACHAKI REMIX)", user: { username: "MACHAKI" }, permalink_url: "https://soundcloud.com/m/7", purchase_url: "https://hypeddit.com/g/seven" },
    { ...base, id: 8, title: "Droploud One", user: { username: "Drop Artist" }, permalink_url: "https://soundcloud.com/d/8", purchase_url: "https://droploud.com/x/8" },
  ];
  await open(page, { likes });
  await page.getByLabel("Rekordbox collection (XML)").setInputFiles(XML);

  // Gates for tracks you don't have, any site: 4 and 8 missing, 6 another version. 7 is owned.
  await page.getByRole("button", { name: "Work through gates (3)" }).click();
  const panel = page.getByRole("region", { name: "Work through gates" });
  await expect(panel.getByText("Gates worked through — 0/3")).toBeVisible();
  await expect(panel.getByText("Gated One", { exact: true })).toBeVisible();

  const popupPromise = page.waitForEvent("popup");
  await panel.getByRole("button", { name: "Open Hypeddit gate" }).click();
  const popup = await popupPromise;
  expect(popup.url()).toBe("https://hypeddit.com/g/four");
  await popup.close();
  await expect(panel.getByRole("button", { name: "Open Hypeddit gate again" })).toBeVisible();

  await panel.getByRole("button", { name: "Done — next" }).click();
  await expect(panel.getByText("John Summit - Lights Go Out (Gate Remix)")).toBeVisible();
  await panel.getByRole("button", { name: "Skip" }).click();
  await expect(panel.getByText("Droploud One")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Open Droploud gate" })).toBeVisible();
  await expect(panel.getByText("1 done · 1 skipped")).toBeVisible();

  // Progress lives in this browser: a reload (and re-reading the XML) picks up at the same gate.
  await page.reload();
  await page.getByLabel("Rekordbox collection (XML)").setInputFiles(XML);
  await page.getByRole("button", { name: "Work through gates (3)" }).click();
  await expect(panel.getByText("Droploud One")).toBeVisible();
  await expect(panel.getByText("Gates worked through — 2/3")).toBeVisible();

  await panel.getByRole("button", { name: "Undo" }).click();
  await expect(panel.getByText("John Summit - Lights Go Out (Gate Remix)")).toBeVisible();
  await panel.getByRole("button", { name: "Skip" }).click();
  await panel.getByRole("button", { name: "Done — next" }).click();
  await expect(panel.getByText("Every gate is marked. 1 skipped.")).toBeVisible();
  await panel.getByRole("button", { name: "Go through the skipped ones again" }).click();
  await expect(panel.getByText("John Summit - Lights Go Out (Gate Remix)")).toBeVisible();
  await panel.getByRole("button", { name: "Done — next" }).click();
  await expect(panel.getByText("All 3 gates done.")).toBeVisible();

  const results = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
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
