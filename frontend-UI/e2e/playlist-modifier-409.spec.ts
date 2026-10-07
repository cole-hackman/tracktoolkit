import { test, expect } from "@playwright/test";
import { mockApi } from "./fixtures/api";

/**
 * A 409 on the modifier's save means two different things. OUT_OF_SYNC reloads
 * the list (unsaved edits are gone) and says so; READ_INCOMPLETE reloads
 * nothing, so the user's edits stay and the server's own reason is shown.
 */
test("a PLAYLIST_READ_INCOMPLETE 409 shows the server text and does not claim a reload", async ({ page }) => {
  await mockApi(page);
  const reason =
    "SoundCloud returned only 4 of the 5 tracks in this playlist (some may be deleted or private). Nothing was changed, because writing back a partial list would delete the missing tracks.";
  await page.route(
    (url) => url.pathname === "/api/playlists/1",
    async (route) => {
      if (route.request().method() === "PUT") {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ code: "PLAYLIST_READ_INCOMPLETE", error: reason, seen: 4, expected: 5 }),
        });
      }
      return route.fallback();
    },
  );

  await page.goto("/playlist-modifier/");
  await page.getByRole("button", { name: "Sample Playlist 1" }).click();
  await page.getByRole("group", { name: "Filter tracks" }).waitFor();

  await page.getByRole("button", { name: "Save Changes" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Save Changes" }).click();

  await expect(page.getByRole("alert").filter({ hasText: reason })).toBeVisible();
  await expect(page.getByText(/has been reloaded/)).toHaveCount(0);
});
