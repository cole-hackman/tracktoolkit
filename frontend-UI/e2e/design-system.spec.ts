import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";

/**
 * The shared pieces of docs/internal/DESIGN-SYSTEM.md, exercised on the pages
 * that use them:
 *
 * - the playlist picker's search covers the whole list (not only what is
 *   on screen), keeps a selection across a query, and says how many match;
 * - a run's outcome is the shared result panel: in the slot above the tool,
 *   focused, spoken through the app's live region, with the tool still on
 *   screen to run again.
 */

const MANY_PLAYLISTS = Array.from({ length: 60 }, (_, i) => ({
  id: 100 + i,
  // Two in sixty mention "Night", and one sits far past the first screenful.
  title: i === 2 ? "Night Drive" : i === 57 ? "Late Night Edits" : `Playlist ${i + 1}`,
  track_count: 10 + i,
  artwork_url: null,
}));

async function serveManyPlaylists(page: Page) {
  await page.route(
    (url) => url.pathname === "/api/playlists",
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ collection: MANY_PLAYLISTS, total: MANY_PLAYLISTS.length }),
          })
        : route.fallback(),
  );
}

async function expectNoBlockingViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

test("combine: the playlist search covers the full list and keeps the selection", async ({ page }) => {
  await mockApi(page);
  await serveManyPlaylists(page);
  await page.goto("/combine/");

  const search = page.getByRole("searchbox", { name: "Search your playlists" });
  await expect(search).toBeVisible();
  await expect(page.getByText("60 playlists", { exact: true })).toBeVisible();

  // Selected before the search…
  await page.getByRole("checkbox", { name: "Playlist 1", exact: true }).check();

  await search.fill("night");
  await expect(page.getByText("Showing 2 of 60 playlists")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Night Drive" })).toBeVisible();
  // …the 58th playlist is found though it was never scrolled to.
  await expect(page.getByRole("checkbox", { name: "Late Night Edits" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Playlist 1", exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Late Night Edits" }).check();

  // Case and accents do not matter, and every word has to match.
  await search.fill("LATE nîght");
  await expect(page.getByText("Showing 1 of 60 playlists")).toBeVisible();

  await search.fill("nothing like this");
  await expect(page.getByText("No playlists match your search")).toBeVisible();

  // …and still selected after it, alongside the one picked from the results.
  await search.fill("");
  await expect(page.getByRole("checkbox", { name: "Playlist 1", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "Remove Playlist 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Late Night Edits" })).toBeVisible();

  await expectNoBlockingViolations(page);
});

test("combine: a successful merge shows the result above the tool, focused and announced", async ({ page }) => {
  await mockApi(page);
  await page.route(
    (url) => url.pathname === "/api/playlists/merge",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          playlist: { title: "Merged mix" },
          stats: { totalTracks: 52 },
        }),
      }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/combine/");

  await page.getByRole("checkbox", { name: "Sample Playlist 1" }).check();
  await page.getByRole("checkbox", { name: "Sample Playlist 2" }).check();
  await page.getByLabel("New Playlist Name").fill("Merged mix");
  await page.getByRole("button", { name: "Merge Playlists" }).click();

  const result = page.getByRole("region", { name: "Playlist Created!" });
  await expect(result).toBeVisible();
  await expect(result).toBeFocused();
  await expect(result).toHaveAttribute("data-result-status", "success");
  await expect(result).toContainText('"Merged mix" has been created with 52 tracks (duplicates removed).');
  await expect(page.locator("#app-live-region")).toHaveText("Merged: 1 playlist created with 52 tracks.");

  // The result sits above the tool, and the tool is still there, reset for
  // the next merge.
  const merge = page.getByRole("button", { name: "Merge Playlists" });
  await expect(merge).toBeVisible();
  const resultBox = await result.boundingBox();
  const listBox = await page.getByRole("region", { name: "Your Playlists" }).boundingBox();
  expect(resultBox && listBox && resultBox.y < listBox.y).toBe(true);
  await expect(page.getByRole("checkbox", { name: "Sample Playlist 1" })).not.toBeChecked();
  await expect(page.getByLabel("New Playlist Name")).toHaveValue("");

  await expectNoBlockingViolations(page);

  // Dismissing it leaves the tool exactly as it was.
  await result.getByRole("button", { name: "Dismiss result" }).click();
  await expect(result).toHaveCount(0);
  await expect(merge).toBeVisible();
});

test("combine: a failed delete after merge is a partial result listing each failure", async ({ page }) => {
  await mockApi(page);
  await page.route(
    (url) => url.pathname === "/api/playlists/merge",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          playlists: [{ title: "Sample Playlist 3" }],
          stats: { addedCount: 9 },
          deletedPlaylistIds: [1],
          deleteErrors: [{ id: 2, error: "Forbidden" }],
        }),
      }),
  );
  await page.goto("/combine/");

  await page.getByRole("checkbox", { name: "Sample Playlist 1" }).check();
  await page.getByRole("checkbox", { name: "Sample Playlist 2" }).check();
  await page.getByRole("button", { name: "Existing playlist" }).click();
  await page.getByRole("button", { name: "Choose a target playlist…" }).click();
  await page.getByRole("dialog").getByRole("radio", { name: /Sample Playlist 3/ }).click();
  await page.getByText("Delete source playlists after merge").click();
  await page.getByRole("button", { name: "Merge Playlists" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Merge & Delete" }).click();

  const result = page.getByRole("region", { name: "Playlist Updated!" });
  await expect(result).toBeFocused();
  await expect(result).toHaveAttribute("data-result-status", "partial");
  await expect(result).toContainText('Added 9 new tracks to "Sample Playlist 3".');
  await expect(result).toContainText("1 source playlist deleted");
  await expect(result).toContainText("1 playlist could not be deleted");
  await expect(result).toContainText("ID 2: Forbidden");
});

test("likes-to-playlist: search filters every like, select-all takes only the matches", async ({ page }) => {
  await mockApi(page);
  const likes = Array.from({ length: 80 }, (_, i) => ({
    id: 500 + i,
    title: i === 71 ? "Deep Café Session" : `Liked Track ${i + 1}`,
    user: { username: i % 2 === 0 ? "even artist" : "odd artist" },
    artwork_url: null,
    duration: 180000,
  }));
  await page.route(
    (url) => url.pathname === "/api/likes",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ collection: likes, total: likes.length }),
      }),
  );
  await page.goto("/likes-to-playlist/");

  const search = page.getByRole("searchbox", { name: "Search your liked tracks" });
  // Matches on the artist as well as the title, and ignores accents.
  await search.fill("cafe");
  await expect(page.getByText("Showing 1 of 80 tracks")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Deep Café Session" })).toBeVisible();

  await search.fill("odd artist");
  await expect(page.getByText("Showing 40 of 80 tracks")).toBeVisible();
  await page.getByRole("button", { name: "Select all 40 shown" }).click();
  await expect(page.getByText("40", { exact: true })).toBeVisible();

  await search.fill("");
  await expect(page.getByRole("checkbox", { name: "Liked Track 2", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Liked Track 1", exact: true })).not.toBeChecked();
  await expectNoBlockingViolations(page);
});

test("likes-to-playlist: creating a playlist keeps the tool and focuses the result", async ({ page }) => {
  await mockApi(page);
  await page.goto("/likes-to-playlist/");
  await page.getByRole("checkbox", { name: "Sample Track 1" }).check();
  await page.getByLabel("Playlist name").fill("From my likes");
  await page.getByRole("button", { name: "Create Playlist" }).last().click();

  const result = page.getByRole("region", { name: "Playlist Created!" });
  await expect(result).toBeFocused();
  await expect(result).toContainText('"From my likes" has been created with 1 tracks.');
  await expect(result.getByRole("link", { name: "Open in SoundCloud" })).toHaveAttribute(
    "href",
    "https://soundcloud.com/testuser/sets/sample-playlist-9",
  );
  await expect(page.locator("#app-live-region")).toHaveText("Playlist created");
  await expect(page.getByRole("searchbox", { name: "Search your liked tracks" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Sample Track 1" })).not.toBeChecked();
});

test("like-manager: search is accent-insensitive and a partly failed unlike is a partial result", async ({ page }) => {
  await mockApi(page);
  await page.route(
    (url) => url.pathname === "/api/likes/tracks/bulk-unlike",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          results: [
            { trackId: 100, status: "ok" },
            { trackId: 101, status: "error", error: "Forbidden" },
          ],
        }),
      }),
  );
  await page.goto("/like-manager/");

  const search = page.getByRole("searchbox", { name: /search/i });
  // Every word must match, in any order, across title and artist.
  await search.fill("testartist track 1");
  await expect(page.getByRole("checkbox", { name: "Sample Track 1" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Sample Track 2" })).toHaveCount(0);
  await search.fill("");

  await page.getByRole("checkbox", { name: "Sample Track 1" }).check();
  await page.getByRole("checkbox", { name: "Sample Track 2" }).check();
  await page.getByRole("button", { name: "Unlike Selected" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Unlike", exact: true }).click();

  const result = page.getByRole("region", { name: "Some tracks could not be unliked" });
  await expect(result).toBeFocused();
  await expect(result).toHaveAttribute("data-result-status", "partial");
  await expect(result).toContainText("Unliked 1 of 2 tracks. Some tracks could not be removed.");
  await expectNoBlockingViolations(page);
});
