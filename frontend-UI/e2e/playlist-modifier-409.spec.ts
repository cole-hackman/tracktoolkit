import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "./fixtures/api";

/**
 * A 409 on the modifier's save means two different things. OUT_OF_SYNC reloads
 * the list (unsaved edits are gone) and says so; READ_INCOMPLETE reloads
 * nothing, so the user's edits stay and the server's own reason is shown.
 *
 * Desktop only: the per-row "Remove from playlist" control is `sm:` and up.
 */

const FIRST_TRACK = "Sample Playlist Track 1";

async function setUp(
  page: Page,
  putBody: unknown,
): Promise<{ events: string[] }> {
  await mockApi(page);
  const events: string[] = [];
  await page.route(
    (url) => url.pathname === "/api/playlists/1",
    async (route) => {
      const method = route.request().method();
      events.push(method);
      if (method === "PUT") {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify(putBody),
        });
      }
      return route.fallback();
    },
  );

  await page.goto("/playlist-modifier/");
  await page.getByRole("button", { name: "Sample Playlist 1" }).click();
  await page.getByRole("group", { name: "Filter tracks" }).waitFor();

  // An unsaved edit: take the first track out.
  await expect(page.getByText(FIRST_TRACK, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove from playlist" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText(FIRST_TRACK, { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Save Changes" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Save Changes" }).click();
  return { events };
}

test("a PLAYLIST_READ_INCOMPLETE 409 shows the server text, keeps the edit, and does not reload", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "row remove control is sm: and up");
  const reason =
    "SoundCloud returned only 4 of the 5 tracks in this playlist (some may be deleted or private). Nothing was changed, because writing back a partial list would delete the missing tracks.";
  const { events } = await setUp(page, {
    code: "PLAYLIST_READ_INCOMPLETE",
    error: reason,
    seen: 4,
    expected: 5,
  });

  await expect(page.getByRole("alert").filter({ hasText: reason })).toBeVisible();
  await expect(page.getByText(/has been reloaded/)).toHaveCount(0);

  // The edit is still there, and nothing was fetched after the PUT.
  await expect(page.getByText(FIRST_TRACK, { exact: true })).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(events.slice(events.indexOf("PUT") + 1)).toEqual([]);
});

test("a PLAYLIST_OUT_OF_SYNC 409 reloads the list and says the edits were dropped", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "row remove control is sm: and up");
  const { events } = await setUp(page, {
    code: "PLAYLIST_OUT_OF_SYNC",
    error: "This playlist has 1 track this page didn't load.",
    undeclared: 1,
  });

  await expect(
    page.getByRole("alert").filter({ hasText: "has been reloaded. Your edits were not saved" }),
  ).toBeVisible();

  // Reloaded: the removed track is back, matching the server's list.
  await expect(page.getByText(FIRST_TRACK, { exact: true })).toBeVisible();
  expect(events.slice(events.indexOf("PUT") + 1)).toContain("GET");
});
