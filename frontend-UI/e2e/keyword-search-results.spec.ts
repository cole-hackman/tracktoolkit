import { test, expect } from "@playwright/test";
import { mockApi } from "./fixtures/api";
test("keyword search: copy and a partial remove land in the result region", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/playlists/tracks/bulk-remove", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        removedTotal: 1,
        results: [
          { playlistId: 1, status: "success", removed: 1 },
          { playlistId: 2, status: "error", removed: 0, error: "SoundCloud returned 6 of 8 tracks" },
        ],
      }),
    }),
  );
  await page.route("**/api/playlists/tracks/bulk-add", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ added: 2, alreadyPresent: 1, targetTitle: "Sample Playlist 2" }),
    }),
  );
  await page.goto("/playlist-keyword-search/");
  await page.getByLabel("Keywords").fill("x");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel("Keywords").fill("sample");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("heading", { name: "Matches" }).waitFor();
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: /^Copy selected tracks to/ }).click();
  await page.getByRole("radio").nth(1).click();
  await page.getByRole("button", { name: /^Copy \d/ }).click();
  await expect(page.getByRole("region", { name: "Tracks copied" })).toBeFocused();
  await page.getByRole("button", { name: /^Remove \d/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  const partial = page.getByRole("region", { name: "Some playlists were not updated" });
  await expect(partial).toBeFocused();
  await expect(partial).toContainText("1 playlist could not be updated");
  await expect(partial).toContainText("SoundCloud returned 6 of 8 tracks");
});
