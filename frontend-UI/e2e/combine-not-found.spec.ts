import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";

/**
 * A merge can name a playlist SoundCloud no longer has (the cached list was
 * stale). The server answers 409 PLAYLIST_NOT_FOUND; the page must show the
 * server's text, refetch the list, and deselect the missing playlist.
 */

const REASON =
  "One of the selected playlists no longer exists on SoundCloud. Your playlist list has been refreshed — pick again. Nothing was changed.";

test("combine: a 409 PLAYLIST_NOT_FOUND shows the server text, refetches the list and deselects the playlist", async ({
  page,
}) => {
  await mockApi(page);

  let listGets = 0;
  let merged = false;
  await page.route(
    (url) => url.pathname === "/api/playlists",
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      listGets += 1;
      if (!merged) return route.fallback();
      // After the 409 the server's list no longer carries playlist 2.
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          collection: [
            { id: 1, title: "Sample Playlist 1", track_count: 12, artwork_url: null },
            { id: 3, title: "Sample Playlist 3", track_count: 7, artwork_url: null },
          ],
          total: 2,
        }),
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/playlists/merge",
    async (route) => {
      merged = true;
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ code: "PLAYLIST_NOT_FOUND", playlistId: 2, error: REASON }),
      });
    },
  );

  await page.goto("/combine/");
  await page.getByRole("checkbox", { name: "Sample Playlist 1" }).check();
  await page.getByRole("checkbox", { name: "Sample Playlist 2" }).check();
  await page.getByLabel("New Playlist Name").fill("Merged mix");
  await expect(page.getByRole("button", { name: "Remove Sample Playlist 2" })).toBeVisible();

  const before = listGets;
  await page.getByRole("button", { name: "Merge Playlists" }).click();

  await expect(page.getByRole("alert").filter({ hasText: REASON })).toBeVisible();

  // The list was refetched, the missing playlist is gone from it, and it is
  // no longer selected; the other selection is untouched.
  await expect.poll(() => listGets).toBeGreaterThan(before);
  await expect(page.getByRole("checkbox", { name: "Sample Playlist 2" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove Sample Playlist 2" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove Sample Playlist 1" })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});
