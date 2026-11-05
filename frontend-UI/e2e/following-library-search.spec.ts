import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";

/**
 * Following Library: every list on the page can be searched, the search
 * covers everything loaded (not only the rows on screen), and a finished
 * run is the focused result region above the tool.
 */

const LIKES = Array.from({ length: 60 }, (_, i) => ({
  id: 900 + i,
  title: i === 41 ? "Deep Café Session" : `Public Like ${i + 1}`,
  user: { username: i % 2 === 0 ? "even artist" : "odd artist" },
  artwork_url: null,
  duration: 180000,
}));

const PLAYLISTS = Array.from({ length: 30 }, (_, i) => ({
  id: 700 + i,
  title: i === 22 ? "Sunrise Selects" : `Public Set ${i + 1}`,
  user: { username: "testfollowing1" },
  artwork_url: null,
  track_count: 5 + i,
}));

async function mockLibrary(page: import("@playwright/test").Page) {
  await mockApi(page);
  await page.route(
    (url) => /^\/api\/followings\/\d+\/likes\/paged$/.test(url.pathname),
    (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ collection: LIKES, next_href: null }) }),
  );
  await page.route(
    (url) => /^\/api\/followings\/\d+\/playlists\/paged$/.test(url.pathname),
    (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ collection: PLAYLISTS, next_href: null }) }),
  );
}

test("following-library: the rail search narrows the followings", async ({ page }) => {
  await mockApi(page);
  await page.goto("/following-library/");
  const search = page.getByRole("searchbox", { name: "Search followings" });
  await expect(page.getByText("3 followings")).toBeVisible();
  await search.fill("following2");
  await expect(page.getByText("Showing 1 of 3 followings")).toBeVisible();
  await expect(page.getByRole("button", { name: /testfollowing2/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /testfollowing3/ })).toHaveCount(0);
});

test("following-library: likes search covers every loaded track and select-all takes the matches", async ({ page }) => {
  await mockLibrary(page);
  await page.goto("/following-library/");

  const search = page.getByRole("searchbox", { name: "Search liked tracks" });
  await search.fill("cafe");
  await expect(page.getByText("Showing 1 of 60 tracks")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Deep Café Session" })).toBeVisible();

  await search.fill("odd artist");
  await expect(page.getByText("Showing 30 of 60 tracks")).toBeVisible();
  await page.getByRole("button", { name: "Select all 30 shown" }).click();
  await expect(page.getByText("30 tracks selected")).toBeVisible();

  await search.fill("");
  await expect(page.getByRole("checkbox", { name: "Public Like 2", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Public Like 1", exact: true })).not.toBeChecked();
});

test("following-library: playlists use the shared picker with search and select-all-shown", async ({ page }) => {
  await mockLibrary(page);
  await page.goto("/following-library/");
  await page.getByRole("tab", { name: "Playlists", exact: true }).click();

  const search = page.getByRole("searchbox", { name: "Search playlists" });
  await search.fill("sunrise");
  await expect(page.getByText("Showing 1 of 30 playlists")).toBeVisible();
  await page.getByRole("button", { name: "Select all 1 shown" }).click();
  await expect(page.getByText("1 playlist selected")).toBeVisible();

  await search.fill("");
  await expect(page.getByRole("checkbox", { name: "Sunrise Selects" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Public Set 1", exact: true })).not.toBeChecked();

  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});

test("following-library: a clean clone is a focused success region and the tool stays", async ({ page }) => {
  await mockApi(page);
  await page.route(
    (url) => /^\/api\/followings\/\d+\/playlists\/clone$/.test(url.pathname),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          playlists: [{ id: 90, title: "Clone of Sample Public Playlist 1", permalink_url: "https://soundcloud.com/me/sets/ok", trackCount: 9 }],
          stats: { numPlaylistsCreated: 1 },
        }),
      }),
  );
  await page.goto("/following-library/");
  await page.getByRole("tab", { name: "Playlists", exact: true }).click();
  await page.getByRole("checkbox", { name: /Sample Public Playlist 1/ }).check();
  await page.getByRole("button", { name: "Clone Selected" }).click();

  const result = page.getByRole("region", { name: "Done" });
  await expect(result).toBeFocused();
  await expect(result).toHaveAttribute("data-result-status", "success");
  await expect(result).toContainText("Selected playlists were cloned into your library.");
  await expect(result).toContainText("Cloned 1 playlist.");
  await expect(page.getByRole("tab", { name: "Playlists", exact: true })).toBeVisible();
});

test("following-library: saving likes to an existing playlist uses the playlist chooser", async ({ page }) => {
  await mockApi(page);
  let body: Record<string, unknown> | null = null;
  await page.route(
    (url) => /^\/api\/followings\/\d+\/likes\/playlist$/.test(url.pathname),
    async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ addedCount: 1, totalTracks: 1 }),
      });
    },
  );
  await page.goto("/following-library/");
  await page.getByRole("checkbox", { name: "Sample Public Track 1" }).check();
  await page.getByRole("button", { name: "Add to existing" }).click();
  await page.getByRole("button", { name: /Choose playlist…/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sample Playlist 3", exact: true }).click();
  await page.getByRole("button", { name: "Create from Selected" }).click();

  const result = page.getByRole("region", { name: "Done" });
  await expect(result).toContainText("Tracks added to your playlist.");
  await expect(result).toContainText("Added 1 track to your playlist.");
  expect(body).toMatchObject({ mode: "selected", trackIds: [300], targetPlaylistId: expect.any(Number) });
});
