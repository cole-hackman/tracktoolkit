import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";

/**
 * Following Library, clone: a half-filled copy must be shown, not swallowed.
 * The server answers 207 (some copies done) or 502/500 (none done) with a
 * `partialPlaylists` list; the page links each one with its "N of M tracks"
 * count, shows the server's own text, and refreshes the cached playlist lists
 * after the outcome is on screen.
 */

const LONG = "A-very-long-partly-filled-copy-title-with-no-spaces-that-would-overflow-a-phone-";
const PARTIAL = {
  id: 91,
  title: `Clone of ${LONG}`,
  permalink_url: "https://soundcloud.com/me/sets/clone-partial",
  tracksWritten: 200,
  intendedTrackCount: 250,
  sourcePlaylistId: 400,
};
const PARTIAL_ERROR = {
  id: 400,
  partialPlaylistId: 91,
  error: "A copy was created but only partly filled (at least 200 of 250 tracks). Check it on SoundCloud.",
};

async function openAndClone(page: Page) {
  await page.goto("/following-library/");
  await page.getByRole("tab", { name: "Playlists", exact: true }).click();
  await page.getByRole("checkbox", { name: /Sample Public Playlist 1/ }).check();
  await page.getByRole("button", { name: "Clone Selected" }).click();
}

async function expectNoBlockingViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `scrollWidth=${scrollWidth} clientWidth=${clientWidth}`).toBeLessThanOrEqual(clientWidth);
}

for (const width of [1280, 360]) {
  test(`a 207 with partialPlaylists renders the link and the count, (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApi(page);
    await page.route(
      (url) => /^\/api\/followings\/\d+\/playlists\/clone$/.test(url.pathname),
      (route) =>
        route.fulfill({
          status: 207,
          contentType: "application/json",
          body: JSON.stringify({
            playlists: [{ id: 90, title: "Clone of Sample Public Playlist 2", permalink_url: "https://soundcloud.com/me/sets/ok", trackCount: 10, sourcePlaylistId: 401 }],
            partialPlaylists: [PARTIAL],
            errors: [PARTIAL_ERROR],
            stats: { numPlaylistsCreated: 1 },
          }),
        }),
    );

    await openAndClone(page);

    const link = page.getByRole("link", { name: /Open partly filled copy/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", PARTIAL.permalink_url);
    await expect(page.getByText(PARTIAL.title, { exact: true })).toBeVisible();
    await expect(page.getByText("at least 200 of 250 tracks", { exact: true })).toBeVisible();
    await expect(page.getByText("Cloned 1 playlist.")).toBeVisible();
    // The summary lives inside the panel; no second alert repeats it.
    await expect(page.getByText(/not all of them finished/)).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: /not all of them finished/ })).toHaveCount(0);
    await expect(page.getByText("Sample Public Playlist 1:")).toBeVisible();

    await expectNoBlockingViolations(page);
    await expectNoHorizontalOverflow(page);
  });

  test(`a 502 with partialPlaylists shows the server text plus the link (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApi(page);
    const MESSAGE = "Some copies may have been partly created — check your playlists before trying again.";
    await page.route(
      (url) => /^\/api\/followings\/\d+\/playlists\/clone$/.test(url.pathname),
      (route) =>
        route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({
            code: "SOUNDCLOUD_UNAVAILABLE",
            error: MESSAGE,
            errors: [PARTIAL_ERROR],
            partialPlaylists: [PARTIAL],
          }),
        }),
    );

    await openAndClone(page);

    await expect(page.getByText(MESSAGE, { exact: true })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: MESSAGE })).toHaveCount(0);
    const link = page.getByRole("link", { name: /Open partly filled copy/ });
    await expect(link).toHaveAttribute("href", PARTIAL.permalink_url);
    await expect(page.getByText("at least 200 of 250 tracks", { exact: true })).toBeVisible();
    await expectNoBlockingViolations(page);
    await expectNoHorizontalOverflow(page);
  });
}

test("a non-JSON 502 body falls back to the generic text and does not crash", async ({ page }) => {
  await mockApi(page);
  await page.route(
    (url) => /^\/api\/followings\/\d+\/playlists\/clone$/.test(url.pathname),
    (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad gateway</html>" }),
  );

  await openAndClone(page);

  await expect(page.getByRole("alert").filter({ hasText: "Failed to clone playlists" })).toBeVisible();
});

test("a 400 with only per-item errors lists each reason under its playlist's name", async ({ page }) => {
  await mockApi(page);
  await page.route(
    (url) => /^\/api\/followings\/\d+\/playlists\/clone$/.test(url.pathname),
    (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: "None of the selected playlists could be cloned.",
          errors: [{ id: 400, error: "This playlist no longer exists or is private." }],
        }),
      }),
  );

  await openAndClone(page);

  await expect(page.getByText("None of the selected playlists could be cloned.")).toBeVisible();
  await expect(page.getByText("Sample Public Playlist 1:")).toBeVisible();
  await expect(page.getByText("This playlist no longer exists or is private.")).toBeVisible();
  await expectNoBlockingViolations(page);
});
