import { test, expect } from "@playwright/test";
import { mockApi } from "./fixtures/api";

/**
 * Workbench pages migrated to the shared search, picker and result pieces
 * (docs/internal/DESIGN-SYSTEM.md): playlist-modifier, playlist-to-likes,
 * activity-to-playlist, recently-played.
 */

test("playlist-modifier: the track search covers the whole playlist and the picker stays", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/playlist-modifier/");
  await page.getByRole("radio", { name: "Sample Playlist 1", exact: true }).check();

  const search = page.getByRole("searchbox", { name: "Search this playlist's tracks" });
  await expect(search).toBeVisible();
  await expect(page.getByText("6 tracks", { exact: true })).toBeVisible();

  await search.fill("track 2");
  await expect(page.getByText("Showing 2 of 6 tracks")).toBeVisible();
  await expect(page.getByText("Sample Playlist Track 2", { exact: true })).toBeVisible();
  await expect(page.getByText("Sample Playlist Track 1", { exact: true })).toHaveCount(0);

  await search.fill("zzzz");
  await expect(page.getByText("No tracks match your search")).toBeVisible();

  // The picker is still on screen: switching playlist is one click.
  await expect(page.getByRole("radio", { name: "Sample Playlist 2", exact: true })).toBeVisible();
});

test("playlist-to-likes: search over the tracks, select-all acts on the matches", async ({ page }) => {
  await mockApi(page);
  await page.goto("/playlist-to-likes/");
  await page.getByRole("radio", { name: "Sample Playlist 1", exact: true }).click();

  const search = page.getByRole("searchbox", { name: "Search this playlist's tracks" });
  await expect(page.getByRole("button", { name: /^Like 6 Tracks$/ })).toBeVisible();

  await search.fill("track 2");
  await expect(page.getByText("Showing 2 of 6 tracks")).toBeVisible();
  // Everything starts selected; deselect the matches, then select them again.
  await page.getByRole("button", { name: "Deselect shown" }).click();
  await expect(page.getByRole("button", { name: /^Like 4 Tracks$/ })).toBeVisible();
  await page.getByRole("button", { name: "Select all 2 shown" }).click();
  await expect(page.getByRole("button", { name: /^Like 6 Tracks$/ })).toBeVisible();
});

test("playlist-to-likes: a finished run is a result panel above the tool", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/likes/tracks/bulk-like", (route) => {
    const { trackIds } = route.request().postDataJSON() as { trackIds: number[] };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: trackIds.map((trackId) => ({ trackId, status: "ok" })) }),
    });
  });
  await page.goto("/playlist-to-likes/");
  await page.getByRole("radio", { name: "Sample Playlist 1", exact: true }).click();
  await page.getByRole("button", { name: /^Like 6 Tracks$/ }).click();

  const result = page.getByRole("region", { name: "Tracks Liked!" });
  await expect(result).toBeFocused();
  // The tool stays on screen to run again.
  await expect(page.getByRole("button", { name: /^Like 6 Tracks$/ })).toBeVisible();
});
