import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
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

async function open(page: Page, { owner = false } = {}) {
  await mockApi(page);
  await page.route(
    (url) => url.pathname === "/api/playlists/1",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...FAKE_PLAYLIST_DETAIL, track_count: TRACKS.length, tracks: TRACKS }),
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
  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();
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
