import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";

const MOBILE_PROJECTS = ["m360", "m390", "m430"];

/**
 * The phone navigation: a tab bar, and sheets rendered through the shared
 * `Dialog` (`variant="sheet"`). This file is also where that primitive is
 * exercised end to end: it is labelled by its visible heading, Tab cannot
 * leave it, Escape closes it, focus goes back to the trigger, and the page
 * behind it cannot scroll.
 */

const tabBar = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });
const sheetTab = (page: Page, name: string) =>
  tabBar(page).getByRole("button", { name, exact: true });

function focusIsInsideDialog(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const panel = document.querySelector('[role="dialog"]');
    return !!panel && !!document.activeElement && panel.contains(document.activeElement);
  });
}

const bodyOverflow = (page: Page) => page.evaluate(() => document.body.style.overflow);

/** Every element matched by `target` whose box is shorter than `min` CSS px. */
function measure(target: Locator, min: number) {
  return target.evaluateAll(
    (elements, minHeight) =>
      elements
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60),
          };
        })
        .filter((box) => box.height < minHeight),
    min,
  );
}

test.describe("mobile tab bar", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), "mobile projects only");
    await mockApi(page);
    await page.goto("/dashboard/");
  });

  test("has five labelled slots pinned to the bottom, each a 44px target", async ({ page }) => {
    const bar = tabBar(page);
    await expect(bar.locator("a, button")).toHaveText([
      "Dashboard",
      "Playlists",
      "Social",
      "Downloads",
      "More",
    ]);

    const box = await bar.boundingBox();
    const viewport = page.viewportSize()!;
    expect(Math.round(box!.y + box!.height)).toBe(viewport.height);

    const short = await measure(bar.locator("a, button"), 44);
    expect(short, JSON.stringify(short, null, 2)).toEqual([]);

    const narrow = await bar.locator("a, button").evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().width).filter((width) => width < 44),
    );
    expect(narrow).toEqual([]);
  });

  test("marks where you are, including inside a sheet's group", async ({ page }) => {
    await expect(tabBar(page).getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await page.goto("/combine/");
    await expect(sheetTab(page, "Playlists")).toHaveAttribute("aria-current", "true");

    await page.goto("/like-manager/");
    await expect(sheetTab(page, "Social")).toHaveAttribute("aria-current", "true");

    await page.goto("/export/");
    await expect(sheetTab(page, "More")).toHaveAttribute("aria-current", "true");

    await page.goto("/account/");
    await expect(sheetTab(page, "More")).toHaveAttribute("aria-current", "true");
  });

  test("every tool in NAV is one tab or one sheet away", async ({ page }) => {
    const reachable = new Set<string>();
    const hrefs = (scope: Locator) =>
      scope.locator("a").evaluateAll((links) =>
        links.map((link) => new URL((link as HTMLAnchorElement).href).pathname.replace(/\/$/, "")),
      );

    for (const href of await hrefs(tabBar(page))) reachable.add(href);

    for (const name of ["Playlists", "Social", "More"]) {
      await sheetTab(page, name).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      for (const href of await hrefs(dialog)) reachable.add(href);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }

    // The rail is `hidden` here but still in the DOM, and it renders from the
    // same tree. nav.ts itself cannot be imported: lucide-react will not load
    // in Playwright's runner.
    const tools = await hrefs(page.locator("aside nav"));
    expect(tools.length).toBeGreaterThan(20);
    expect(tools.filter((href) => !reachable.has(href))).toEqual([]);
  });

  test("the last thing on a page is not stuck behind the bar", async ({ page }) => {
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

    const gap = await page.evaluate(() => {
      const main = document.querySelector("main")!;
      const last = main.lastElementChild!.getBoundingClientRect();
      const bar = document
        .querySelector('nav[aria-label="Main navigation"]')!
        .getBoundingClientRect();
      return bar.top - last.bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(-1);
  });
});

test.describe("mobile nav sheets", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), "mobile projects only");
    await mockApi(page);
    await page.goto("/dashboard/");
  });

  test("opens as a labelled dialog, takes focus, traps Tab and locks body scroll", async ({
    page,
  }) => {
    const more = sheetTab(page, "More");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    expect(await bodyOverflow(page)).toBe("");

    await more.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // aria-labelledby must resolve to the visible h2, not to a hidden string.
    await expect(dialog).toHaveAccessibleName("More");
    await expect(dialog.getByRole("heading", { level: 2, name: "More" })).toBeVisible();

    expect(await focusIsInsideDialog(page), "focus did not move into the sheet").toBe(true);

    // The page behind a sheet must not scroll under it.
    expect(await bodyOverflow(page)).toBe("hidden");

    // The trap is asserted at the two edges where it actually does something.
    const closeButton = dialog.getByRole("button", { name: "Close menu" });
    const lastFocusable = dialog.getByRole("link", { name: "Accessibility", exact: true });

    await expect(closeButton).toBeFocused();

    await page.keyboard.press("Shift+Tab");
    await expect(lastFocusable).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(closeButton).toBeFocused();
  });

  test("Escape closes it, returns focus to its tab and unlocks body scroll", async ({ page }) => {
    const playlists = sheetTab(page, "Playlists");
    await playlists.click();

    const closeButton = page.locator('button[aria-label="Close menu"]');
    await expect(closeButton).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(closeButton).toBeHidden();
    await expect(playlists).toBeFocused();
    expect(await bodyOverflow(page)).toBe("");
  });

  test("a group tab lists that group, and every row is a 44px target", async ({ page }) => {
    await sheetTab(page, "Playlists").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAccessibleName("Playlists");
    await expect(dialog.getByRole("link")).toHaveCount(7);

    const short = await measure(dialog.getByRole("link"), 44);
    expect(short, JSON.stringify(short, null, 2)).toEqual([]);
  });

  test("picking a tool closes the sheet and marks it current next time", async ({ page }) => {
    await sheetTab(page, "Social").click();
    await page.getByRole("dialog").getByRole("link", { name: "Like Manager", exact: true }).click();

    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Like Manager" })).toBeFocused();

    await sheetTab(page, "Social").click();
    await expect(
      page.getByRole("dialog").getByRole("link", { name: "Like Manager", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("More keeps the account block at the top of the navigation", async ({ page }) => {
    await sheetTab(page, "More").click();
    const dialog = page.getByRole("dialog");

    const support = dialog.getByRole("link", { name: "Support Me" });
    const logOut = dialog.getByRole("button", { name: "Log out" });
    const filter = dialog.getByRole("searchbox", { name: "Find a tool" });
    const firstTool = dialog.getByRole("link", { name: "Export", exact: true });

    await expect(logOut).toBeInViewport();
    await expect(support).toBeInViewport();

    const y = async (locator: Locator) => (await locator.boundingBox())!.y;
    expect(await y(logOut)).toBeLessThan(await y(support));
    expect(await y(support)).toBeLessThan(await y(filter));
    expect(await y(filter)).toBeLessThan(await y(firstTool));

    // The shimmer is a decision, not decoration: it has to survive the move.
    await expect(support.locator(".animate-shiny-text")).toHaveCount(1);

    const tiny = await measure(dialog.locator("a, button"), 24);
    expect(tiny, JSON.stringify(tiny, null, 2)).toEqual([]);
  });

  test("the open More sheet has no serious or critical axe violations", async ({ page }) => {
    await sheetTab(page, "More").click();
    await expect(page.getByRole("dialog")).toBeVisible();

    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => v.id)).toEqual([]);
  });

  test("the filter finds any tool, even one with its own tab", async ({ page }) => {
    await sheetTab(page, "More").click();
    const dialog = page.getByRole("dialog");
    const filter = dialog.getByRole("searchbox", { name: "Find a tool" });

    // Lives in the Social sheet; only reachable from here through the filter.
    await expect(dialog.getByRole("link", { name: "Likes → Playlist" })).toHaveCount(0);

    await filter.fill("likes playlist");
    await expect(dialog.getByRole("link", { name: "Likes → Playlist" })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Export", exact: true })).toHaveCount(0);

    // Word order, case and the arrow do not matter.
    await filter.fill("PLAYLIST → LIKES");
    await expect(dialog.getByRole("link", { name: "Likes → Playlist" })).toBeVisible();

    // A tool's group counts as part of its name.
    await filter.fill("social");
    await expect(dialog.getByRole("link", { name: "Repost Manager" })).toBeVisible();

    await filter.fill("likes zzz");
    await expect(dialog.getByText("No tools match")).toBeVisible();

    await filter.fill("");
    await expect(dialog.getByRole("link", { name: "Export", exact: true })).toBeVisible();

    await filter.fill("compare");
    await dialog.getByRole("link", { name: "Playlist Compare" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Playlist Compare" })).toBeFocused();

    // Closing clears it, so More is never reopened showing a stale filter.
    await sheetTab(page, "More").click();
    await expect(page.getByRole("dialog").getByRole("searchbox")).toHaveValue("");
  });
});

test.describe("mobile viewport", () => {
  test("only the app group opts in to safe-area insets", async ({ page }) => {
    await mockApi(page);
    await page.goto("/dashboard/");
    const appViewport = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(appViewport).toContain("viewport-fit=cover");
    expect(appViewport).toContain("maximum-scale=5");

    await page.goto("/about/");
    const publicViewport = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(publicViewport).not.toContain("viewport-fit");
  });
});

test("desktop keeps the rail and shows no tab bar", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop only");
  await mockApi(page);
  await page.goto("/dashboard/");

  await expect(page.getByRole("navigation", { name: "Main", exact: true })).toBeVisible();
  await expect(tabBar(page)).toBeHidden();
});
