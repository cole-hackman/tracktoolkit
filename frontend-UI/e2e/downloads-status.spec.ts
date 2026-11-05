import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import { mockApi, FAKE_PLAYLIST_DETAIL } from "./fixtures/api";

/**
 * /downloads tells you what each track's situation is, in words, and only
 * calls a track "downloadable" when a file is actually on offer: SoundCloud's
 * own download or a free gate. A store link is a link, never a download.
 */

const base = {
  user: { username: "testartist" },
  artwork_url: null as string | null,
  duration: 200000,
  access: "playable",
};

const TRACKS = [
  { ...base, id: 1, title: "Direct One", permalink_url: "https://soundcloud.com/a/1", downloadable: true, download_url: "https://api.soundcloud.com/tracks/soundcloud:tracks:1/download" },
  { ...base, id: 2, title: "Gate Two", permalink_url: "https://soundcloud.com/a/2", downloadable: false, purchase_url: "https://hypeddit.com/a/two", purchase_title: "FREE DOWNLOAD" },
  { ...base, id: 3, title: "Store Three", permalink_url: "https://soundcloud.com/a/3", downloadable: "false", purchase_url: "https://www.beatport.com/track/three/3", purchase_title: "Buy" },
  { ...base, id: 4, title: "Preorder Four", permalink_url: "https://soundcloud.com/a/4", purchase_url: "https://www.beatport.com/release/four/4", purchase_title: "PRE ORDER" },
  { ...base, id: 5, title: "Nothing Five", permalink_url: "https://soundcloud.com/a/5" },
];

// Gates on the sites the extension reports separately. Kept out of TRACKS so
// the counts the older tests pin do not move.
const GATE_TRACKS = [
  { ...base, id: 6, title: "Droploud Six", permalink_url: "https://soundcloud.com/a/6", purchase_url: "https://droploud.com/a/six", purchase_title: "FREE DOWNLOAD" },
  { ...base, id: 7, title: "Droploud Seven", permalink_url: "https://soundcloud.com/a/7", purchase_url: "https://droploud.com/a/seven", purchase_title: "FREE DOWNLOAD" },
  { ...base, id: 8, title: "Cobrand Eight", permalink_url: "https://soundcloud.com/a/8", purchase_url: "https://drop.cobrand.com/a/eight", purchase_title: "FREE DOWNLOAD" },
  // Not free: an SMS sign-up. A link, so it never shows in the default list.
  { ...base, id: 9, title: "Cobrand Nine", permalink_url: "https://soundcloud.com/a/9", purchase_url: "https://drop.cobrand.com/a/nine", purchase_title: "Sign up" },
];

type Posted = { type: string; queue: Array<Record<string, unknown>>; ts: number };
// postMessage is delivered in a later task than the click that sent it, so a
// read straight after the click can miss it. `posted` first lets that task run.
const posted = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return (window as unknown as { __posted: Posted[] }).__posted;
  });

async function open(
  page: Page,
  { owner = false, tracks = TRACKS, extGates }: { owner?: boolean; tracks?: typeof TRACKS; extGates?: string } = {},
) {
  // What the extension leaves in the page, and a recorder for what the page
  // sends it: the localStorage value is the last write, this is every message.
  await page.addInitScript((flag) => {
    if (flag !== null) localStorage.setItem("sc-toolkit-ext-gates", flag);
    localStorage.setItem("sc-toolkit-ext-installed", "1.0");
    const posted: unknown[] = [];
    (window as unknown as { __posted: unknown[] }).__posted = posted;
    window.addEventListener("message", (e) => {
      if (e.data?.type === "sc-toolkit-queue-set") posted.push(e.data);
    });
  }, extGates ?? null);
  await mockApi(page);
  await page.route(
    (url) => url.pathname === "/api/playlists/1",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...FAKE_PLAYLIST_DETAIL, track_count: tracks.length, tracks }),
      }),
  );
  if (owner) {
    await page.route(
      (url) => url.pathname === "/api/auth/me",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ userId: "u1", soundcloudId: 1000001, username: "testuser", displayName: "Test User", avatarUrl: null, isAdmin: false, canDownload: true }),
        }),
    );
  }
  await page.goto("/downloads/");
  await page.getByRole("button", { name: "Sample Playlist 1", exact: true }).click();
}

test("counts are honest and the default view lists only real downloads", async ({ page }) => {
  await open(page);
  const main = page.locator("main");
  await expect(main.getByText("(2 downloadable)")).toBeVisible();
  await expect(main.getByText("1 direct download · 1 free gate · 2 to buy or pre-order · 1 not available")).toBeVisible();
  await expect(page.locator("#app-live-region")).toHaveText(/^2 downloadable tracks in /);

  await expect(page.getByRole("button", { name: "Download Direct One (free download)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download Gate Two via Hypeddit" })).toBeVisible();
  await expect(main.getByText("Store Three")).toHaveCount(0);
  await expect(main.getByText("Direct download", { exact: true })).toBeVisible();
  await expect(main.getByText("Free gate · Hypeddit", { exact: true })).toBeVisible();
});

test("a store or pre-order is a link that says Buy / Pre-order — never a download button", async ({ page }) => {
  await open(page);
  await page.getByLabel("Show").selectOption("buy");
  const main = page.locator("main");

  const buy = page.getByRole("link", { name: "Buy Store Three on Beatport" });
  await expect(buy).toBeVisible();
  await expect(buy).toHaveAttribute("href", "https://www.beatport.com/track/three/3");
  await expect(page.getByRole("link", { name: "Pre-order Preorder Four on Beatport" })).toBeVisible();
  await expect(main.getByText("Pre-order · Beatport", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Download Store Three/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Download Preorder Four/ })).toHaveCount(0);
});

test("a track with nothing on offer says why and where to look", async ({ page }) => {
  await open(page);
  await page.getByLabel("Show").selectOption("unavailable");
  const main = page.locator("main");
  await expect(main.getByText("Nothing Five")).toBeVisible();
  await expect(main.getByText(/hasn't enabled downloads/)).toBeVisible();
  const beatport = page.getByRole("link", { name: "Search Beatport for Nothing Five" });
  await expect(beatport).toHaveAttribute("href", "https://www.beatport.com/search?q=testartist%20Nothing%20Five");
});

test("the normal list has a checkbox per automatic download, and only ticked tracks are queued", async ({ page }) => {
  await open(page, { owner: true });
  await expect(page.getByRole("checkbox", { name: "Select Direct One" })).toBeVisible();
  const gate = page.getByRole("checkbox", { name: "Select Gate Two" });
  await expect(gate).not.toBeChecked();
  await expect(page.getByRole("button", { name: /selected$/ })).toHaveCount(0);

  await gate.check();
  await page.getByRole("button", { name: "Download 1 selected" }).click();

  const sent = await page.evaluate(() => JSON.parse(localStorage.getItem("sc-toolkit-hypeddit-queue") ?? "{}"));
  // Hypeddit items keep `hypedditUrl` so an extension from before the other sites still takes them.
  expect(sent.queue).toEqual([
    { id: 2, title: "Gate Two", artist: "testartist", site: "hypeddit", gateUrl: "https://hypeddit.com/a/two", hypedditUrl: "https://hypeddit.com/a/two" },
  ]);
  expect(await posted(page)).toEqual([{ type: "sc-toolkit-queue-set", queue: sent.queue, ts: sent.ts }]);
  await expect(gate).not.toBeChecked();
  await expect(page.getByRole("region", { name: "Queue sent to extension" })).toBeFocused();
});

const ALL_TRACKS = [...TRACKS, ...GATE_TRACKS];

const storedQueue = (page: Page) =>
  page.evaluate(() => {
    const raw = localStorage.getItem("sc-toolkit-hypeddit-queue");
    return raw ? (JSON.parse(raw) as Posted) : null;
  });
const CONFIRM = "Send these gates to the extension?";
const DROPLOUD_LINE = (n: number) => `${n} Droploud gates will follow, like, comment and repost from your SoundCloud account.`;
const COBRAND_LINE = (n: number) => `${n} Cobrand gate${n === 1 ? "" : "s"} will sign your phone number up to artist SMS.`;

test("Droploud and Cobrand gates get a checkbox only when the extension reports the site; Hypeddit always does", async ({ page }) => {
  // No flag at all: an extension that predates the other sites.
  await open(page, { owner: true, tracks: ALL_TRACKS });
  await expect(page.getByRole("checkbox", { name: "Select Gate Two" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Direct One" })).toBeVisible();
  for (const name of ["Droploud Six", "Droploud Seven", "Cobrand Eight"]) {
    await expect(page.getByRole("button", { name: new RegExp(`^Download ${name} via`) })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: `Select ${name}` })).toHaveCount(0);
  }
  // Auto-Download is the same test: only the Hypeddit gate counts.
  await expect(page.getByRole("button", { name: "Auto-Download (1)" })).toBeVisible();
});

test("a flag that lists only some sites opens only those", async ({ page }) => {
  await open(page, { owner: true, tracks: ALL_TRACKS, extGates: " Hypeddit, DROPLOUD " });
  await expect(page.getByRole("checkbox", { name: "Select Droploud Six" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Droploud Seven" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Cobrand Eight" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Auto-Download (3)" })).toBeVisible();
});

test("a flag without hypeddit does not take the Hypeddit checkbox away", async ({ page }) => {
  await open(page, { owner: true, tracks: ALL_TRACKS, extGates: "droploud" });
  await expect(page.getByRole("checkbox", { name: "Select Gate Two" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Droploud Six" })).toBeVisible();
});

test("a Cobrand gate that is not a free download never gets a checkbox, flag or not", async ({ page }) => {
  await open(page, { owner: true, tracks: ALL_TRACKS, extGates: "hypeddit,droploud,cobrand" });
  await expect(page.getByRole("checkbox", { name: "Select Cobrand Eight" })).toBeVisible();
  await page.getByLabel("Show").selectOption("buy");
  await expect(page.getByRole("link", { name: "Open Cobrand Nine on Cobrand" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Cobrand Nine" })).toHaveCount(0);
});

test("a selection with Droploud and Cobrand gates asks first, says only what applies, and Cancel sends nothing", async ({ page }) => {
  await open(page, { owner: true, tracks: ALL_TRACKS, extGates: "hypeddit,droploud,cobrand" });
  await page.getByRole("checkbox", { name: "Select Gate Two" }).check();
  await page.getByRole("checkbox", { name: "Select Droploud Six" }).check();
  await page.getByRole("checkbox", { name: "Select Droploud Seven" }).check();
  await page.getByRole("button", { name: "Download 3 selected" }).click();

  const dialog = page.getByRole("dialog", { name: CONFIRM });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(DROPLOUD_LINE(2))).toBeVisible();
  await expect(dialog.getByText(/Cobrand/)).toHaveCount(0);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await storedQueue(page)).toBeNull();
  expect(await posted(page)).toEqual([]);
  // The selection survives, so the person can adjust it.
  await expect(page.getByRole("button", { name: "Download 3 selected" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Droploud Six" })).toBeChecked();

  // Add Cobrand: now both lines.
  await page.getByRole("checkbox", { name: "Select Cobrand Eight" }).check();
  await page.getByRole("button", { name: "Download 4 selected" }).click();
  await expect(dialog.getByText(DROPLOUD_LINE(2))).toBeVisible();
  await expect(dialog.getByText(COBRAND_LINE(1))).toBeVisible();
  await dialog.getByRole("button", { name: "Send to extension" }).click();
  await expect(dialog).toHaveCount(0);

  const sent = await storedQueue(page);
  expect(sent!.queue).toEqual([
    { id: 2, title: "Gate Two", artist: "testartist", site: "hypeddit", gateUrl: "https://hypeddit.com/a/two", hypedditUrl: "https://hypeddit.com/a/two" },
    { id: 6, title: "Droploud Six", artist: "testartist", site: "droploud", gateUrl: "https://droploud.com/a/six" },
    { id: 7, title: "Droploud Seven", artist: "testartist", site: "droploud", gateUrl: "https://droploud.com/a/seven" },
    { id: 8, title: "Cobrand Eight", artist: "testartist", site: "cobrand", gateUrl: "https://drop.cobrand.com/a/eight" },
  ]);
  expect(await posted(page)).toEqual([{ type: "sc-toolkit-queue-set", queue: sent!.queue, ts: sent!.ts }]);
  await expect(page.getByRole("checkbox", { name: "Select Droploud Six" })).not.toBeChecked();
});

test("a Cobrand-only selection names only Cobrand; Hypeddit and direct downloads send without asking", async ({ page }) => {
  await open(page, { owner: true, tracks: ALL_TRACKS, extGates: "hypeddit,droploud,cobrand" });
  await page.getByRole("checkbox", { name: "Select Cobrand Eight" }).check();
  await page.getByRole("button", { name: "Download 1 selected" }).click();
  const dialog = page.getByRole("dialog", { name: CONFIRM });
  await expect(dialog.getByText(COBRAND_LINE(1))).toBeVisible();
  await expect(dialog.getByText(/Droploud/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Clear", exact: true }).click();

  await page.getByRole("checkbox", { name: "Select Gate Two" }).check();
  await page.getByRole("button", { name: "Download 1 selected" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await storedQueue(page))!.queue).toHaveLength(1);
});

test("Auto-Download asks the same question, and Export (JSON) stays Hypeddit-only", async ({ page }) => {
  await open(page, { owner: true, tracks: ALL_TRACKS, extGates: "hypeddit,droploud,cobrand" });
  await page.getByRole("button", { name: "Auto-Download (4)" }).click();
  await expect(page.getByRole("button", { name: "Queue 4 tracks" })).toBeEnabled();

  await page.getByRole("button", { name: "Queue 4 tracks" }).click();
  const dialog = page.getByRole("dialog", { name: CONFIRM });
  await expect(dialog.getByText(DROPLOUD_LINE(2))).toBeVisible();
  await expect(dialog.getByText(COBRAND_LINE(1))).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await storedQueue(page)).toBeNull();
  expect(await posted(page)).toEqual([]);

  // The runner's file takes the Hypeddit gate and nothing else.
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export queue (JSON)" }).click();
  const file = JSON.parse(fs.readFileSync(await (await downloadPromise).path(), "utf8"));
  expect(file).toEqual({ queue: [{ id: 2, title: "Gate Two", artist: "testartist", hypedditUrl: "https://hypeddit.com/a/two" }] });

  await page.getByRole("button", { name: "Queue 4 tracks" }).click();
  await dialog.getByRole("button", { name: "Send to extension" }).click();
  expect((await storedQueue(page))!.queue.map((q) => q.site)).toEqual(["hypeddit", "droploud", "droploud", "cobrand"]);
  await expect(page.getByRole("button", { name: "Auto-Download (4)" })).toBeVisible();
});

test("Clear empties the selection, and a store link never gets a checkbox", async ({ page }) => {
  await open(page, { owner: true });
  await page.getByRole("checkbox", { name: "Select Gate Two" }).check();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByRole("button", { name: /selected$/ })).toHaveCount(0);

  await page.getByLabel("Show").selectOption("buy");
  await expect(page.getByRole("link", { name: "Buy Store Three on Beatport" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Store Three" })).toHaveCount(0);
});

test("without download access there are no checkboxes", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("button", { name: "Download Gate Two via Hypeddit" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /^Select / })).toHaveCount(0);
});

test("Auto-Download opens with every Hypeddit track selected, and Export follows the selection", async ({ page }) => {
  await open(page, { owner: true });
  await page.getByRole("button", { name: "Auto-Download (1)" }).click();
  await expect(page.getByRole("button", { name: "Queue 1 track" })).toBeEnabled();
  await page.getByRole("button", { name: "Deselect All" }).click();
  await expect(page.getByRole("button", { name: "Queue 0 tracks" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Export queue (JSON)" })).toBeDisabled();
});

test("every view is axe-clean and does not overflow", async ({ page }) => {
  await open(page);
  for (const view of ["downloadable", "buy", "unavailable", "all"]) {
    await page.getByLabel("Show").selectOption(view);
    await page.mouse.move(0, 0);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical"), view).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, view).toBeLessThanOrEqual(0);
  }
});

test("the track search narrows the list only: Download all, picks and Auto-Download still cover the whole source", async ({ page }) => {
  await open(page, { owner: true });
  const main = page.locator("main");
  const search = page.getByRole("searchbox", { name: "Search tracks" });
  await page.getByRole("checkbox", { name: "Select Direct One" }).check();

  await search.fill("gate");
  await expect(main.getByText("Showing 1 of 2 tracks")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download Gate Two via Hypeddit" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download Direct One (free download)" })).toHaveCount(0);
  // A hidden row is still in the source: Download all is every direct
  // download there, and a pick made before the search is still picked.
  await expect(page.getByRole("button", { name: "Download all (1)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download 1 selected" })).toBeVisible();

  // Title and artist both count, and every word has to match.
  await search.fill("testartist direct");
  await expect(main.getByText("Showing 1 of 2 tracks")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download Direct One (free download)" })).toBeVisible();

  await search.fill("nothing like this");
  await expect(main.getByText("No tracks match your search")).toBeVisible();

  // Auto-Download still selects every gate, whatever the search shows.
  await page.getByRole("button", { name: "Auto-Download (1)" }).click();
  await expect(page.getByRole("button", { name: "Queue 1 track" })).toBeEnabled();
  await expect(main.getByText("No tracks match your search")).toBeVisible();
  await search.fill("");
  await expect(page.getByRole("checkbox", { name: "Gate Two" })).toBeChecked();
});

test("the source picker searches playlists, keeps Liked Tracks in reach, and stays up to switch source", async ({ page }) => {
  await mockApi(page);
  await page.goto("/downloads/");
  const liked = page.getByRole("button", { name: "Liked Tracks", exact: true });
  await page.getByRole("searchbox", { name: "Search playlists" }).fill("playlist 2");
  await expect(page.getByRole("button", { name: "Sample Playlist 1", exact: true })).toHaveCount(0);
  await expect(liked).toBeVisible();

  await page.getByRole("button", { name: "Sample Playlist 2", exact: true }).click();
  await expect(page.getByRole("region", { name: /Sample Playlist 2/ })).toBeVisible();
  // Switching is one click on the same picker; Liked Tracks takes over.
  await liked.click();
  await expect(page.getByRole("region", { name: /Liked Tracks/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sample Playlist 2", exact: true })).toHaveAttribute("aria-pressed", "false");
});
