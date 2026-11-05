import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "./fixtures/api";

/**
 * /playlist-to-likes/ when SoundCloud's like limit is hit, or a bulk like is
 * already running on the account. Both used to end in a success screen or a
 * generic failure; the server now says which, and the page has to say so too.
 */

async function openPlaylistAndLike(page: Page) {
  await page.goto("/playlist-to-likes/");
  await page.getByRole("button", { name: "Sample Playlist 1", exact: true }).click();
  const like = page.getByRole("button", { name: /^Like \d+ Tracks?$/ });
  await expect(like).toBeEnabled();
  await like.click();
}

test.describe("playlist to likes — server refusals", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      !["desktop", "m360"].includes(testInfo.project.name),
      "runs at desktop and the narrowest phone",
    );
    await mockApi(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("a rate-limited batch stops the run and says how far it got", async ({ page }) => {
    let calls = 0;
    // Registered after mockApi, so it takes precedence for this path.
    await page.route("**/api/likes/tracks/bulk-like", async (route) => {
      calls += 1;
      const { trackIds } = route.request().postDataJSON() as { trackIds: number[] };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          rateLimited: true,
          results: trackIds.map((trackId, i) =>
            i === 0
              ? { trackId, status: "ok" }
              : i === 1
                ? { trackId, status: "error", error: "API request failed: 429" }
                : { trackId, status: "skipped" },
          ),
        }),
      });
    });

    await openPlaylistAndLike(page);

    const result = page.getByRole("region", { name: "Likes stopped early" });
    await expect(result).toContainText("SoundCloud is limiting likes");
    await expect(result).toContainText(/Liked 1 of \d+ tracks/);
    await expect(result).toBeFocused();
    await expect(page.getByRole("heading", { name: "Tracks Liked!" })).toHaveCount(0);
    expect(calls).toBe(1);
  });

  test("a 409 shows the server's reason", async ({ page }) => {
    await page.route("**/api/likes/tracks/bulk-like", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "A bulk like is already running for your account. Wait for it to finish.",
        }),
      }),
    );

    await openPlaylistAndLike(page);

    const result = page.getByRole("region", { name: "Couldn't like the tracks" });
    await expect(result).toContainText("already running for your account");
    await expect(result).toBeFocused();
  });
});
