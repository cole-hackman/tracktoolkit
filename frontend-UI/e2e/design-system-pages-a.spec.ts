import { test, expect } from "@playwright/test";
import { mockApi } from "./fixtures/api";

/**
 * Result pattern of docs/internal/DESIGN-SYSTEM.md on the scan and form tools:
 * the outcome of a run is a result region in the slot under the page header,
 * focused when it appears, and the tool stays on screen to run again.
 */

test("library-audit: a run reports in a focused result region above the tool", async ({ page }) => {
  await mockApi(page);
  await page.goto("/library-audit/");
  await page.getByRole("button", { name: "Run playlist audit" }).click();

  const result = page.getByRole("region", { name: "Audit complete" });
  await expect(result).toBeFocused();
  await expect(result).toContainText("Audited playlists");
  await expect(page.getByRole("heading", { name: "Playlist findings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart from the top" })).toBeVisible();
});

test("library-audit: a failed run is an error result", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/library/audit*", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Audit blew up" }) }),
  );
  await page.goto("/library-audit/");
  await page.getByRole("button", { name: "Run playlist audit" }).click();

  const result = page.getByRole("region", { name: "Audit failed" });
  await expect(result).toBeFocused();
  await expect(result).toContainText("Audit blew up");
  await expect(page.getByRole("button", { name: "Run playlist audit" })).toBeEnabled();
});

test("link-resolver: a failed resolve is an error result above the form", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/resolve?*", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Nothing found at that link" }) }),
  );
  await page.goto("/link-resolver/");
  await page.getByLabel("SoundCloud URL").fill("https://soundcloud.com/nobody/nothing");
  await page.getByRole("button", { name: "Resolve" }).click();

  const result = page.getByRole("region", { name: "Could not resolve link" });
  await expect(result).toBeFocused();
  await expect(result).toContainText("Nothing found at that link");
  await expect(page.getByLabel("SoundCloud URL")).toBeVisible();
});

test("playlist-cloner: the clone result is a focused region and the forms stay", async ({ page }) => {
  await mockApi(page);
  await page.goto("/playlist-cloner/");
  await page.getByLabel("Original playlist URL").fill("https://soundcloud.com/testuser/sets/sample-playlist-1");
  await page.getByRole("button", { name: "Clone Playlist" }).click();

  const result = page.getByRole("region", { name: "Cloning Complete" });
  await expect(result).toBeFocused();
  await expect(result).toContainText("into 2 playlists");
  await expect(result.getByText("Parts Created")).toBeVisible();
  await expect(page.getByLabel("Original playlist URL")).toBeVisible();
  await expect(page.getByRole("button", { name: "Clone Likes" })).toBeVisible();
});

test("playlist-cloner: a failed clone is an error result", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/playlists/clone", (route) =>
    route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "That playlist is not reachable" }) }),
  );
  await page.goto("/playlist-cloner/");
  await page.getByLabel("Original playlist URL").fill("https://soundcloud.com/a/sets/b");
  await page.getByRole("button", { name: "Clone Playlist" }).click();

  const result = page.getByRole("region", { name: "Could not clone" });
  await expect(result).toBeFocused();
  await expect(result).toContainText("That playlist is not reachable");
});

test("batch-link-resolver: the run is a partial result and the search covers the rows", async ({ page }) => {
  await mockApi(page);
  await page.goto("/batch-link-resolver/");
  await page.getByLabel("SoundCloud URLs (one per line)").fill("https://soundcloud.com/testartist/sample-track-1");
  await page.getByRole("button", { name: "Resolve All" }).click();

  const result = page.getByRole("region", { name: "Links partly resolved" });
  await expect(result).toBeFocused();
  await expect(result).toContainText("2 resolved, 1 failed, of 3.");
  await expect(page.getByRole("heading", { name: "Results" })).toBeVisible();

  await expect(page.getByText("3 links", { exact: true })).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Search results" });
  await search.fill("playlist 1");
  await expect(page.getByText("Showing 1 of 3 links")).toBeVisible();
  await expect(page.getByText("Sample Track 1")).toHaveCount(0);
  // The failed row is found by the text of its URL ("…/does-not-exist").
  await search.fill("does-not-exist");
  await expect(page.getByText("Showing 1 of 3 links")).toBeVisible();
  await expect(page.getByText("Not found")).toBeVisible();
  await search.fill("zzz nothing matches this");
  await expect(page.getByText("Showing 0 of 3 links")).toBeVisible();
});

test("playlist-cloner: dismissing a partial clone does not turn it into a failure", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/playlists/clone", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        code: "CLONE_PARTIAL",
        error: "SoundCloud stopped answering after part 1.",
        playlists: [{ id: 41, title: "Copy (1/2)", permalink_url: "https://soundcloud.com/testuser/sets/copy-1", trackCount: 500 }],
        stats: { partial: true },
      }),
    }),
  );
  await page.goto("/playlist-cloner/");
  await page.getByLabel("Original playlist URL").fill("https://soundcloud.com/a/sets/b");
  await page.getByRole("button", { name: "Clone Playlist" }).click();

  const partial = page.getByRole("region", { name: "Partly cloned" });
  await expect(partial).toBeFocused();
  await expect(partial).toContainText("SoundCloud stopped answering after part 1.");
  await expect(page.getByRole("region", { name: "Could not clone" })).toHaveCount(0);

  await partial.getByRole("button", { name: "Dismiss result" }).click();
  await expect(partial).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Could not clone" })).toHaveCount(0);
});

test("batch-link-resolver: over 50 links is refused on the field, a failed request is an error result", async ({ page }) => {
  await mockApi(page);
  await page.goto("/batch-link-resolver/");
  const links = Array.from({ length: 51 }, (_, i) => `https://soundcloud.com/a/t-${i}`).join("\n");
  await page.getByLabel("SoundCloud URLs (one per line)").fill(links);
  await page.getByRole("button", { name: "Resolve All" }).click();
  await expect(page.getByText("Maximum 50 URLs at a time")).toBeVisible();
  await expect(page.getByRole("region", { name: "Could not resolve links" })).toHaveCount(0);

  await page.route("**/api/resolve/batch*", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Batch is down" }) }),
  );
  await page.getByLabel("SoundCloud URLs (one per line)").fill("https://soundcloud.com/a/t-1");
  await page.getByRole("button", { name: "Resolve All" }).click();
  const result = page.getByRole("region", { name: "Could not resolve links" });
  await expect(result).toBeFocused();
  await expect(result).toContainText("Batch is down");
});

test("set-to-playlist: a create that fails is an error result and the review stays", async ({ page }) => {
  await mockApi(page);
  await page.route((url) => url.pathname === "/api/setlists/match", (route) => {
    const { entries } = route.request().postDataJSON() as { entries: Array<{ position: number }> };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results: entries.map((e) => ({
          position: e.position,
          candidates: [
            { id: 9000 + e.position, title: "House Breaker", user: { username: "Calyx" }, duration: 200000, access: "playable", permalink_url: null, artwork_url: null },
          ],
        })),
      }),
    });
  });
  await page.route((url) => url.pathname === "/api/setlists/playlist", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "SoundCloud said no" }) }),
  );
  await page.goto("/set-to-playlist/");
  await page.getByRole("textbox", { name: "Tracklist", exact: true }).fill("Calyx - House Breaker");
  await page.getByLabel("Playlist name").fill("My set");
  await page.getByRole("button", { name: "Find on SoundCloud" }).click();
  await page.getByRole("button", { name: "Create playlist with 1 track" }).click();

  const result = page.getByRole("region", { name: "Playlist not created" });
  await expect(result).toBeFocused();
  await expect(result).toContainText("SoundCloud said no");
  await expect(page.getByRole("heading", { name: "Review the matches" })).toBeVisible();
});
