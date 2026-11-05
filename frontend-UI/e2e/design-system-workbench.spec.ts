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
