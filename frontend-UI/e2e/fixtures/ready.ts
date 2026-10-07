import type { Locator, Page } from "@playwright/test";

/**
 * Per-route "the real content is on screen" locators, shared by the axe spec
 * and the overflow spec so both settle on the same thing.
 *
 * Waiting for the `h1` is necessary but not sufficient. Three ways a
 * protected route shows a heading while its own content does not exist yet:
 *
 *  - `AppLayout` renders a hydration/auth spinner first (no h1 — the h1 wait
 *    covers this one);
 *  - a route with a `loading.tsx` renders that file's own `PageHeader` while
 *    it suspends, so the h1 is the *skeleton's*;
 *  - an endpoint the fixtures do not answer leaves an `EmptyState`, which
 *    also has a heading.
 *
 * In every case an audit or a measurement taken then describes a placeholder.
 * A route listed here names something only its settled content renders.
 *
 * An entry may also *drive* the page — click, fill, select — when the state
 * worth auditing or measuring is one interaction away: a page that opens on a
 * chooser or an "run it" button keeps its toolbar, its rows and its badges out
 * of the document until then, and the widest thing on it is never in the DOM
 * when `scrollWidth` is read. Hence the `Promise<Locator>` half of the return
 * type; return the locator that only exists once that state has arrived.
 *
 * Every `(app)` route now has an entry. Keep it that way: a route with no
 * entry is only guaranteed to have got past the spinner, and an audit or a
 * width measured then is evidence about the shell rather than the page.
 */
export type ReadyLocator = (page: Page) => Locator | Promise<Locator>;

export const READY: Record<string, ReadyLocator> = {
  // `dashboard/loading.tsx` skeletons the header instead of rendering a
  // `PageHeader`, so the h1 alone would be a fair gate here — but the tool
  // search only exists on the loaded page, which is the stronger signal.
  "/dashboard/": (page) => page.getByLabel("Search tools"),
  // Into the editor, not the picker. The picker is a grid of buttons and was
  // all either spec ever saw; everything this page is actually for — the
  // track rows with their download chips, Buy links and per-row actions, the
  // filter group, the reorder controls and the save bar — lives behind that
  // first click, so neither the audit nor the width measurement described it.
  // Same shape as the other chooser-fronted routes below.
  "/playlist-modifier/": async (page) => {
    await page.getByRole("button", { name: "Sample Playlist 1" }).click();
    return page.getByRole("group", { name: "Filter tracks" });
  },
  // Suspends on `/api/followings`, so the h1 alone resolves against
  // `growth/loading.tsx`'s own PageHeader while the skeleton is up.
  "/growth/": (page) => page.getByRole("checkbox", { name: "testfollowing1" }),
  // This route's settled load state is its form.
  "/link-resolver/": (page) => page.getByLabel("SoundCloud URL"),
  // The track list, from `/api/likes/paged`.
  "/likes-to-playlist/": (page) => page.getByRole("checkbox", { name: "Sample Track 1" }),
  // Opens on a playlist chooser, from `/api/playlists`.
  "/playlist-to-likes/": (page) => page.getByRole("button", { name: /Sample Playlist 1/ }),
  // The track list, from `/api/recently-played`.
  "/recently-played/": (page) => page.getByRole("checkbox", { name: "Sample Track 1" }),
  // The track list, from `/api/activities`.
  "/activity-to-playlist/": (page) => page.getByRole("checkbox", { name: "Sample Track 1" }),
  // Opens on a source chooser, from `/api/playlists`.
  "/downloads/": (page) => page.getByRole("button", { name: /Sample Playlist 1/ }),
  "/rekordbox-gaps/": (page) => page.getByText("Not available on this account"),
  // The "no search yet" empty state is not what this page is: the toolbar,
  // the match rows and their badges only exist after a search, so run one.
  "/playlist-keyword-search/": async (page) => {
    await page.getByLabel("Keywords").fill("sample");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    return page.getByRole("heading", { name: "Matches" });
  },
  // The scan results — summary bar, filter pills, per-row badges — only
  // exist once a playlist is picked.
  "/playlist-health-check/": async (page) => {
    await page.getByRole("button", { name: /Sample Playlist 1/ }).click();
    return page.getByRole("group", { name: "Filter tracks" });
  },
  // The format select and the preview only exist after the list is loaded.
  "/export/likes/": async (page) => {
    await page.getByRole("button", { name: "Load liked tracks" }).click();
    return page.getByText(/^[\d,]+ tracks? ready$/);
  },
  "/export/playlists/": async (page) => {
    await page.getByRole("button", { name: /Sample Playlist 1/ }).click();
    await page.getByRole("button", { name: "Load playlist tracks" }).click();
    return page.getByText(/^[\d,]+ tracks? ready$/);
  },
  "/export/followings/": async (page) => {
    await page.getByRole("button", { name: "Load followings" }).click();
    return page.getByText(/^[\d,]+ items? ready$/);
  },
  "/export/reposts/": async (page) => {
    await page.getByRole("button", { name: "Load reposts" }).click();
    return page.getByText(/^[\d,]+ items? ready$/);
  },
  // Clone something, so the result panel and its two stat cards are audited
  // rather than just the form.
  "/playlist-cloner/": async (page) => {
    await page
      .getByLabel("Original playlist URL")
      .fill("https://soundcloud.com/testuser/sets/sample-playlist-1");
    await page.getByRole("button", { name: "Clone Playlist" }).click();
    return page.getByRole("heading", { name: "Cloning Complete" });
  },
  // The metrics and the three track sections only exist after a comparison.
  "/playlist-compare/": async (page) => {
    await page.getByLabel("Playlist A").selectOption({ index: 1 });
    await page.getByLabel("Playlist B").selectOption({ index: 2 });
    await page.getByRole("button", { name: "Compare" }).click();
    return page.getByRole("heading", { name: /In both playlists/ });
  },
  // Resolve something: the filters, the row actions and the error styling
  // only exist once there are results.
  "/batch-link-resolver/": async (page) => {
    await page
      .getByLabel("SoundCloud URLs (one per line)")
      .fill("https://soundcloud.com/testartist/sample-track-1");
    await page.getByRole("button", { name: "Resolve All" }).click();
    return page.getByRole("heading", { name: "Results" });
  },
  // Switch to the Playlists tab: it exercises the tab strip, the tabpanel
  // and the selectable playlist rows in one go, and none of that exists
  // while the page is still the "select a followed user" empty state.
  "/following-library/": async (page) => {
    await page.getByRole("tab", { name: "Playlists", exact: true }).click();
    return page.getByRole("checkbox", { name: "Sample Public Playlist 1" });
  },
  // Nothing is fetched until the audit is run, so run it: the metric cards,
  // the findings rows and the pager are all downstream of that click.
  "/library-audit/": async (page) => {
    await page.getByRole("button", { name: "Run playlist audit" }).click();
    return page.getByRole("heading", { name: "Playlist findings" });
  },
  // ── The rest of the `(app)` group ──────────────────────────────────────
  // These had no entry, so their audits and overflow numbers were settled by
  // the `h1` alone and could still have been describing a skeleton or an
  // empty state. One line each, naming something only the loaded page has.

  // The liked-track list, from `/api/likes/paged`.
  "/like-manager/": (page) => page.getByRole("checkbox", { name: "Sample Track 1" }),
  // The followings list, from `/api/followings/paged`.
  "/following-manager/": (page) => page.getByRole("checkbox", { name: "testfollowing1" }),
  // The reposts list, from `/api/reposts/paged`.
  "/repost-manager/": (page) => page.getByRole("checkbox", { name: /Sample Repost 1/ }),
  // The source-playlist list, from `/api/playlists`.
  "/combine/": (page) => page.getByRole("checkbox", { name: /Sample Playlist 1/ }),
  // The profile card, which is rendered from the session payload — so this
  // also proves `/api/auth/me` resolved rather than the shell merely mounting.
  "/account/": (page) => page.getByText("SoundCloud id 1000001"),
  // The form's own textarea. The `h1` here belongs to `PageHeader`, which is
  // rendered outside the `Suspense` boundary `FeedbackForm` sits behind — so
  // the heading is on screen while the form is still the "Loading the
  // feedback form…" fallback, and an audit or a width taken then measures
  // that sentence.
  "/feedback/": (page) =>
    page.getByRole("textbox", { name: /What happened, or what would you like\?/ }),
  // The genre chips. This page's landing state is a static filter form, so
  // the `h1` was arguably enough — but "arguably enough" is what the other
  // routes on this list also looked like, and a control costs nothing to
  // name. Its results and dialog have their own dedicated tests.
  "/genre-search/": (page) => page.getByRole("button", { name: "house", exact: true }),
  // A hub of links, and the same reasoning: the heading is rendered by the
  // layout, one of the links is only rendered by this page.
  "/export/": (page) => page.getByRole("link", { name: /Export Likes/i }),
};
