import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures/api";
import { READY, type ReadyLocator } from "./fixtures/ready";

interface PageCase {
  path: string;
  /** Needs the mocked `/api/*` responses (protected app pages). */
  needsMock?: boolean;
  /** Set when the page is known to fail today; names the phase that fixes it. */
  fixme?: string;
  /** Expected HTTP status of the navigation response; defaults to 200. */
  expectedStatus?: number;
  /**
   * Something only the route's *real* content renders. Defaults to the
   * shared `READY` map, which the overflow spec uses too — see
   * `fixtures/ready.ts` for why the `h1` alone is not enough.
   */
  ready?: ReadyLocator;
}

const PAGES: PageCase[] = [
  { path: "/" },
  { path: "/about/" },
  { path: "/faq/" },
  { path: "/terms/" },
  { path: "/privacy/" },
  { path: "/accessibility/" },
  { path: "/login/" },
  // Public, reached from the Chrome extension's OAuth hand-off.
  { path: "/extension/connected/" },
  { path: "/does-not-exist/", expectedStatus: 404 },
  { path: "/dashboard/", needsMock: true },
  { path: "/like-manager/", needsMock: true },
  { path: "/following-manager/", needsMock: true },
  { path: "/repost-manager/", needsMock: true },
  { path: "/combine/", needsMock: true },
  { path: "/playlist-modifier/", needsMock: true },
  { path: "/growth/", needsMock: true },
  { path: "/link-resolver/", needsMock: true },
  { path: "/feedback/", needsMock: true },
  { path: "/account/", needsMock: true },
  { path: "/likes-to-playlist/", needsMock: true },
  { path: "/playlist-to-likes/", needsMock: true },
  { path: "/recently-played/", needsMock: true },
  { path: "/activity-to-playlist/", needsMock: true },
  // Its landing state is a static filter form, so the `h1` was nearly enough;
  // the shared map now names one of its chips anyway. Its results and dialog
  // are audited by the dedicated test further down.
  { path: "/genre-search/", needsMock: true },
  { path: "/downloads/", needsMock: true },
  // The e2e user is not on the download allowlist, so this audits the
  // "not available" state; the owner view is covered by rekordbox-gaps.spec.ts.
  { path: "/rekordbox-gaps/", needsMock: true },
  { path: "/playlist-keyword-search/", needsMock: true },
  { path: "/playlist-health-check/", needsMock: true },
  // No `ready` in the shared map: /export/ is a static hub of links.
  { path: "/export/", needsMock: true },
  { path: "/export/likes/", needsMock: true },
  { path: "/export/playlists/", needsMock: true },
  { path: "/export/followings/", needsMock: true },
  { path: "/export/reposts/", needsMock: true },
  { path: "/playlist-cloner/", needsMock: true },
  { path: "/playlist-compare/", needsMock: true },
  { path: "/batch-link-resolver/", needsMock: true },
  { path: "/following-library/", needsMock: true },
  { path: "/library-audit/", needsMock: true },
];

/** Audit whatever is on screen right now and fail on serious/critical. */
async function expectNoBlockingViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();

  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );

  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

for (const { path, needsMock, fixme, expectedStatus, ready = READY[path] } of PAGES) {
  test(`has no serious/critical WCAG 2.2 AA violations: ${path}`, async ({ page }) => {
    test.fixme(!!fixme, fixme);

    if (needsMock) {
      await mockApi(page);
    }

    // Audit the settled page. The landing's `animate-fade-in-up` entrances
    // hold a partial opacity for ~400ms, and axe reads the blended color as a
    // contrast failure on whatever it happens to catch mid-flight. Reduced
    // motion collapses those animations to their end state via the
    // `prefers-reduced-motion` block in globals.css, which is also the state
    // an a11y audit should be measuring.
    await page.emulateMedia({ reducedMotion: "reduce" });

    const response = await page.goto(path);

    if (expectedStatus !== undefined) {
      expect(response?.status()).toBe(expectedStatus);
    }

    // Audit the page, not the spinner. `AppLayout` renders a hydration/auth
    // gate before it mounts any child, so on a fast run `analyze()` can catch
    // that spinner, find nothing wrong with it, and pass without the real page
    // ever having been scanned. Every protected route puts an <h1> on screen —
    // via `PageHeader`, or its own on the dashboard — so waiting for the main
    // landmark and a heading is the cheap, route-agnostic proof that the shell
    // is mounted. It is still not proof the *route's* content is: a
    // `loading.tsx` and every in-page skeleton branch render the same
    // `PageHeader`, so the route's `ready` locator is what clears the skeleton
    // and the empty state — and, where the state worth auditing is one
    // interaction away, drives the page into it.
    if (needsMock) {
      await expect(page.locator("main#main-content")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    }
    if (ready) {
      await expect((await ready(page)).first()).toBeVisible();
    }
    if (needsMock) {
      // Park the cursor. A `ready` hook that clicks leaves it wherever it
      // clicked, and after the re-render some other control can be sitting
      // under it — so axe measures a `:hover` style on an element nobody is
      // pointing at, and which project's viewport happens to put a control
      // there decides whether the run passes. Axe never hovers anything by
      // itself; this restores that. (0,0) is over layout containers only.
      await page.mouse.move(0, 0);
    }

    await expectNoBlockingViolations(page);
  });
}

/**
 * /link-resolver/ only shows its form until something is resolved — the
 * layout, the stat grid, the embed and the copy buttons all live in the
 * result, which the page-list audit above never reaches.
 */
test("has no serious/critical WCAG 2.2 AA violations: /link-resolver/ result", async ({
  page,
}) => {
  await mockApi(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/link-resolver/");

  await page
    .getByLabel("SoundCloud URL")
    .fill("https://soundcloud.com/testartist/sample-resolved-track");
  await page.getByRole("button", { name: "Resolve" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Sample Resolved Track" }),
  ).toBeVisible();

  await expectNoBlockingViolations(page);
});

/**
 * The copy buttons are the page's only silent action: the clipboard write
 * leaves nothing on screen of its own, so the label swap and the
 * announcement are the whole of the feedback.
 */
test("link-resolver: copying swaps the label and announces it", async ({ page, context }) => {
  // Chromium denies `navigator.clipboard.writeText` without this, which
  // would exercise the failure branch instead of the success one.
  await context.grantPermissions(["clipboard-write"]);
  await mockApi(page);
  await page.goto("/link-resolver/");

  await page
    .getByLabel("SoundCloud URL")
    .fill("https://soundcloud.com/testartist/sample-resolved-track");
  await page.getByRole("button", { name: "Resolve" }).click();

  const copyUrl = page.getByRole("button", { name: "Copy URL" });
  await expect(copyUrl).toBeVisible();
  await copyUrl.click();

  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  // `LiveRegion` is `aria-live="polite"` and `sr-only`, so assert its text
  // rather than its visibility.
  await expect(page.locator("#app-live-region")).toHaveText("Copied");

  // Reverts on its own, so the next copy is unambiguous.
  await expect(copyUrl).toBeVisible({ timeout: 4000 });
});

/**
 * Three batch-C routes show a chooser first and keep the markup this sweep
 * actually changed one interaction away. `goto` + axe would audit the
 * chooser and report nothing about the track rows, the toolbar or the
 * add-to-playlist dialog, so each of these walks in one step further.
 */
test("has no serious/critical violations: /playlist-to-likes/ with a playlist chosen", async ({
  page,
}) => {
  await mockApi(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/playlist-to-likes/");

  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();
  await expect(page.getByRole("checkbox", { name: "Sample Track 1" })).toBeVisible();

  await expectNoBlockingViolations(page);
});

/**
 * The playlist editor, and the dialog its row actions open.
 *
 * The route-level audit above now drives into the editor via the shared
 * `READY` map, which covers the rows themselves. What it cannot reach is the
 * state behind a row action: `ConfirmDialog` renders nothing until a track's
 * Remove button is pressed, so "remove track?" — its heading, its focus, the
 * track summary it lists — had never been scanned anywhere. Neither had the
 * save confirmation, which is the same component with different content and a
 * destructive default.
 *
 * Audited as three separate states rather than one pass, because axe only
 * sees what is in the document when it runs.
 */
async function openPlaylistModifierEditor(page: Page) {
  await mockApi(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/playlist-modifier/");
  await page.getByRole("button", { name: "Sample Playlist 1" }).click();
  await expect(page.getByRole("group", { name: "Filter tracks" })).toBeVisible();
}

test("has no serious/critical violations: /playlist-modifier/ editor rows", async ({ page }) => {
  await openPlaylistModifierEditor(page);

  // The things the picker state never showed. The fixture gives the playlist
  // detail downloadable tracks and a purchase link precisely so this state is
  // not an empty list — an audit of an empty editor would pass for the wrong
  // reason.
  const main = page.getByRole("main");
  await expect(main.getByRole("button", { name: /^Download / }).first()).toBeVisible();
  await expect(main.getByRole("link", { name: /opens .* on an external site/ }).first()).toBeVisible();
  // Row actions are inline above `sm` and behind a per-row sheet below it, so
  // ask for whichever this viewport renders rather than assuming one of them.
  await expect(
    main
      .getByRole("button", { name: "Remove from playlist" })
      .or(main.getByRole("button", { name: /^More actions for / }))
      .first(),
  ).toBeVisible();

  await expectNoBlockingViolations(page);
});

/**
 * This test was `fixme`'d when it was written, because it found a real defect
 * in a file its task did not own: the three dialogs this page opens —
 * remove-track, save-changes, and the mobile row-actions sheet — all render
 * `BulkReviewDetails`, whose item list was
 * `<div class="max-h-44 space-y-1 overflow-y-auto">`: a scrollable region with
 * no focusable content and no tabindex, which axe reports as
 * `scrollable-region-focusable` (serious). Anyone using the keyboard could not
 * scroll it, so any item past the fourth was unreachable — in the confirm step
 * before a destructive bulk action, on eight pages (combine,
 * following-manager, repost-manager, playlist-modifier, playlist-health-check,
 * growth, like-manager, downloads).
 *
 * The component is fixed (`tabIndex={0}` + `role="group"` + a name + a focus
 * ring) and the `fixme` is gone. Reverting that fix in a scratch copy and
 * running this test at m360 reproduces the violation, so this is a live guard
 * rather than a test that would pass either way.
 */
test("has no serious/critical violations: /playlist-modifier/ row-action and confirm dialogs", async ({
  page,
}) => {
  await openPlaylistModifierEditor(page);
  const main = page.getByRole("main");

  // The remove confirmation, reached the way this viewport reaches it.
  const inlineRemove = main.getByRole("button", { name: "Remove from playlist" }).first();
  if (await inlineRemove.isVisible().catch(() => false)) {
    await inlineRemove.click();
  } else {
    await main.getByRole("button", { name: /^More actions for / }).first().click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    // The sheet is itself a state worth auditing before it is dismissed.
    await expectNoBlockingViolations(page);
    await sheet.getByRole("button", { name: "Remove from playlist" }).click();
  }

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName("Remove track?");
  await expectNoBlockingViolations(page);

  // Named directly, not only through axe: the rule that caught this is a
  // heuristic (it stops firing if the box ever gains a focusable child), and
  // the property that actually matters is that the scroller can take focus.
  const review = dialog.getByRole("group", { name: /^Items to / });
  await expect(review).toBeVisible();
  await review.focus();
  await expect(review).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // And the save confirmation, which is the same component with different
  // content and a destructive default.
  await main.getByRole("button", { name: /Save Changes/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectNoBlockingViolations(page);
});

test("has no serious/critical violations: /genre-search/ results and add-to-playlist dialog", async ({
  page,
}) => {
  await mockApi(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/genre-search/");

  // The advanced panel is `hidden` rather than unmounted, so `aria-controls`
  // always points at a real element; audit it open as well as closed.
  const advanced = page.getByRole("button", { name: "Advanced filters" });
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await advanced.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByLabel("Min BPM")).toBeVisible();

  await page.getByRole("button", { name: "house", exact: true }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("checkbox", { name: "Sample Track 1" }).check();

  await page.getByRole("button", { name: /Add to Playlist/i }).click();

  // The panel used to be a bare `fixed inset-0` div; it has to be a dialog
  // named by its own heading before the audit means anything.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName("Add to playlist");

  await expectNoBlockingViolations(page);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

/**
 * A successful add clears the selection, which unmounts `SelectionBanner` and
 * with it the button the dialog was opened from — so the focus `useDialog`
 * would otherwise restore to no longer exists, and `.focus()` on a detached
 * node silently leaves the user at `<body>`, above everything. The page hands
 * focus to the results block instead.
 */
test("genre-search: focus survives a successful add", async ({ page }) => {
  await mockApi(page);
  await page.goto("/genre-search/");

  await page.getByRole("button", { name: "house", exact: true }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("checkbox", { name: "Sample Track 1" }).check();

  await page.getByRole("button", { name: /Add to Playlist/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Playlist name").fill("E2E Sample Playlist");
  await dialog.getByRole("button", { name: "Add tracks" }).click();

  await expect(dialog).toBeHidden();
  // Exact text: a looser match also catches the live region's copy of the
  // same announcement, which is deliberately worded differently.
  await expect(
    page.getByText('1 track added to "Sample Playlist 9".', { exact: true }),
  ).toBeVisible();

  const focus = await page.evaluate(() => ({
    isBody: document.activeElement === document.body,
    text: (document.activeElement?.textContent || "").trim().slice(0, 40),
  }));
  expect(focus.isBody, "focus fell back to <body> after a successful add").toBe(false);
  expect(focus.text).toContain("Results");
});

test("has no serious/critical violations: /downloads/ track list and selection mode", async ({
  page,
}) => {
  await mockApi(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/downloads/");

  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();

  // Each download control names its track and its route, so a column of them
  // is not four buttons all called "Download".
  await expect(
    page.getByRole("button", { name: "Download Sample Track 1 (free download)" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download Sample Track 2 via Hypeddit" }),
  ).toBeVisible();

  // The button sets its own background, so `twMerge` has to drop the ghost
  // variant's `hover:text-accent-foreground` — otherwise the icon changes
  // colour on hover over green/purple and can fall below contrast.
  await expect(
    page.getByRole("button", { name: "Download Sample Track 1 (free download)" }),
  ).not.toHaveClass(/hover:text-accent-foreground/);

  await expectNoBlockingViolations(page);

  // Selection mode puts the same control in `rightSlot`, outside the row's
  // toggle label — the nested-interactive case this sweep was fixing.
  await page.getByRole("button", { name: "Select to Remove" }).click();
  await expect(page.getByRole("checkbox", { name: "Sample Track 1" })).toBeVisible();

  await expectNoBlockingViolations(page);
});

/**
 * "What's new" put a `<Button>` inside a `<Link>` — a control inside a
 * control, which axe reports as `nested-interactive` and which leaves a
 * screen reader describing one thing twice. The primary action is now the
 * link itself, and this pins both that and the localStorage gate it must not
 * have disturbed.
 */
test("What's new: the primary action is a link, and dismissal still persists", async ({
  page,
}) => {
  await mockApi(page);
  // `mockApi` pre-dismisses this announcement so it stays out of the way of
  // every other test; this is the one test that wants to see it.
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem("sc-toolkit-whatsnew-dismissed");
    } catch {
      // Private mode / blocked storage — nothing this init script can do.
    }
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/dashboard/");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName("What's new in Track Toolkit");
  await expect(dialog.getByRole("link", { name: "Try Grow Your Network" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Try Grow Your Network" })).toHaveCount(0);

  await expectNoBlockingViolations(page);

  await dialog.getByRole("button", { name: "Got it" }).click();
  await expect(dialog).toBeHidden();
  expect(
    await page.evaluate(() => window.localStorage.getItem("sc-toolkit-whatsnew-dismissed")),
  ).toBe("2026-07-growth");
});

/**
 * The shared `Dialog` primitive, exercised through a confirm that is reachable
 * from a mocked page without a write: `/like-manager/`'s bulk-unlike prompt.
 * (It used to be the sidebar's delete-account confirm; that moved to
 * `/account`.) Covers the five things a modal has to get right — it is
 * labelled by its visible heading, `initialFocusRef` beats "first focusable",
 * Tab wraps rather than escaping, Escape closes it, and focus goes back where
 * it came from.
 *
 * The panel's focusables in DOM order are: `BulkReviewDetails`' scrollable
 * item list (`role="group"`, `tabIndex={0}` — it has to take focus or the
 * list cannot be scrolled from the keyboard), "Export selection", Cancel,
 * then the confirm button. Cancel is in the middle, which is the point — it
 * is focused first only because `ConfirmDialog` passes it as
 * `initialFocusRef`.
 */
test("Dialog: labelled by its heading, honours initialFocusRef, wraps Tab, Escape restores focus", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/like-manager/");

  // Select a track so the banner — and with it the trigger — appears.
  const firstRow = page.getByRole("checkbox", { name: "Sample Track 1" });
  await expect(firstRow).toBeVisible();
  await firstRow.focus();
  await page.keyboard.press("Space");

  // Opened from the keyboard on purpose: Chromium does not focus a <button>
  // on a mouse click, so a click would leave `document.body` as the element to
  // restore to and the last assertion would prove nothing.
  const trigger = page.getByRole("button", { name: /Unlike Selected/ });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await trigger.press("Enter");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // aria-labelledby must resolve to the visible h2, not to a hidden string.
  await expect(dialog).toHaveAccessibleName("Unlike selected tracks?");
  await expect(
    dialog.getByRole("heading", { level: 2, name: "Unlike selected tracks?" }),
  ).toBeVisible();

  const review = dialog.getByRole("group", { name: /^Items to / });
  const exportButton = dialog.getByRole("button", { name: "Export selection" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const confirm = dialog.getByRole("button", { name: "Unlike", exact: true });

  // Opens on Cancel, so a stray Enter never confirms a destructive action —
  // and it is not the first focusable, so this can only pass via
  // `initialFocusRef`.
  await expect(cancel).toBeFocused();

  // Walked all the way to the first focusable, not stopped one short: the
  // review list is only reachable because it carries a tabindex, so a
  // shortened walk would pass while the thing this dialog exists to show was
  // unreachable. Shift+Tab off the first element then wraps to the last, and
  // Tab off the last wraps back to the first. Both wrap assertions fail the
  // moment focus is allowed to reach the page behind the dialog.
  await page.keyboard.press("Shift+Tab");
  await expect(exportButton).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(review).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(review).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

/**
 * Combine's target-playlist picker was the last hand-rolled focus trap in the
 * app; Phase 6 deleted it in favour of the shared `Dialog`. A dialog that is
 * closed on load is invisible to the route's own axe run, so the behaviour
 * that was deleted is asserted here instead: it is labelled by its heading,
 * Escape closes it, focus returns to the trigger, and the open dialog is
 * clean.
 */
test("combine: the target-playlist picker is the shared Dialog", async ({ page }) => {
  await mockApi(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/combine/");

  await page.getByRole("button", { name: "Existing playlist" }).click();

  const trigger = page.getByRole("button", { name: "Choose a target playlist…" });
  await trigger.focus();
  await trigger.press("Enter");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName("Target Playlist");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);

  // More presses than the panel has stops, so the trap must wrap to hold.
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]');
      return !!panel && !!document.activeElement && panel.contains(document.activeElement);
    });
    expect(inside, `focus escaped the picker after ${i + 1} Tab(s)`).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  // Choosing an option closes the picker too, and focus has to land back on
  // the trigger there as well. That only works because React reuses the same
  // <button> node across the "Choose a target playlist…" / "Change" ternary —
  // add a `key` or a wrapper and `returnFocusRef` would point at a detached
  // node and focus would fall to <body>. Pinned here so that stays true.
  await trigger.focus();
  await trigger.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Sample Playlist 1/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: /Change/ })).toBeFocused();
});

/**
 * Selection is a real checkbox, and the banner that appears is a status
 * region rather than a silent strip of pixels. Both are the point of
 * SelectableRow / SelectionBanner, and neither is visible to axe.
 */
test("selection: the checkbox drives the count, and the banner is a status region", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/like-manager/");

  const firstRow = page.getByRole("checkbox", { name: "Sample Track 1" });
  await expect(firstRow).toBeVisible();
  await expect(firstRow).not.toBeChecked();

  // Keyboard-native: no Enter/Space handler of our own is involved.
  await firstRow.focus();
  await page.keyboard.press("Space");
  await expect(firstRow).toBeChecked();

  const status = page.locator("[role=status]");
  await expect(status).toContainText("1");

  // The banner's action is reachable from the row by Tab alone — it is a
  // button in the document, not something only a pointer can get to.
  const action = page.getByRole("button", { name: /Unlike Selected/ });
  await expect(action).toBeVisible();

  let reached = false;
  for (let i = 0; i < 25 && !reached; i += 1) {
    await page.keyboard.press("Tab");
    reached = await action.evaluate((element) => element === document.activeElement);
  }
  expect(reached, "Tab never reached the selection banner's action button").toBe(true);
});

/**
 * Regression guard for the row body. Clicking the row toggles it through a
 * `<label>`, and Chromium skips forwarding a label click to its control when
 * the click extended a text selection — which a shift-click does unless the
 * label is `select-none`. Without that class this passes on the checkbox and
 * silently fails on the row, which is where people actually click.
 */
test("selection: shift-clicking the row body selects a range", async ({ page }) => {
  await mockApi(page);
  await page.goto("/like-manager/");

  await page.getByText("Sample Track 1", { exact: true }).click();
  await page.getByText("Sample Track 3", { exact: true }).click({ modifiers: ["Shift"] });

  await expect(page.getByRole("checkbox", { name: "Sample Track 2" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Sample Track 3" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Sample Track 4" })).not.toBeChecked();
});

/**
 * The app's one real `role="tablist"`. ARIA's tab pattern is a keyboard
 * contract, not a set of attributes: the strip is a single stop in the tab
 * order and the arrow keys move between the tabs inside it. None of that is
 * visible to axe, which is happy with three buttons that say they are tabs.
 */
test("following-library: the tab strip is one tab stop and the arrow keys move between tabs", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/following-library/");

  const likes = page.getByRole("tab", { name: "Liked Tracks" });
  const playlists = page.getByRole("tab", { name: "Playlists", exact: true });
  const liked = page.getByRole("tab", { name: "Liked Playlists" });

  await expect(likes).toBeVisible();
  await expect(likes).toHaveAttribute("aria-selected", "true");

  // Roving tabIndex: only the selected tab is reachable with Tab.
  await expect(likes).toHaveAttribute("tabindex", "0");
  await expect(playlists).toHaveAttribute("tabindex", "-1");
  await expect(liked).toHaveAttribute("tabindex", "-1");

  await likes.focus();
  await page.keyboard.press("ArrowRight");
  await expect(playlists).toBeFocused();
  await expect(playlists).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("End");
  await expect(liked).toBeFocused();

  await page.keyboard.press("Home");
  await expect(likes).toBeFocused();

  // ArrowLeft from the first tab wraps to the last.
  await page.keyboard.press("ArrowLeft");
  await expect(liked).toBeFocused();

  // The panel is named by its tab, so a screen reader can tell which list it
  // has landed in.
  await expect(page.getByRole("tabpanel")).toHaveAccessibleName("Liked Playlists");
});

/**
 * Switching tab must speak the count that arrived, not the one that left.
 *
 * Announcing from an effect on the array length got this wrong: the fetch
 * starts in the same commit as the tab change, so on that render nothing is
 * "loading" yet and the array is still the previous tab's — the region said
 * "0 playlists loaded", then the real number a moment later. Every value the
 * region takes is recorded, so a transient wrong one fails rather than being
 * polled past.
 */
test("following-library: switching tab announces the count that arrived, never a stale one", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/following-library/");

  const live = page.locator("#app-live-region");
  // The mocked user has 3 public likes and 2 public playlists.
  await expect(live).toHaveText("3 tracks loaded.");

  await page.evaluate(() => {
    const region = document.querySelector("#app-live-region");
    const seen: string[] = [];
    (window as unknown as { __live: string[] }).__live = seen;
    if (!region) return;
    new MutationObserver(() => {
      const text = (region.textContent || "").trim();
      if (text) seen.push(text);
    }).observe(region, { childList: true, characterData: true, subtree: true });
  });

  await page.getByRole("tab", { name: "Playlists", exact: true }).click();
  await expect(live).toHaveText("2 playlists loaded.");

  const spoken = await page.evaluate(() => (window as unknown as { __live: string[] }).__live);
  expect(spoken, `live region said: ${JSON.stringify(spoken)}`).toEqual(["2 playlists loaded."]);
});
