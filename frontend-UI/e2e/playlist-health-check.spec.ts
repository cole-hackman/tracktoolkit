import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi, FAKE_PLAYLIST_DETAIL } from "./fixtures/api";

/**
 * The health check reads the playlist with `?access=all` so blocked tracks —
 * which SoundCloud's default read leaves out — show up and can be removed, and
 * it declares every removal in the PUT so the server will let them go.
 *
 * `mockApi` already serves a playlist with one preview-only (id 301) and one
 * blocked (id 302) track. These tests layer their own `/api/playlists/1`
 * route on top to see exactly what the page asks for and sends.
 */

const UNHEALTHY_IDS = [301, 302];

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

interface Seen {
  getUrls: string[];
  putBodies: Array<{ tracks: number[]; remove?: number[] }>;
}

/**
 * Wraps `/api/playlists/1`: records every request, answers GET from the
 * shared fixture (optionally claiming more tracks than it returns), and
 * answers PUT with whatever `put` says.
 */
async function trackPlaylistRoute(
  page: Page,
  opts: {
    trackCount?: number;
    put?: { status: number; body: unknown };
  } = {},
): Promise<Seen> {
  const seen: Seen = { getUrls: [], putBodies: [] };

  await page.route(
    (url) => url.pathname === "/api/playlists/1",
    async (route) => {
      const request = route.request();
      if (request.method() === "PUT") {
        seen.putBodies.push(request.postDataJSON());
        const put = opts.put ?? { status: 200, body: { id: 1, title: "Sample Playlist 1" } };
        return route.fulfill(json(put.body, put.status));
      }
      seen.getUrls.push(request.url());
      return route.fulfill(
        json({
          ...FAKE_PLAYLIST_DETAIL,
          ...(opts.trackCount ? { track_count: opts.trackCount } : {}),
        }),
      );
    },
  );
  return seen;
}

async function openHealthCheck(page: Page) {
  await page.goto("/playlist-health-check/");
  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();
  await page.getByRole("group", { name: "Filter tracks" }).waitFor();
}

test.describe("playlist health check: blocked tracks", () => {
  test("reads with access=all, shows the blocked row, and declares the removals", async ({ page }) => {
    await mockApi(page);
    const seen = await trackPlaylistRoute(page);

    await openHealthCheck(page);

    expect(seen.getUrls.some((u) => new URL(u).searchParams.get("access") === "all")).toBe(true);

    // The row for the blocked track (id 302, "Sample Playlist Track 3").
    const blockedRow = page.locator("main").getByText("Sample Playlist Track 3", { exact: true });
    await expect(blockedRow).toBeVisible();
    await expect(page.locator("main").getByText("Blocked", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /Remove 2 Dead Tracks/ }).click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();

    await expect(page.getByText("Removed 2 unavailable tracks.").first()).toBeVisible();
    await expect(page.locator("#app-live-region")).toHaveText(
      "Removed 2 unavailable tracks. 4 of 4 tracks healthy — Healthy.",
    );

    expect(seen.putBodies).toHaveLength(1);
    const [put] = seen.putBodies;
    expect([...(put.remove ?? [])].sort()).toEqual(UNHEALTHY_IDS);
    expect(put.tracks).not.toContain(301);
    expect(put.tracks).not.toContain(302);
    expect(put.tracks).toHaveLength(4);
  });

  test("a 409 from the server shows its own text in the alert", async ({ page }) => {
    await mockApi(page);
    const reason =
      "This playlist has 1 track this page didn't load (it may have changed on SoundCloud). Reload and try again. Nothing was changed.";
    await trackPlaylistRoute(page, {
      put: { status: 409, body: { code: "PLAYLIST_OUT_OF_SYNC", error: reason, undeclared: 1 } },
    });

    await openHealthCheck(page);
    await page.getByRole("button", { name: /Remove 2 Dead Tracks/ }).click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();

    await expect(page.getByRole("alert").filter({ hasText: reason })).toBeVisible();
    // Not the old fixed string.
    await expect(page.getByText("Failed to update playlist.")).toHaveCount(0);
  });

  test("when every track is unhealthy it explains instead of sending an empty list", async ({ page }) => {
    await mockApi(page);
    let puts = 0;
    await page.route(
      (url) => url.pathname === "/api/playlists/1",
      async (route) => {
        if (route.request().method() === "PUT") {
          puts += 1;
          return route.fulfill(json({}));
        }
        return route.fulfill(
          json({
            ...FAKE_PLAYLIST_DETAIL,
            track_count: 2,
            tracks: FAKE_PLAYLIST_DETAIL.tracks
              .filter((t) => t.id === 301 || t.id === 302)
              .map((t) => ({ ...t })),
          }),
        );
      },
    );

    await openHealthCheck(page);
    await page.getByRole("button", { name: /Remove 2 Dead Tracks/ }).click();

    await expect(
      page.getByRole("alert").filter({ hasText: "Cannot remove all tracks from a playlist" }),
    ).toBeVisible();
    expect(puts).toBe(0);
  });

  test("a non-JSON failure falls back to the generic message", async ({ page }) => {
    await mockApi(page);
    await page.route(
      (url) => url.pathname === "/api/playlists/1",
      async (route) => {
        if (route.request().method() === "PUT") {
          return route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" });
        }
        return route.fallback();
      },
    );

    await openHealthCheck(page);
    await page.getByRole("button", { name: /Remove 2 Dead Tracks/ }).click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();

    await expect(page.getByRole("alert").filter({ hasText: "Failed to update playlist." })).toBeVisible();
  });

  test("when SoundCloud returns fewer tracks than it counts, removal is explained and turned off", async ({
    page,
  }) => {
    await mockApi(page);
    // The fixture returns 6 tracks; claim 8, so 2 are unreadable at any access level.
    const seen = await trackPlaylistRoute(page, { trackCount: 8 });

    await openHealthCheck(page);

    const alert = page.getByRole("status").filter({ hasText: "SoundCloud returned 6 of 8 tracks" });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("remove them on SoundCloud");
    const removeButton = page.getByRole("button", { name: /Remove 2 Dead Tracks/ });
    // Unavailable but still reachable: focusable, and described by the alert.
    await expect(removeButton).toHaveAttribute("aria-disabled", "true");
    await expect(removeButton).not.toHaveAttribute("disabled");
    await expect(removeButton).toHaveAttribute("aria-describedby", "health-shortfall");
    await expect(page.locator("#health-shortfall")).toContainText("SoundCloud returned 6 of 8 tracks");
    await removeButton.focus();
    await expect(removeButton).toBeFocused();
    // Playwright treats aria-disabled as not actionable; force past that to
    // prove the click guard really does nothing.
    await removeButton.click({ force: true });
    await expect(page.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
    expect(seen.putBodies).toHaveLength(0);

    await page.mouse.move(0, 0);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(blocking).toEqual([]);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
