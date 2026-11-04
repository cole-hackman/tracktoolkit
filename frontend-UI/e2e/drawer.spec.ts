import { test, expect, type Locator, type Page } from "@playwright/test";
import { mockApi } from "./fixtures/api";

const MOBILE_PROJECTS = ["m360", "m390", "m430"];

/**
 * The mobile drawer renders through the shared `Dialog` (`variant="drawer"`),
 * so this file is also where that primitive is exercised end to end: it is
 * labelled by its visible heading, Tab cannot leave it, Escape closes it,
 * focus goes back to the trigger, and the page behind it cannot scroll.
 *
 * It was the sidebar's delete-account confirm that used to cover the
 * primitive (in `a11y.spec.ts`); that dialog moved to `/account`, and the
 * drawer is now the one modal reachable from a mocked page without a write.
 */

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

test.describe("mobile drawer", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), "mobile projects only");

    await mockApi(page);
    await page.goto("/dashboard/");
  });

  test("opens as a labelled dialog, takes focus, traps Tab and locks body scroll", async ({
    page,
  }) => {
    const hamburger = page.locator('button[aria-label="Open menu"]');
    await expect(hamburger).toHaveAttribute("aria-expanded", "false");
    expect(await bodyOverflow(page)).toBe("");

    await hamburger.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(hamburger).toHaveAttribute("aria-expanded", "true");

    // aria-labelledby must resolve to the visible h2, not to a hidden string.
    await expect(dialog).toHaveAccessibleName("Menu");
    await expect(dialog.getByRole("heading", { level: 2, name: "Menu" })).toBeVisible();

    // The nav the hamburger's aria-controls points at is the one in here.
    await expect(dialog.locator("nav#mobile-nav")).toHaveAttribute(
      "aria-label",
      "Main navigation",
    );

    expect(await focusIsInsideDialog(page), "focus did not move into the drawer").toBe(true);

    // The page behind a drawer must not scroll under it.
    expect(await bodyOverflow(page)).toBe("hidden");

    // The trap is asserted at the two edges where it actually does something.
    // Walking Tab a fixed number of times proves nothing here: the drawer has
    // ~36 focusable elements, so focus would never reach the end and the loop
    // would pass with no trap at all.
    const closeButton = dialog.getByRole("button", { name: "Close menu" });
    const lastFocusable = dialog.getByRole("link", { name: "Accessibility", exact: true });

    await expect(closeButton).toBeFocused();

    // Backwards off the first element wraps to the last...
    await page.keyboard.press("Shift+Tab");
    await expect(lastFocusable).toBeFocused();

    // ...and forwards off the last wraps back to the first.
    await page.keyboard.press("Tab");
    await expect(closeButton).toBeFocused();
  });

  test("Escape closes it, returns focus to the hamburger and unlocks body scroll", async ({
    page,
  }) => {
    const hamburger = page.locator('button[aria-label="Open menu"]');
    await hamburger.click();

    const closeButton = page.locator('button[aria-label="Close menu"]');
    await expect(closeButton).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(closeButton).toBeHidden();
    await expect(hamburger).toBeFocused();
    await expect(hamburger).toHaveAttribute("aria-expanded", "false");
    expect(await bodyOverflow(page)).toBe("");
  });

  test("the current route is marked, and every row is a 44px target", async ({ page }) => {
    await page.locator('button[aria-label="Open menu"]').click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await expect(dialog.getByRole("link", { name: "Dashboard", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );

    // Every row in the list is a 44px target, by class rather than by a
    // pointer media query, so this holds under any emulation.
    const shortRows = await measure(dialog.locator("nav a"), 44);
    expect(shortRows, JSON.stringify(shortRows, null, 2)).toEqual([]);

    // And nothing in the drawer is under the WCAG 2.5.8 floor.
    const tiny = await measure(dialog.locator("a, button"), 24);
    expect(tiny, JSON.stringify(tiny, null, 2)).toEqual([]);
  });

  test("each nav group is a disclosure that reports its own state", async ({ page }) => {
    await page.locator('button[aria-label="Open menu"]').click();

    const dialog = page.getByRole("dialog");
    const toggle = dialog.getByRole("button", { name: "Playlists" });
    const child = dialog.getByRole("link", { name: "Combine Playlists", exact: true });

    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(child).toBeVisible();

    await toggle.click();

    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(child).toBeHidden();

    // aria-controls has to resolve to something, open or closed.
    const controls = await toggle.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(await dialog.locator(`[id="${controls}"]`).count()).toBe(1);
  });
});
