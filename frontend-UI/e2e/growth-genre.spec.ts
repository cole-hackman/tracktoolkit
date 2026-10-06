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
  await expect(page.getByText(/23 of 150 checked matched/)).toBeVisible();
  await expect(page.getByText("deep house", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("tech house", { exact: true })).toBeVisible();

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
        },
      }),
    });
  });
  await pickSeed(page);
  await page.getByLabel("Genre focus").selectOption("jazz");
  await page.getByRole("button", { name: /Scan Networks/ }).click();

  await expect(page.getByText("No Jazz matches")).toBeVisible();
  await expectNoBlockingViolations(page);
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Scan again with any genre" }).click();
  await expect(page.getByText("anygenre-one")).toBeVisible();
  await expect(page.getByText(/Focus:/)).toHaveCount(0);
});
