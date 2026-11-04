import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";

/**
 * The five `loading.tsx` route skeletons.
 *
 * They are only ever on screen while the route's own chunk is still in
 * flight, which no other spec can observe — so they are the one part of the
 * app that has never been audited or measured. Holding the chunk open makes
 * that window as long as the assertions need.
 */
const CASES = [
  { label: "Combine Playlists", path: "/combine/", chunk: "combine", sheet: "Playlists" },
  { label: "Like Manager", path: "/like-manager/", chunk: "like-manager", sheet: "Social" },
  { label: "Following Manager", path: "/following-manager/", chunk: "following-manager", sheet: "Social" },
  { label: "Grow Your Network", path: "/growth/", chunk: "growth", sheet: "Social" },
  // The one that cannot be reached from the dashboard: start elsewhere.
  { label: "Dashboard", path: "/dashboard/", chunk: "dashboard", from: "/like-manager/" },
];

for (const { label, path, chunk, from, sheet } of CASES) {
  test(`loading skeleton is a status region and fits the viewport: ${path}`, async ({
    page,
  }, testInfo) => {
    await mockApi(page);
    await page.emulateMedia({ reducedMotion: "reduce" });

    // Hold the route's own chunk. Next renders `loading.tsx` until it lands.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/_next/static/chunks/app/**${chunk}**`, async (route) => {
      await held;
      await route.continue();
    });

    await page.goto(from ?? "/dashboard/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // The sidebar is `hidden lg:flex`; narrow viewports go through the tab bar.
    if (testInfo.project.name !== "desktop" && sheet) {
      await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: sheet, exact: true })
        .click();
      await expect(page.locator('button[aria-label="Close menu"]')).toBeVisible();
    }
    await page.getByRole("link", { name: label, exact: true }).first().click();

    const status = page.getByRole("status", { name: "Loading" });
    await expect(status).toBeVisible();

    // The skeleton shapes are decoration: the region's whole accessible
    // content is the one sr-only line.
    await expect(status).toContainText(/Loading/);

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      scrollWidth,
      `${testInfo.project.name}: scrollWidth=${scrollWidth} clientWidth=${clientWidth}`,
    ).toBeLessThanOrEqual(clientWidth);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
      .analyze();
    const blocking = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);

    release?.();
  });
}
