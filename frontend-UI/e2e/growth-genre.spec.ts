import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";

/**
 * Genre focus on /growth/. Runs on every project (desktop and the three phone
 * widths), so the 360px no-overflow check comes for free.
 */

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
  expect(scrollWidth, `scrollWidth=${scrollWidth} clientWidth=${clientWidth}`).toBeLessThanOrEqual(
    clientWidth,
  );
}

async function pickSeed(page: Page) {
  await page.goto("/growth/");
  await page.getByRole("checkbox", { name: "testfollowing1" }).check();
}

test("genre focus select is labelled, described, and audits clean: /growth/", async ({ page }) => {
  await mockApi(page);
  await pickSeed(page);

  const select = page.getByLabel("Genre focus");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("any");
  await expect(select).toHaveAccessibleDescription(/Only suggests accounts whose recent tracks match/);
  await expectNoBlockingViolations(page);
  await expectNoHorizontalOverflow(page);
});

test("a focused scan sends the genre and shows focus stats and card genres: /growth/", async ({
  page,
}) => {
  await mockApi(page);
  await pickSeed(page);

  await page.getByLabel("Genre focus").selectOption("house");

  const requestPromise = page.waitForRequest(
    (r) => r.url().endsWith("/api/growth/discover") && r.method() === "POST",
  );
  await page.getByRole("button", { name: /Scan Networks/ }).click();
  const body = (await requestPromise).postDataJSON();
  expect(body.genre).toBe("house");

  await expect(page.getByText("Focus: House")).toBeVisible();
  await expect(page.getByText(/2 of 150 checked matched/)).toBeVisible();
  await expect(page.getByText("deep house", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("tech house", { exact: true })).toBeVisible();
  // The card with chips AND the track row/preview renders at every width.
  await expect(page.getByText("Warehouse Sunrise Extended Mix")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Preview Warehouse Sunrise Extended Mix on SoundCloud" }),
  ).toBeVisible();

  await expectNoBlockingViolations(page);
  await expectNoHorizontalOverflow(page);
});

test("no focus sends no genre: /growth/", async ({ page }) => {
  await mockApi(page);
  await pickSeed(page);

  const requestPromise = page.waitForRequest(
    (r) => r.url().endsWith("/api/growth/discover") && r.method() === "POST",
  );
  await page.getByRole("button", { name: /Scan Networks/ }).click();
  const body = (await requestPromise).postDataJSON();
  expect(body).not.toHaveProperty("genre");
  await expect(page.getByText(/Focus:/)).toHaveCount(0);
});

test("zero matches explains itself and offers a rescan with any genre: /growth/", async ({
  page,
}) => {
  await mockApi(page);
  // Registered after mockApi, so it wins for focused scans only.
  await page.route("**/api/growth/discover", async (route, request) => {
    const body = request.postDataJSON() as { genre?: string } | null;
    if (!body?.genre) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        suggestions: [],
        stats: {
          inspirationUsers: 1,
          candidatesScanned: 300,
          afterDedup: 200,
          suggestionsReturned: 0,
          seedGenres: ["house"],
          genreFocus: body.genre,
          genreChecked: 150,
          genreMatched: 0,
          genreUnknown: 12,
          genreSkipped: 0,
        },
      }),
    });
  });
  await pickSeed(page);
  await page.getByLabel("Genre focus").selectOption("jazz");
  await page.getByRole("button", { name: /Scan Networks/ }).click();

  await expect(page.getByText("No Jazz matches")).toBeVisible();
  // genreUnknown is 12 here, so the copy must not claim "none had tracks tagged".
  await expect(page.getByText(/12 could not be placed/)).toBeVisible();
  await expect(page.getByText(/None of the 150 accounts checked had recent tracks/)).toHaveCount(0);
  await expectNoBlockingViolations(page);
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Scan again with any genre" }).click();
  await expect(page.getByText("anygenre-one")).toBeVisible();
  await expect(page.getByText(/Focus:/)).toHaveCount(0);
});

function zeroMatchStats(over: Record<string, number>) {
  return {
    inspirationUsers: 1,
    candidatesScanned: 300,
    afterDedup: 200,
    suggestionsReturned: 0,
    seedGenres: ["house"],
    genreFocus: "folk",
    genreChecked: 150,
    genreMatched: 0,
    genreUnknown: 0,
    genreSkipped: 0,
    ...over,
  };
}

test("zero matches with everything placed says none had tracks tagged the genre: /growth/", async ({
  page,
}) => {
  await mockApi(page);
  await page.route("**/api/growth/discover", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ suggestions: [], stats: zeroMatchStats({}) }),
    }),
  );
  await pickSeed(page);
  await page.getByLabel("Genre focus").selectOption("folk");
  await page.getByRole("button", { name: /Scan Networks/ }).click();

  await expect(page.getByText("No Folk matches")).toBeVisible();
  await expect(
    page.getByText(/None of the 150 accounts checked had recent tracks tagged Folk/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan again with any genre" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("nothing checked before the deadline mentions the time budget, not the genre: /growth/", async ({
  page,
}) => {
  await mockApi(page);
  await page.route("**/api/growth/discover", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        suggestions: [],
        stats: zeroMatchStats({ genreChecked: 0, genreSkipped: 150 }),
      }),
    }),
  );
  await pickSeed(page);
  await page.getByLabel("Genre focus").selectOption("folk");
  await page.getByRole("button", { name: /Scan Networks/ }).click();

  await expect(page.getByText(/ran out of its time budget before any account/)).toBeVisible();
  await expect(page.getByText("No Folk matches")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Scan again with any genre" })).toHaveCount(0);
});

function unscoredSuggestions(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    user: {
      id: 8000 + i,
      username: `unscored-${i + 1}`,
      avatar_url: "",
      permalink_url: `https://soundcloud.com/unscored-${i + 1}`,
      followers_count: 90,
      followings_count: 80,
      track_count: 4,
    },
    score: 40,
    scoreLabel: "limited",
    signals: { followBackRatio: 0.9, sharedInspirationCount: 1, isRelatedArtist: false, isCreator: true, genreAffinity: null },
    genres: [],
    suggestedTrack: null,
  }));
}

function unfocusedStats(over: Record<string, unknown>) {
  return {
    inspirationUsers: 1,
    candidatesScanned: 300,
    afterDedup: 200,
    suggestionsReturned: 3,
    seedGenres: [],
    partial: true,
    crawlPartial: false,
    genreFocus: null,
    genreChecked: null,
    genreMatched: null,
    genreUnknown: null,
    genreSkipped: null,
    lookupsSkipped: 3,
    ...over,
  };
}

test("an unfocused scan whose lookups ran out of time still warns: /growth/", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/growth/discover", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ suggestions: unscoredSuggestions(3), stats: unfocusedStats({}) }),
    }),
  );
  await pickSeed(page);
  await page.getByRole("button", { name: /Scan Networks/ }).click();

  await expect(page.getByText("unscored-1")).toBeVisible();
  await expect(page.getByTestId("budget-notice")).toHaveCount(1);
  await expect(
    page.getByText(/3 suggestions weren't checked for genre or recent tracks.*they were ranked without genre fit/),
  ).toBeVisible();
  await expect(page.getByText(/partial crawl/)).toHaveCount(0);
  await expect(page.getByText(/fully scored/)).toHaveCount(0);
  await expectNoBlockingViolations(page);
  await expectNoHorizontalOverflow(page);
});

test("an unfocused partial crawl with skipped lookups shows one combined notice: /growth/", async ({
  page,
}) => {
  await mockApi(page);
  await page.route("**/api/growth/discover", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        suggestions: unscoredSuggestions(3),
        stats: unfocusedStats({ crawlPartial: true }),
      }),
    }),
  );
  await pickSeed(page);
  await page.getByRole("button", { name: /Scan Networks/ }).click();

  await expect(page.getByText("unscored-1")).toBeVisible();
  await expect(page.getByTestId("budget-notice")).toHaveCount(1);
  await expect(page.getByTestId("budget-notice")).toHaveText(
    /partial crawl, and 3 suggestions weren't scored/,
  );
  await expect(page.getByText(/fully scored/)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
