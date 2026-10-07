import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi, FAKE_PLAYLIST_DETAIL } from "./fixtures/api";

/**
 * The downloads page reads playlists with `?access=all`, so blocked tracks
 * arrive. They keep a row (so they can be selected and removed) but get no
 * download control and are not counted as downloadable.
 */

const track = (id: number, title: string, access: string) => ({
  id,
  title,
  user: { username: "testartist" },
  artwork_url: null as string | null,
  duration: 200000,
  downloadable: true,
  download_url: `https://api.soundcloud.com/tracks/soundcloud:tracks:${id}/download`,
  permalink_url: `https://soundcloud.com/testartist/${id}`,
  access,
});

test("a blocked track has no download control, says Blocked, and is not counted", async ({ page }) => {
  await mockApi(page);
  await page.route(
    (url) => url.pathname === "/api/playlists/1",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...FAKE_PLAYLIST_DETAIL,
          track_count: 2,
          tracks: [track(100, "Sample Track 1", "playable"), track(900, "Locked Away Track", "blocked")],
        }),
      }),
  );

  await page.goto("/downloads/");
  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();

  await expect(
    page.getByRole("button", { name: "Download Sample Track 1 (free download)" }),
  ).toBeVisible();

  // The row stays; its chip does not.
  const main = page.locator("main");
  await expect(main.getByText("Locked Away Track", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download Locked Away Track (free download)" }),
  ).toHaveCount(0);
  await expect(main.getByText("Blocked", { exact: true })).toBeVisible();

  // One downloadable, not two.
  await expect(main.getByText("(1 downloadable)")).toBeVisible();
  await expect(page.locator("#app-live-region")).toHaveText(/^1 downloadable track in /);

  // Still selectable for removal.
  await page.getByRole("button", { name: "Select to Remove" }).click();
  await expect(page.getByRole("checkbox", { name: "Locked Away Track" })).toBeVisible();
  await expect(main.getByText("Blocked", { exact: true })).toBeVisible();

  await page.mouse.move(0, 0);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a playlist whose only tracks are blocked and not downloadable keeps the empty state", async ({ page }) => {
  await mockApi(page);
  await page.route(
    (url) => url.pathname === "/api/playlists/1",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...FAKE_PLAYLIST_DETAIL,
          track_count: 1,
          tracks: [
            {
              ...track(900, "Locked Away Track", "blocked"),
              downloadable: false,
              download_url: undefined,
            },
          ],
        }),
      }),
  );

  await page.goto("/downloads/");
  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();

  await expect(page.getByText("No downloadable tracks found")).toBeVisible();
  await expect(page.locator("main").getByText("Locked Away Track")).toHaveCount(0);
});
