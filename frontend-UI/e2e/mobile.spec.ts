import { test, expect, type Locator, type Page } from "@playwright/test";
import { LONG_TRACK_TITLE, mockApi } from "./fixtures/api";
import { READY, type ReadyLocator } from "./fixtures/ready";

const MOBILE_PROJECTS = ["m360", "m390", "m430"];

interface PageCase {
  path: string;
  needsMock?: boolean;
  /** Set when the page is known to overflow today; names the phase that fixes it. */
  fixme?: string;
  /**
   * Something only the route's *real* content renders. Defaults to the shared
   * `READY` map, which the axe spec uses too — see `fixtures/ready.ts`.
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
  { path: "/does-not-exist/" },
  { path: "/dashboard/", needsMock: true },
  { path: "/like-manager/", needsMock: true },
  { path: "/following-manager/", needsMock: true },
  { path: "/repost-manager/", needsMock: true },
  { path: "/combine/", needsMock: true },
  { path: "/playlist-modifier/", needsMock: true },
  { path: "/link-resolver/", needsMock: true },
  { path: "/feedback/", needsMock: true },
  { path: "/account/", needsMock: true },
  // Fixed in Phase 6: the tab strip's three long labels ("Discover
  // Suggestions" / "Campaign History" / "Analytics") were a `w-fit` row that
  // measured ~397px, which is the whole of the overflow this fixme recorded.
  // Short labels below `sm` plus equal-width tabs bring it inside 360.
  { path: "/growth/", needsMock: true },
  { path: "/likes-to-playlist/", needsMock: true },
  { path: "/playlist-to-likes/", needsMock: true },
  { path: "/recently-played/", needsMock: true },
  { path: "/activity-to-playlist/", needsMock: true },
  // No `ready` in the shared map on purpose — see the matching note in
  // a11y.spec.ts: this page's landing state is a static form with no async
  // content to wait for.
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

/**
 * Every element matching `selector` must have a bounding box of at least
 * min x min CSS pixels (WCAG 2.2 SC 2.5.8 Target Size, Minimum). Used for
 * mobile tap targets, where the desktop `min-h`/`min-w` utility classes may
 * not carry through.
 */
export async function assertTapTargets(page: Page, selector: string, min: number) {
  const undersized = await page.locator(selector).evaluateAll(
    (elements, minSize) =>
      elements
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60),
          };
        })
        .filter((box) => box.width < minSize || box.height < minSize),
    min,
  );

  expect(undersized, JSON.stringify(undersized, null, 2)).toEqual([]);
}

/**
 * The control must be fully on screen on both edges.
 *
 * `scrollWidth` cannot see this and neither can axe: an element clipped by an
 * `overflow: hidden` ancestor contributes nothing to the document's scroll
 * width, so a button can sit entirely off the right edge while the overflow
 * check and the audit both pass. The usual cause is `truncate` on a *flex
 * container*: `white-space: nowrap` reaches the anonymous flex item holding
 * the text, whose `min-width: auto` is then its full nowrap width, so it never
 * shrinks and the `shrink-0` control beside it is pushed out and clipped.
 */
async function expectFullyOnScreen(page: Page, locator: Locator, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label}: no bounding box`).not.toBeNull();
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  const right = box!.x + box!.width;
  expect(box!.x, `${label}: left edge at ${box!.x}`).toBeGreaterThanOrEqual(0);
  expect(right, `${label}: right edge at ${right}, viewport is ${clientWidth}`).toBeLessThanOrEqual(
    clientWidth,
  );
}

/** `document.documentElement` must not be wider than the device. */
async function expectNoOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `scrollWidth=${scrollWidth} clientWidth=${clientWidth}`).toBeLessThanOrEqual(
    clientWidth,
  );
}

for (const { path, needsMock, fixme, ready = READY[path] } of PAGES) {
  test(`no horizontal overflow: ${path}`, async ({ page }, testInfo) => {
    test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), "mobile projects only");
    test.fixme(!!fixme, fixme);

    if (needsMock) {
      await mockApi(page);
    }

    await page.goto(path);

    // Measure the settled page, for the same reason the axe spec audits one:
    // `AppLayout` renders a hydration/auth spinner and a route with a
    // `loading.tsx` renders a skeleton, and a width taken then describes the
    // placeholder rather than the page. The main landmark and the `h1` clear
    // the spinner; the route's `ready` locator clears the skeleton and the
    // empty state, and where the widest thing on the page — a toolbar, a
    // table, a row of badges — is one interaction away, drives the page into
    // the state that actually renders it.
    if (needsMock) {
      await expect(page.locator("main#main-content")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    }
    if (ready) {
      await expect((await ready(page)).first()).toBeVisible();
    }

    // Compare against `clientWidth`, not `window.innerWidth`: on content
    // wider than the device, Chromium's mobile emulation can expand the
    // *layout* viewport (`innerWidth`) to fit it, and `scrollWidth` grows
    // right along with it — the two drift together and the check can never
    // fail. `document.documentElement.clientWidth` stays pinned to the
    // actual device width regardless, so it is the correct comparand for
    // "does this page require horizontal scrolling on a real phone."
    await expectNoOverflow(page);
  });
}

/**
 * The playlist-modifier track editor is only reachable after picking a
 * playlist, so the load-state overflow check above never sees it — and that
 * is exactly where the row actions live. Before Phase 6 the cluster was
 * `opacity-0 group-hover:opacity-100` below `sm`: invisible on a phone, and
 * still tappable, so a stray touch reordered or removed a track with nothing
 * on screen to explain it.
 *
 * Runs on **every** project, not just mobile: the fix is "visible at every
 * width", and a desktop hover-reveal would be just as much a regression in
 * the other direction. Only the overflow assertion is mobile-scoped.
 */
test("playlist-modifier row actions are visible and fit: /playlist-modifier/", async ({
  page,
}, testInfo) => {
  const isMobile = MOBILE_PROJECTS.includes(testInfo.project.name);

  await mockApi(page);
  await page.goto("/playlist-modifier/");

  await page.getByRole("button", { name: "Sample Playlist 1" }).click();

  const moreActions = page.getByRole("button", {
    name: "More actions for Sample Playlist Track 1",
  });
  await expect(moreActions).toBeVisible();
  // No hover, no focus — they are simply on.
  await expect(moreActions).toHaveCSS("opacity", "1");

  if (isMobile) {
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      scrollWidth,
      `scrollWidth=${scrollWidth} clientWidth=${clientWidth}`,
    ).toBeLessThanOrEqual(clientWidth);
  } else {
    // The inline reorder/remove trio only renders from `sm` up; it must be on
    // without a hover too.
    await expect(page.getByRole("button", { name: "Move down" }).first()).toHaveCSS(
      "opacity",
      "1",
    );
  }

  // The sheet replaces a popover that was clipped inside the virtual
  // scroller; on a phone it is also where reorder and remove live.
  await moreActions.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toHaveAccessibleName("Track actions");
  await expect(sheet.getByRole("button", { name: "Move down" })).toBeEnabled();
  await expect(sheet.getByRole("button", { name: "Move up" })).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "Remove from playlist" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(moreActions).toBeFocused();
});

/**
 * The growth tab strip is a real tablist now, and the other two panels are
 * only reachable through it — so neither the load-state overflow check nor
 * the axe audit sees them unless a test switches tabs.
 */
test("growth tabs: arrow keys move between panels and none of them overflow: /growth/", async ({
  page,
}, testInfo) => {
  test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), "mobile projects only");

  await mockApi(page);
  await page.goto("/growth/");

  const tablist = page.getByRole("tablist", { name: "Growth sections" });
  const discover = tablist.getByRole("tab", { name: "Discover" });
  const history = tablist.getByRole("tab", { name: "History" });
  const analytics = tablist.getByRole("tab", { name: "Analytics" });

  await expect(discover).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toBeVisible();

  await discover.focus();
  await page.keyboard.press("ArrowRight");
  await expect(history).toBeFocused();
  await expect(history).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowRight");
  await expect(analytics).toHaveAttribute("aria-selected", "true");

  // Wraps, so the strip is navigable in one direction alone.
  await page.keyboard.press("ArrowRight");
  await expect(discover).toHaveAttribute("aria-selected", "true");

  for (const { tab, settled } of [
    { tab: history, settled: "No sessions logged" },
    { tab: analytics, settled: "Not enough data yet" },
  ]) {
    await tab.click();
    // Each panel loads its own query, so measuring on the click measures the
    // panel before it has any content — the same pre-settle mistake the page
    // list above no longer makes.
    await expect(page.getByText(settled)).toBeVisible();
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      scrollWidth,
      `${await tab.textContent()}: scrollWidth=${scrollWidth} clientWidth=${clientWidth}`,
    ).toBeLessThanOrEqual(clientWidth);
  }
});

/**
 * A control clipped out of a `overflow: hidden` ancestor is invisible and
 * untappable while staying in the Tab order — and it never changes
 * `document.scrollWidth`, precisely because the overflow is hidden. So
 * neither the overflow check above nor axe can see it, and only a
 * per-element measurement catches it.
 *
 * This is what a long title used to do to the download chip: `truncate` on
 * the flex row made the bare title text `nowrap` with `min-width: auto`, so
 * it never shrank and pushed the `shrink-0` chip past the row's edge.
 */
test("playlist-modifier download control survives a long title: /playlist-modifier/", async ({
  page,
}, testInfo) => {
  test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), "mobile projects only");

  await mockApi(page);
  await page.goto("/playlist-modifier/");
  await page.getByRole("button", { name: "Sample Playlist 1" }).click();

  const download = page.getByRole("button", { name: `Download ${LONG_TRACK_TITLE}` });
  await expect(download).toBeVisible();

  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  const box = await download.boundingBox();
  expect(box, "the download control has no layout box at all").not.toBeNull();
  expect(
    Math.round(box!.x + box!.width),
    `download chip right edge ${Math.round(box!.x + box!.width)} > viewport ${clientWidth}`,
  ).toBeLessThanOrEqual(clientWidth);
  expect(box!.x, `download chip starts off-screen at x=${box!.x}`).toBeGreaterThanOrEqual(0);

  // The title gives up the width instead — it is the thing that truncates.
  await expect(page.getByText(LONG_TRACK_TITLE)).toBeVisible();
});

/**
 * `/link-resolver/`'s result — the stacked layout, the stat grid and the
 * embed — only exists after something resolves, so the page-list check above
 * measures the empty form and nothing else.
 */
test("link-resolver result does not overflow: /link-resolver/", async ({
  page,
}, testInfo) => {
  test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), "mobile projects only");

  await mockApi(page);
  await page.goto("/link-resolver/");

  await page
    .getByLabel("SoundCloud URL")
    .fill("https://soundcloud.com/testartist/sample-resolved-track");
  await page.getByRole("button", { name: "Resolve" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Sample Resolved Track" }),
  ).toBeVisible();

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `scrollWidth=${scrollWidth} clientWidth=${clientWidth}`).toBeLessThanOrEqual(
    clientWidth,
  );
});

/**
 * Both growth payloads are cast from `unknown`, so TypeScript vouched for
 * arrays it had never seen: a response missing a key took the whole tab down
 * on `.length` / `.every(...)`. The empty state is the honest answer, and it
 * has to fit a phone like everything else.
 *
 * Awaiting the response is load-bearing in both cases. While the query is in
 * flight `data` is `undefined`, which every version of this code handles; the
 * crash only happens on the re-render that receives `{}`. Assert before that
 * lands and the test passes with the bug still in place — verified by
 * reinstating each bug in turn.
 */
for (const { tab, endpoint, emptyText, panelControl } of [
  {
    tab: "History",
    endpoint: "/api/growth/history",
    emptyText: "No sessions logged",
    panelControl: "Check",
  },
  {
    tab: "Analytics",
    endpoint: "/api/growth/analytics",
    emptyText: "Not enough data yet",
    panelControl: null as string | null,
  },
]) {
  test(`growth ${tab.toLowerCase()} survives an empty response: /growth/`, async ({
    page,
  }, testInfo) => {
    test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), "mobile projects only");

    await mockApi(page);
    // Registered after `mockApi`, so it wins for this one endpoint.
    await page.route(`**${endpoint}`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );

    const crashes: string[] = [];
    page.on("pageerror", (error) => crashes.push(error.message));

    await page.goto("/growth/");

    const responded = page.waitForResponse((response) => response.url().includes(endpoint));
    await page.getByRole("tab", { name: tab }).click();
    await responded;

    await expect(page.getByText(emptyText)).toBeVisible();
    if (panelControl) {
      // The panel's own control rendered, so it was not replaced by an error
      // boundary.
      await expect(page.getByRole("button", { name: panelControl })).toBeVisible();
    }
    expect(crashes, crashes.join("\n")).toEqual([]);

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      scrollWidth,
      `scrollWidth=${scrollWidth} clientWidth=${clientWidth}`,
    ).toBeLessThanOrEqual(clientWidth);
  });
}

/**
 * The routes that open on a chooser: the list this sweep widened, wrapped and
 * un-stickied is one interaction past the landing state, so measuring the
 * chooser alone would not see it.
 */
test("no horizontal overflow: /playlist-to-likes/ with a playlist chosen", async ({
  page,
}, testInfo) => {
  test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), "mobile projects only");

  await mockApi(page);
  await page.goto("/playlist-to-likes/");
  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();
  await expect(page.getByRole("checkbox", { name: "Sample Track 1" })).toBeVisible();

  await expectNoOverflow(page);
});

test("no horizontal overflow: /genre-search/ results and add-to-playlist dialog", async ({
  page,
}, testInfo) => {
  test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), "mobile projects only");

  await mockApi(page);
  await page.goto("/genre-search/");
  await page.getByRole("button", { name: "house", exact: true }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("checkbox", { name: "Sample Track 1" }).check();

  await expectNoOverflow(page);

  await page.getByRole("button", { name: /Add to Playlist/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await expectNoOverflow(page);
});

test("no horizontal overflow: /downloads/ track list and selection mode", async ({
  page,
}, testInfo) => {
  test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), "mobile projects only");

  await mockApi(page);
  await page.goto("/downloads/");
  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();
  await expect(
    page.getByRole("button", { name: "Download Sample Track 1 (free download)" }),
  ).toBeVisible();

  await expectNoOverflow(page);

  await page.getByRole("button", { name: "Select to Remove" }).click();
  await expect(page.getByRole("checkbox", { name: "Sample Track 1" })).toBeVisible();

  await expectNoOverflow(page);
});

/**
 * `downloads` is the page in this batch that puts a `shrink-0` control beside
 * a truncating title, in all three of its row variants. A long title is what
 * makes a clipped control visible, and nothing else in either suite would
 * catch it.
 */
test("no clipped controls with a long title: /downloads/", async ({ page }, testInfo) => {
  test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), "mobile projects only");

  await mockApi(page);
  // Registered after `mockApi`, so it wins for this one path.
  // A pathname predicate, not a glob: the page now reads `?access=all`, and a
  // glob without a trailing `*` does not match a URL with a query string.
  await page.route((url) => url.pathname === "/api/playlists/1", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: 1,
        title: "Sample Playlist 1",
        tracks: [
          {
            id: 100,
            title:
              "An extremely long sample track title that could not possibly fit across a phone screen",
            user: { username: "an-extremely-long-sample-artist-username" },
            artwork_url: null,
            duration: 200000,
            downloadable: true,
            download_url: "https://api.soundcloud.com/tracks/soundcloud:tracks:100/download",
            permalink_url: "https://soundcloud.com/testartist/sample-track-1",
          },
        ],
      }),
    }),
  );

  await page.goto("/downloads/");
  await page.getByRole("button", { name: /Sample Playlist 1/ }).click();

  const plainRowDownload = page.getByRole("button", { name: /^Download An extremely long/ });
  await expect(plainRowDownload).toBeVisible();
  await expectFullyOnScreen(page, plainRowDownload, "plain row download control");
  await expectNoOverflow(page);

  // Selection mode moves the same control into `rightSlot`, beside a checkbox.
  await page.getByRole("button", { name: "Select to Remove" }).click();
  const selectionRowDownload = page.getByRole("button", { name: /^Download An extremely long/ });
  await expect(selectionRowDownload).toBeVisible();
  await expectFullyOnScreen(page, selectionRowDownload, "selection row download control");
  await expectFullyOnScreen(
    page,
    page.getByRole("checkbox").first(),
    "selection row checkbox",
  );
  await expectNoOverflow(page);
});

test("dashboard tap targets are at least 24x24: /dashboard/", async ({ page }, testInfo) => {
  test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), "mobile projects only");

  await mockApi(page);
  await page.goto("/dashboard/");
  await assertTapTargets(page, "main a, main button", 24);
});
