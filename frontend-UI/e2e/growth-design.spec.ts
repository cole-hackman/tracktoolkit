import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";

/**
 * /growth/ on the shared design system: every list on the page (the seed
 * followings, the discovery results, the sessions and a session's actions)
 * is searched over the whole collection, and the outcome of a run is the
 * shared result panel in the slot above the tabs — focused, with the tool
 * still there to run again.
 */

async function expectNoBlockingViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

// Forty followings; two mention "night", one far past the first screenful.
const MANY_FOLLOWINGS = Array.from({ length: 40 }, (_, i) => ({
  id: 500 + i,
  username: i === 3 ? "Night Owl" : i === 37 ? "Late Night Radio" : `seed-${i + 1}`,
  avatar_url: null,
  followers_count: 200 + i,
  track_count: 5,
  permalink_url: `https://soundcloud.com/seed-${i + 1}`,
}));

function suggestion(id: number, username: string, genres: string[], trackTitle: string | null) {
  return {
    user: {
      id,
      username,
      avatar_url: "",
      permalink_url: `https://soundcloud.com/${username}`,
      followers_count: 300,
      followings_count: 280,
      track_count: 4,
    },
    score: 30,
    // "low" so nothing is pre-selected and every selection below is the test's.
    scoreLabel: "low",
    signals: { followBackRatio: 0.9, sharedInspirationCount: 1, isRelatedArtist: false, isCreator: true, genreAffinity: 0 },
    genres,
    suggestedTrack: trackTitle
      ? {
          id: id + 10000,
          title: trackTitle,
          artwork_url: "",
          likes_count: 10,
          playback_count: 100,
          permalink_url: `https://soundcloud.com/${username}/t`,
        }
      : null,
  };
}

const SUGGESTIONS = [
  suggestion(9101, "deepcuts", ["deep house"], "Basement Hours"),
  suggestion(9102, "lofi-lane", ["lofi"], null),
  suggestion(9103, "garage-days", ["uk garage"], "House Party Dub"),
  suggestion(9104, "ambient-hall", ["ambient"], "Slow Water"),
];

const STATS = {
  inspirationUsers: 1,
  candidatesScanned: 120,
  afterDedup: 80,
  suggestionsReturned: SUGGESTIONS.length,
  seedGenres: [],
  genreFocus: null,
  genreChecked: null,
  genreMatched: null,
  genreUnknown: null,
  genreSkipped: null,
};

async function scanWith(page: Page, suggestions = SUGGESTIONS) {
  await page.route("**/api/growth/discover", (route) =>
    route.fulfill(json({ suggestions, stats: { ...STATS, suggestionsReturned: suggestions.length } })),
  );
  await page.goto("/growth/");
  await page.getByRole("checkbox", { name: "testfollowing1" }).check();
  await page.getByRole("button", { name: /Scan Networks/ }).click();
  await expect(page.getByRole("heading", { name: "Discovery Results" })).toBeVisible();
}

test("seed search covers every following and keeps the seeds already picked: /growth/", async ({
  page,
}) => {
  await mockApi(page);
  await page.route(
    (url) => url.pathname === "/api/followings",
    (route) => route.fulfill(json({ collection: MANY_FOLLOWINGS, total: MANY_FOLLOWINGS.length })),
  );
  await page.goto("/growth/");

  const search = page.getByRole("searchbox", { name: "Search your followings" });
  await expect(search).toBeVisible();
  await expect(page.getByText("40 followings", { exact: true })).toBeVisible();

  await page.getByRole("checkbox", { name: "seed-1", exact: true }).check();

  await search.fill("night");
  await expect(page.getByText("Showing 2 of 40 followings")).toBeVisible();
  // The 38th following is found though it was never scrolled to.
  await page.getByRole("checkbox", { name: "Late Night Radio" }).check();
  await expect(page.getByRole("checkbox", { name: "seed-1", exact: true })).toHaveCount(0);
  await expect(page.getByText("2 of 5 selected")).toBeVisible();

  await search.fill("nothing like this");
  await expect(page.getByText("No followings match your search")).toBeVisible();

  await search.fill("");
  await expect(page.getByRole("checkbox", { name: "seed-1", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Late Night Radio" })).toBeChecked();
  await expectNoBlockingViolations(page);
});

test("the five-seed limit is reported at the seed list: /growth/", async ({ page }) => {
  await mockApi(page);
  await page.route(
    (url) => url.pathname === "/api/followings",
    (route) => route.fulfill(json({ collection: MANY_FOLLOWINGS, total: MANY_FOLLOWINGS.length })),
  );
  await page.goto("/growth/");

  for (const n of [1, 2, 3, 5, 6]) {
    await page.getByRole("checkbox", { name: `seed-${n}`, exact: true }).check();
  }
  await page.getByRole("checkbox", { name: "seed-7", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "seed-7", exact: true })).not.toBeChecked();
  await expect(
    page
      .getByRole("region", { name: "1. Select Inspiration Users" })
      .getByRole("alert")
      .filter({ hasText: "You can select a maximum of 5 seed users." }),
  ).toBeVisible();

  // Freeing a slot clears it, so it cannot come back stale later.
  await page.getByRole("checkbox", { name: "seed-6", exact: true }).uncheck();
  await expect(page.getByText("You can select a maximum of 5 seed users.")).toHaveCount(0);
});

test("discovery results search filters every suggestion; select all acts on the matches: /growth/", async ({
  page,
}) => {
  await mockApi(page);
  await scanWith(page);

  const search = page.getByRole("searchbox", { name: "Search suggestions" });
  await expect(page.getByText("4 suggestions", { exact: true })).toBeVisible();

  // Genre and suggested-track title are searched as well as the username.
  await search.fill("house");
  await expect(page.getByText("Showing 2 of 4 suggestions")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "deepcuts" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "garage-days" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "lofi-lane" })).toHaveCount(0);

  await page.getByRole("button", { name: "Select all 2 shown" }).click();
  await expect(page.getByText("2 users selected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Deselect shown" })).toBeVisible();

  // Without a query the button is the old one, over the whole list.
  await search.fill("");
  await expect(page.getByRole("checkbox", { name: "lofi-lane" })).not.toBeChecked();
  await page.getByRole("button", { name: "Select All", exact: true }).click();
  await expect(page.getByText("4 users selected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Deselect All", exact: true })).toBeVisible();
  await expectNoBlockingViolations(page);
});

test("a failed scan is an error result above the tool, which stays: /growth/", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/growth/discover", (route) => route.fulfill(json({ error: "nope" }, 500)));
  await page.goto("/growth/");
  await page.getByRole("checkbox", { name: "testfollowing1" }).check();
  await page.getByRole("button", { name: /Scan Networks/ }).click();

  const result = page.getByRole("region", { name: "Couldn't scan networks" });
  await expect(result).toBeVisible();
  await expect(result).toBeFocused();
  await expect(result).toContainText("Failed to run discovery");
  await expect(page.getByRole("checkbox", { name: "testfollowing1" })).toBeChecked();
  await expect(page.getByRole("button", { name: /Scan Networks/ })).toBeEnabled();
  await expectNoBlockingViolations(page);
});

test("an engagement batch reports its start, then its end in the result slot: /growth/", async ({
  page,
}) => {
  await mockApi(page);
  const job = {
    sessionId: "sess-1",
    sessionLabel: "Seed: testfollowing1",
    current: 0,
    total: 1,
    followed: 0,
    liked: 0,
    errorCount: 0,
    likeTracks: false,
  };
  await page.route("**/api/growth/engage", (route) =>
    route.fulfill(json({ job: { ...job, status: "running" } })),
  );
  await page.route("**/api/growth/engage/status", (route) =>
    route.fulfill(json({ job: { ...job, status: "complete", current: 1, followed: 1 } })),
  );
  await scanWith(page);

  await page.getByRole("checkbox", { name: "deepcuts" }).check();
  await page.getByRole("button", { name: "Follow selected" }).click();
  // The risk interstitial still comes first, with its wording.
  const dialog = page.getByRole("dialog", { name: "Before you follow in bulk" });
  await dialog.getByRole("button", { name: "Follow 1 — I understand" }).click();

  const started = page.getByRole("region", { name: "Engagement started" });
  await expect(started).toBeFocused();
  await expect(started).toContainText("following 1 user at a safe pace");

  const done = page.getByRole("region", { name: "Campaign Initiated!" });
  await expect(done).toBeVisible({ timeout: 10_000 });
  await expect(done).toBeFocused();
  await expect(started).toHaveCount(0);
  await expect(done.getByText("Users Followed")).toBeVisible();
  await expectNoBlockingViolations(page);

  // Its two ways on are the old step's two buttons.
  await done.getByRole("button", { name: "View Campaign History" }).click();
  await expect(page.getByRole("tab", { name: /History/ })).toHaveAttribute("aria-selected", "true");
  await expect(done).toBeHidden();

  // Back on Discover the summary is there again, without taking focus.
  const discoverTab = page.getByRole("tab", { name: /Discover/ });
  await discoverTab.click();
  await expect(done).toBeVisible();
  await expect(discoverTab).toBeFocused();

  await done.getByRole("button", { name: "Discover Again" }).click();
  await expect(done).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "testfollowing1" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: /Scan Networks/ })).toBeVisible();
});

const HISTORY = {
  sessions: [
    {
      sessionId: "s-a",
      label: "Seed: alpha — 1/2/2026",
      date: "2026-01-02T00:00:00Z",
      totalActions: 3,
      followedBack: 1,
      notFollowedBack: 0,
      unchecked: 2,
      reversed: 0,
    },
    {
      sessionId: "s-b",
      label: "Seed: bravo — 1/3/2026",
      date: "2026-01-03T00:00:00Z",
      totalActions: 1,
      followedBack: 0,
      notFollowedBack: 0,
      unchecked: 1,
      reversed: 0,
    },
  ],
  actions: [
    { id: "a1", actionType: "follow", targetId: 1, targetName: "kick-drum", targetAvatar: null, targetFollowers: 1, targetFollowings: 1, followedBack: true, checkedAt: null, reversed: false, reversedAt: null, sessionId: "s-a", sessionLabel: "alpha", createdAt: "2026-01-02T00:00:00Z" },
    { id: "a2", actionType: "follow", targetId: 2, targetName: "snare-roll", targetAvatar: null, targetFollowers: 1, targetFollowings: 1, followedBack: null, checkedAt: null, reversed: false, reversedAt: null, sessionId: "s-a", sessionLabel: "alpha", createdAt: "2026-01-02T00:00:00Z" },
    { id: "a3", actionType: "like", targetId: 3, targetName: "hat-loop", targetAvatar: null, targetFollowers: 1, targetFollowings: 1, followedBack: null, checkedAt: null, reversed: false, reversedAt: null, sessionId: "s-a", sessionLabel: "alpha", createdAt: "2026-01-02T00:00:00Z" },
    { id: "b1", actionType: "follow", targetId: 4, targetName: "bass-line", targetAvatar: null, targetFollowers: 1, targetFollowings: 1, followedBack: null, checkedAt: null, reversed: false, reversedAt: null, sessionId: "s-b", sessionLabel: "bravo", createdAt: "2026-01-03T00:00:00Z" },
  ],
};

test("history: sessions and a session's actions are searchable; nothing to unfollow is an empty result: /growth/", async ({
  page,
}) => {
  await mockApi(page);
  await page.route("**/api/growth/history", (route) => route.fulfill(json(HISTORY)));
  await page.goto("/growth/");
  await page.getByRole("tab", { name: /History/ }).click();

  const sessions = page.getByRole("searchbox", { name: "Search sessions" });
  await sessions.fill("bravo");
  await expect(page.getByText("Showing 1 of 2 sessions")).toBeVisible();
  await expect(page.getByRole("button", { name: /alpha/ })).toHaveCount(0);
  await sessions.fill("");
  await page.getByRole("button", { name: /Seed: alpha/ }).click();

  const actions = page.getByRole("searchbox", { name: "Search this session" });
  await actions.fill("like");
  await expect(page.getByText("Showing 1 of 3 actions")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "hat-loop" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "kick-drum" })).toHaveCount(0);
  await page.getByRole("button", { name: "Select all 1 shown" }).click();
  await expect(page.getByText("1 action selected")).toBeVisible();
  await actions.fill("");
  await expect(page.getByRole("checkbox", { name: "hat-loop" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "kick-drum" })).not.toBeChecked();
  // Audited with the destructive selection banner showing: its button used
  // to be white on #ef4444 (3.76:1) and is now on the destructive tokens.
  await expect(page.getByRole("button", { name: "Undo/Reverse Selected" })).toBeVisible();
  await expectNoBlockingViolations(page);
  await page.getByRole("checkbox", { name: "hat-loop" }).uncheck();

  // No follow in this session is a confirmed non-follower.
  await page.getByRole("button", { name: "Unfollow Non-Followbacks" }).click();
  const result = page.getByRole("region", { name: "Nothing to unfollow" });
  await expect(result).toBeFocused();
  await expect(result).toContainText("No non-reciprocating users to unfollow.");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectNoBlockingViolations(page);
});
