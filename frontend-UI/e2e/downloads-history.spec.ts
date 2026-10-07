import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi, FAKE_PLAYLIST_DETAIL } from "./fixtures/api";

/**
 * "Already downloaded" on /downloads — admin only. History comes from
 * /api/downloads/history (OperationLog rows the downloads already leave).
 */

const base = { user: { username: "testartist" }, artwork_url: null as string | null, duration: 200000, access: "playable" };
const direct = (n: number) => ({
  ...base,
  id: n,
  title: `Direct ${n}`,
  permalink_url: `https://soundcloud.com/a/${n}`,
  downloadable: true,
  download_url: `https://api.soundcloud.com/tracks/soundcloud:tracks:${n}/download`,
});
const TRACKS = [direct(1), direct(2), direct(3)];
const THIS_YEAR = new Date().getFullYear();

async function open(page: Page, { admin = true } = {}) {
  const historyCalls: string[] = [];
  await mockApi(page);
  await page.route((url) => url.pathname === "/api/playlists/1", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...FAKE_PLAYLIST_DETAIL, track_count: TRACKS.length, tracks: TRACKS }) }),
  );
  await page.route((url) => url.pathname === "/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ userId: "u1", soundcloudId: 1000001, username: "testuser", displayName: "Test User", avatarUrl: null, isAdmin: admin, canDownload: true }),
    }),
  );
  await page.route((url) => url.pathname === "/api/downloads/history", (route) => {
    historyCalls.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tracks: [{ trackId: 2, firstAt: `${THIS_YEAR}-10-03T09:00:00.000Z`, lastAt: `${THIS_YEAR}-10-03T09:00:00.000Z`, times: 1 }],
        retentionDays: 365,
      }),
    });
  });
  await page.goto("/downloads/");
  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();
  return historyCalls;
}

test("an admin sees which tracks are already downloaded, and Download all queues only the new ones", async ({ page }) => {
  await open(page);
  const main = page.locator("main");
  await expect(main.getByText("Downloaded 3 Oct", { exact: true })).toBeVisible();
  await expect(main.getByText(/· 1 already downloaded/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download all new (2)" })).toBeVisible();
  // The row's own button still downloads it again.
  await expect(page.getByRole("button", { name: "Download Direct 2 (free download)" })).toBeVisible();
});

test("Hide tracks I've already downloaded removes them from the list", async ({ page }) => {
  await open(page);
  const main = page.locator("main");
  await expect(main.getByText("Direct 2", { exact: true })).toBeVisible();
  await page.getByLabel("Hide tracks I’ve already downloaded").check();
  await expect(main.getByText("Direct 2", { exact: true })).toHaveCount(0);
  await expect(main.getByText("Direct 1", { exact: true })).toBeVisible();

  await page.mouse.move(0, 0);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("non-admins never ask for history and see no download marks", async ({ page }) => {
  const calls = await open(page, { admin: false });
  await expect(page.getByRole("button", { name: "Download all (3)" })).toBeVisible();
  await expect(page.locator("main").getByText(/^Downloaded /)).toHaveCount(0);
  expect(calls).toEqual([]);
});
