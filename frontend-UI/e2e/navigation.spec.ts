import { expect, test, type Page } from "@playwright/test";
import { mockApi } from "./fixtures/api";

/**
 * Two behaviours that only exist because `output: 'export'` keeps every tool
 * page a client component, so none of them can export `metadata`:
 *
 *  - `usePageTitle` (via `PageHeader`) gives each route its own
 *    `document.title`, and has to survive Next applying the route's inherited
 *    metadata in a chunk that commits after hydration.
 *  - `PageHeader` moves focus to the `<h1>` on a client-side navigation — and
 *    only then, because a fresh load must keep the focus the browser gave it.
 */

const SIDEBAR_IS_VISIBLE = "desktop";

/** Tools these tests visit that sit in a sheet on a phone, and the tab that opens it. */
const MOBILE_SHEET: Record<string, string> = {
  "Like Manager": "Social",
  "Playlist Compare": "Playlists",
};

/** The sidebar is `hidden lg:flex`; narrow viewports reach the same tree through the tab bar. */
async function navigateTo(page: Page, projectName: string, label: string): Promise<void> {
  if (projectName === SIDEBAR_IS_VISIBLE) {
    await page.getByRole("link", { name: label, exact: true }).first().click();
    return;
  }

  const tabs = page.getByRole("navigation", { name: "Main navigation" });
  const sheet = MOBILE_SHEET[label];
  if (!sheet) {
    await tabs.getByRole("link", { name: label, exact: true }).click();
    return;
  }

  await tabs.getByRole("button", { name: sheet, exact: true }).click();
  await page.getByRole("dialog").getByRole("link", { name: label, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test("a fresh load keeps the route's own title and does not steal focus", async ({ page }) => {
  await page.goto("/like-manager/");

  const heading = page.getByRole("heading", { level: 1, name: "Like Manager" });
  await expect(heading).toBeVisible();
  await expect(page).toHaveTitle("Like Manager · Track Toolkit");

  // Next streams the route's inherited metadata in a chunk that commits after
  // hydration has run the effect; give it room to overwrite the title.
  await page.waitForTimeout(750);
  await expect(page).toHaveTitle("Like Manager · Track Toolkit");

  await expect(heading).not.toBeFocused();
});

test("navigating from the dashboard retitles the page and focuses its h1", async ({ page }, testInfo) => {
  await page.goto("/dashboard/");
  await expect(page).toHaveTitle("Dashboard · Track Toolkit");

  await navigateTo(page, testInfo.project.name, "Like Manager");

  await expect(page).toHaveTitle("Like Manager · Track Toolkit");
  await expect(page.getByRole("heading", { level: 1, name: "Like Manager" })).toBeFocused();
});

/**
 * `/dashboard/` is the route this machinery used to skip. It rendered no
 * `PageHeader`, so it had no title of its own and no focusable `<h1>` — the
 * one page in the group you could land on and be told nothing about. Both
 * halves are asserted here: the exact title on a fresh load, and the focus
 * move on the way back to it.
 */
test("the dashboard has its own title and its h1 takes focus on arrival", async ({
  page,
}, testInfo) => {
  await page.goto("/dashboard/");

  const heading = page.getByRole("heading", { level: 1, name: "Dashboard" });
  await expect(heading).toBeVisible();
  await expect(page).toHaveTitle("Dashboard · Track Toolkit");

  // Next streams the route's inherited metadata in a chunk that commits after
  // hydration has run the effect; give it room to overwrite the title.
  await page.waitForTimeout(750);
  await expect(page).toHaveTitle("Dashboard · Track Toolkit");

  // A fresh load keeps the focus the browser gave it, here as everywhere.
  await expect(heading).not.toBeFocused();

  // ... but arriving from a tool is a navigation, and lands on the heading.
  await navigateTo(page, testInfo.project.name, "Like Manager");
  await expect(page.getByRole("heading", { level: 1, name: "Like Manager" })).toBeFocused();

  await navigateTo(page, testInfo.project.name, "Dashboard");
  await expect(page).toHaveTitle("Dashboard · Track Toolkit");
  await expect(heading).toBeFocused();
});

test("navigating between two tools retitles the page and focuses its h1", async ({ page }, testInfo) => {
  await page.goto("/like-manager/");
  await expect(page).toHaveTitle("Like Manager · Track Toolkit");

  await navigateTo(page, testInfo.project.name, "Playlist Compare");

  await expect(page).toHaveTitle("Playlist Compare · Track Toolkit");
  await expect(page.getByRole("heading", { level: 1, name: "Playlist Compare" })).toBeFocused();
});

/**
 * The round trip. A `PageHeader`-local latch would be unset here: it unmounts
 * with the page you left, and on the way back the pathname is once again the
 * one the document loaded at — so the return trip looks like a fresh load and
 * the heading never takes focus. The latch lives in the app-group layout,
 * which stays mounted across every navigation in the group.
 */
test("returning to the loaded route via the dashboard still focuses its h1", async ({
  page,
}, testInfo) => {
  await page.goto("/like-manager/");
  await expect(page.getByRole("heading", { level: 1, name: "Like Manager" })).toBeVisible();

  await navigateTo(page, testInfo.project.name, "Dashboard");
  await expect(page).toHaveTitle(/Track Toolkit/);

  await navigateTo(page, testInfo.project.name, "Like Manager");

  await expect(page).toHaveTitle("Like Manager · Track Toolkit");
  await expect(page.getByRole("heading", { level: 1, name: "Like Manager" })).toBeFocused();
});
