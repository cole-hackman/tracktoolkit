import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";

/**
 * Follow-ups to combine-not-found.spec.ts. Compare answers 404
 * PLAYLIST_NOT_FOUND and from-likes answers 409 PLAYLIST_NOT_FOUND when a
 * playlist the page was still offering is gone from SoundCloud. Each page must
 * show the server's text, drop the missing selection and refetch the list.
 */

const COMPARE_REASON =
  "One of these playlists no longer exists on SoundCloud. Your playlist list has been refreshed — pick again.";
const TARGET_REASON =
  "The playlist you chose no longer exists on SoundCloud. Your playlist list has been refreshed — pick again. Nothing was changed.";

test("compare: a 404 PLAYLIST_NOT_FOUND shows the server text, clears the selection and refetches the list", async ({
  page,
}) => {
  await mockApi(page);

  let listGets = 0;
  let compared = false;
  await page.route(
    (url) => url.pathname === "/api/playlists",
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      listGets += 1;
      if (!compared) return route.fallback();
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
    (url) => url.pathname === "/api/playlists/compare",
    (route) => {
      compared = true;
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ code: "PLAYLIST_NOT_FOUND", playlistId: 2, error: COMPARE_REASON }),
      });
    },
  );

  await page.goto("/playlist-compare/");
  const a = page.getByLabel("Playlist A");
  const b = page.getByLabel("Playlist B");
  await expect(a.locator("option", { hasText: "Sample Playlist 2" })).toHaveCount(1);
  await a.selectOption("1");
  await b.selectOption("2");

  const before = listGets;
  await page.getByRole("button", { name: "Compare" }).click();

  await expect(page.getByRole("alert").filter({ hasText: COMPARE_REASON })).toBeVisible();
  // Playlist B was the missing one: it is cleared and gone from the refetched
  // list; Playlist A is untouched.
  await expect.poll(() => listGets).toBeGreaterThan(before);
  await expect(b.locator("option", { hasText: "Sample Playlist 2" })).toHaveCount(0);
  await expect(b).toHaveValue("");
  await expect(a).toHaveValue("1");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});

test("likes-to-playlist: a 409 PLAYLIST_NOT_FOUND clears the target and shows the server text", async ({
  page,
}) => {
  await mockApi(page);
  await page.route(
    (url) => url.pathname === "/api/playlists/from-likes",
    (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ code: "PLAYLIST_NOT_FOUND", playlistId: 3, error: TARGET_REASON }),
      }),
  );

  await page.goto("/likes-to-playlist/");
  await page.getByRole("checkbox", { name: "Sample Track 1" }).check();
  await page.getByRole("button", { name: "Existing playlist" }).click();
  await page.getByRole("button", { name: "Choose a playlist…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Sample Playlist 3/ }).click();
  await expect(page.getByRole("button", { name: /Change/ })).toBeVisible();

  await page.getByRole("button", { name: "Add to Playlist" }).last().click();

  await expect(page.getByRole("alert").filter({ hasText: TARGET_REASON })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose a playlist…" })).toBeVisible();
});
