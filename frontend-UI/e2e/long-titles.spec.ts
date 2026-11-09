import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "./fixtures/api";

/**
 * A control clipped by an `overflow: hidden` ancestor is invisible to both of
 * the other checks: it does not contribute to `document.scrollWidth`, and axe
 * does not flag it. So a button can sit entirely off the right edge of a phone
 * — untappable — while the overflow test and the axe audit both pass.
 *
 * The usual cause is a row whose text does not shrink (`truncate` on the flex
 * *container* rather than on the text's own element inside a `min-w-0` box, so
 * the anonymous flex item's `min-width: auto` resolves to its nowrap
 * min-content width) pushing its `shrink-0` siblings past the edge. Row width
 * then comes from the title, not the viewport, which is why the same overflow
 * appears identically at 360, 390 and 430.
 *
 * These runs re-serve the same routes with titles far too long for any phone
 * and assert that every interactive element in `<main>` still has both edges
 * inside the viewport. The long text is also asserted to be present, so a
 * "fix" that simply drops the title cannot pass.
 */

const LONG =
  "Absolutely Enormous Extended Bootleg Rework Of A Track Whose Name Will Never Fit On A Phone Screen At Any Width 2026";
const LONG_USER = "testfollowing-with-an-extremely-long-display-name-that-never-fits";
/**
 * No spaces, so there is no break opportunity at all. `truncate` sets
 * `white-space: nowrap`, which already makes a spaced title's min-content its
 * full width — but an unbreakable one fails even without `truncate`, so it is
 * the stricter fixture and the one that catches a row that only *looks*
 * capped because its longest word happened to fit.
 */
const LONG_UNBREAKABLE = "Absolutely-Enormous-Extended-Bootleg-Rework-Whose-Name-Will-Never-Fit-2026";

function json(body: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

const LONG_PLAYLISTS = {
  collection: [1, 2, 3].map((id) => ({
    id,
    title: `${LONG} #${id}`,
    track_count: 12,
    artwork_url: null,
    permalink_url: "https://soundcloud.com/testuser/sets/long",
  })),
  total: 3,
};

const LONG_PLAYLIST_DETAIL = {
  id: 1,
  title: `${LONG} #1`,
  track_count: 3,
  artwork_url: null,
  tracks: [
    { id: 100, title: `${LONG} A`, user: { username: LONG_USER }, artwork_url: null, duration: 200000, access: "playable", streamable: true, blocked_at: null },
    { id: 101, title: `${LONG} B`, user: { username: LONG_USER }, artwork_url: null, duration: 200000, access: "preview", streamable: true, blocked_at: null },
    { id: 102, title: `${LONG} C`, user: { username: LONG_USER }, artwork_url: null, duration: 200000, access: "blocked", streamable: false, blocked_at: "2026-01-01T00:00:00.000Z" },
  ],
};

const LONG_SEARCH = {
  keywords: ["sample"],
  matches: [0, 1].map((i) => ({
    trackId: 100 + i,
    title: `${LONG} ${i}`,
    artist: LONG_USER,
    permalink_url: null,
    position: i,
    playlistId: 1,
    playlistTitle: `${LONG} #1`,
    keyword: "sample",
    matchedIn: "title",
  })),
  stats: { playlistsSearched: 1, tracksScanned: 12, matchCount: 2, uniqueTrackCount: 2, playlistsFailed: 0 },
  failed: [],
  capped: false,
  page: { limit: 20, offset: 0, returned: 2, total: 2, hasMore: false, from: 1, to: 2, stale: false, truncated: false },
};

const LONG_AUDIT = {
  page: { limit: 20, offset: 0, returned: 1, total: 1, hasMore: false, from: 1, to: 1, stale: false, truncated: false },
  failed: [],
  summary: { playlists: 1, tracks: 12, duplicates: 1, unavailable: 2, directDownloads: 0, purchaseLinks: 0, nearCap: 0 },
  playlists: [
    {
      id: 1,
      title: `${LONG} #1`,
      trackCount: 12,
      summary: { totalTracks: 12, duplicateTracks: 1, unavailableTracks: 2, directDownloads: 0, purchaseLinks: 0, nearCap: false },
    },
  ],
};

const LONG_FOLLOWINGS = {
  collection: [{ id: 200, username: LONG_USER, avatar_url: null, followers_count: 100, permalink_url: "https://soundcloud.com/x" }],
  next_href: null,
};

const LONG_FOLLOWED_PLAYLISTS = {
  collection: [{ id: 400, title: `${LONG} public`, user: { username: LONG_USER }, artwork_url: null, track_count: 9, permalink_url: "https://soundcloud.com/x/sets/y" }],
  next_href: null,
};

const LONG_RESOLVE_BATCH = {
  results: [
    {
      index: 0,
      url: `https://soundcloud.com/${LONG_USER}/${LONG.replace(/ /g, "-")}`,
      status: "ok",
      data: { type: "playlist", id: 1, title: `${LONG} #1`, user: { username: LONG_USER }, track_count: 12, permalink_url: "https://soundcloud.com/x/sets/y" },
    },
    {
      index: 1,
      url: `https://soundcloud.com/${LONG_USER}/${LONG.replace(/ /g, "-")}-missing`,
      status: "error",
      error: `Not found: ${LONG}`,
    },
  ],
  summary: { total: 2, ok: 1, error: 1 },
  meta: { version: "2" },
};

const LONG_CLONE = {
  playlists: [{ id: 11, title: `${LONG} (1/1)`, permalink_url: "https://soundcloud.com/x/sets/y" }],
  stats: { totalTracks: 12, numPlaylistsCreated: 1 },
};

const LONG_COMPARE = {
  summary: {
    playlistA: { id: 1, title: `${LONG} #1`, trackCount: 2 },
    playlistB: { id: 2, title: `${LONG} #2`, trackCount: 2 },
    overlapCount: 1,
    uniqueToACount: 1,
    uniqueToBCount: 1,
    overlapPercent: 33,
  },
  overlap: [{ id: 100, title: `${LONG} A`, user: { username: LONG_USER } }],
  uniqueToA: [{ id: 101, title: `${LONG} B`, user: { username: LONG_USER } }],
  uniqueToB: [{ id: 102, title: `${LONG} C`, user: { username: LONG_USER } }],
};

const LONG_LIKES = {
  collection: [0, 1].map((i) => ({
    id: 100 + i,
    title: `${LONG} ${i}`,
    user: { username: LONG_USER },
    artwork_url: null,
    duration: 200000,
    permalink_url: "https://soundcloud.com/x/y",
  })),
  next_href: null as string | null,
};

const LONG_RECENTLY_PLAYED = {
  collection: [0, 1].map((i) => ({
    id: 500 + i,
    // The unbreakable fixture lives here so at least one route exercises it.
    title: `${LONG_UNBREAKABLE} ${i}`,
    user: { username: LONG_USER },
    artwork_url: null,
    duration: 200000,
    permalink_url: "https://soundcloud.com/x/y",
  })),
  next_href: null as string | null,
};

const LONG_REPOSTS = {
  collection: [0, 1].map((i) => ({
    id: 300 + i,
    urn: `soundcloud:tracks:${300 + i}`,
    // One of each, because the row renders a type badge as a `shrink-0`
    // sibling of the title and that badge is the control most likely to be
    // pushed off the edge.
    resourceType: i === 1 ? "playlist" : "track",
    title: `${LONG} ${i}`,
    user: { username: LONG_USER },
    artwork_url: null,
    permalink_url: "https://soundcloud.com/x/y",
    created_at: "2026-09-01T12:00:00.000Z",
  })),
  has_more: false,
  total: 2,
};

/** The session payload the `/account` profile card renders. */
const LONG_SESSION = {
  userId: "u1",
  soundcloudId: 1000001,
  username: LONG_USER,
  displayName: LONG,
  avatarUrl: null as string | null,
};

/** Registered after `mockApi`, so it runs first and falls through for the rest. */
async function withLongTitles(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();

    if (method === "GET" && pathname === "/api/auth/me") return route.fulfill(json(LONG_SESSION));
    if (method === "GET" && pathname === "/api/likes/paged") return route.fulfill(json(LONG_LIKES));
    if (method === "GET" && pathname === "/api/reposts/paged") return route.fulfill(json(LONG_REPOSTS));
    if (method === "GET" && pathname === "/api/recently-played") return route.fulfill(json(LONG_RECENTLY_PLAYED));
    if (method === "GET" && pathname === "/api/playlists") return route.fulfill(json(LONG_PLAYLISTS));
    if (method === "GET" && /^\/api\/playlists\/\d+$/.test(pathname)) return route.fulfill(json(LONG_PLAYLIST_DETAIL));
    if (method === "GET" && pathname === "/api/playlists/search-tracks") return route.fulfill(json(LONG_SEARCH));
    if (method === "GET" && pathname === "/api/library/audit") return route.fulfill(json(LONG_AUDIT));
    if (method === "GET" && (pathname === "/api/followings" || pathname === "/api/followings/paged")) return route.fulfill(json(LONG_FOLLOWINGS));
    if (method === "GET" && /^\/api\/followings\/\d+\/(liked-)?playlists\/paged$/.test(pathname)) return route.fulfill(json(LONG_FOLLOWED_PLAYLISTS));
    if (method === "POST" && pathname === "/api/resolve/batch") return route.fulfill(json(LONG_RESOLVE_BATCH));
    if (method === "POST" && pathname === "/api/playlists/clone") return route.fulfill(json(LONG_CLONE));
    if (method === "POST" && pathname === "/api/playlists/compare") return route.fulfill(json(LONG_COMPARE));

    return route.fallback();
  });
}

/**
 * Every interactive element in `<main>` has both horizontal edges inside the
 * viewport. Zero-area elements are skipped (not rendered); everything else is
 * something a finger has to be able to reach.
 */
async function assertNothingClipped(page: Page): Promise<void> {
  const offscreen = await page
    .locator("main a, main button, main input, main select, main textarea, main [role=tab]")
    .evaluateAll((elements) => {
      const viewport = document.documentElement.clientWidth;
      return elements
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 50),
            left: Math.round(r.left),
            right: Math.round(r.right),
            viewport,
            area: r.width * r.height,
          };
        })
        .filter((box) => box.area > 0 && (box.right > box.viewport + 0.5 || box.left < -0.5));
    });

  expect(offscreen, JSON.stringify(offscreen, null, 2)).toEqual([]);

  await assertNoSidewaysScroller(page);
}

/**
 * No box inside `<main>` scrolls sideways.
 *
 * The check above only looks at interactive elements, so a row with no
 * right-side control slips past it completely — and that is not hypothetical.
 * A list written as `max-h-[60dvh] overflow-y-auto` is *also* horizontally
 * scrollable, because CSS computes a `visible` axis to `auto` as soon as the
 * other axis is not visible. An over-wide row inside such a list therefore
 * scrolls within it: `document.scrollWidth` stays at the viewport width, axe
 * sees nothing, and every control is technically on screen because the row
 * simply extends past the list's right edge instead of the page's.
 *
 * That is how a row measured at 1103px inside a 276px list passed all three
 * of this suite's other checks. The measurement that catches it is the
 * container's own `scrollWidth` against its `clientWidth`.
 *
 * Only `auto`/`scroll` boxes count. `overflow: hidden` is how `truncate`
 * itself works — an ellipsised title always has `scrollWidth > clientWidth`,
 * by design — so including hidden boxes would flag every correctly truncated
 * row on the page and make this assertion meaningless.
 */
async function assertNoSidewaysScroller(page: Page): Promise<void> {
  const scrollers = await page.locator("main *").evaluateAll((elements) =>
    elements
      .map((el) => {
        const overflowX = getComputedStyle(el).overflowX;
        return {
          cls: (el as HTMLElement).className?.toString().slice(0, 70) ?? "",
          overflowX,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          overflowBy: el.scrollWidth - el.clientWidth,
        };
      })
      .filter(
        (box) =>
          (box.overflowX === "auto" || box.overflowX === "scroll") && box.overflowBy > 1,
      ),
  );

  expect(scrollers, JSON.stringify(scrollers, null, 2)).toEqual([]);
}

interface Case {
  path: string;
  /** Drives the page to the state that renders the long-titled rows. */
  drive: (page: Page) => Promise<void>;
  /** Proof the long text is on the page, so dropping the title cannot pass. */
  proof: (page: Page) => Promise<void>;
}

const CASES: Case[] = [
  {
    path: "/playlist-keyword-search/",
    drive: async (page) => {
      await page.getByLabel("Keywords").fill("sample");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page.getByRole("heading", { name: "Matches" }).waitFor();
    },
    proof: async (page) => expect(page.locator("main")).toContainText(LONG),
  },
  {
    path: "/playlist-health-check/",
    drive: async (page) => {
      await page.getByRole("button", { name: new RegExp(LONG.slice(0, 30)) }).first().click();
      await page.getByRole("group", { name: "Filter tracks" }).waitFor();
    },
    proof: async (page) => expect(page.locator("main")).toContainText(LONG),
  },
  {
    path: "/library-audit/",
    drive: async (page) => {
      await page.getByRole("button", { name: "Run playlist audit" }).click();
      await page.getByRole("heading", { name: "Playlist findings" }).waitFor();
    },
    proof: async (page) => expect(page.locator("main")).toContainText(LONG),
  },
  {
    path: "/following-library/",
    drive: async (page) => {
      await page.getByRole("tab", { name: "Playlists", exact: true }).click();
      await page.getByRole("checkbox", { name: new RegExp(LONG.slice(0, 30)) }).waitFor();
    },
    proof: async (page) => expect(page.locator("main")).toContainText(LONG_USER),
  },
  {
    path: "/link-resolver/",
    drive: async (page) => {
      await page.getByLabel("SoundCloud links").fill("https://soundcloud.com/a/b\nhttps://soundcloud.com/a/c");
      await page.getByRole("button", { name: "Resolve 2 links" }).click();
      await page.getByRole("heading", { name: "Results" }).waitFor();
    },
    proof: async (page) => expect(page.locator("main")).toContainText(LONG),
  },
  {
    path: "/playlist-compare/",
    drive: async (page) => {
      await page.getByRole("button", { name: /^Playlist A/ }).click();
      await page.getByRole("dialog").getByRole("list", { name: "Playlists" }).getByRole("button").nth(0).click();
      await expect(page.getByRole("dialog")).toBeHidden();
      await page.getByRole("button", { name: /^Playlist B/ }).click();
      await page.getByRole("dialog").getByRole("list", { name: "Playlists" }).getByRole("button").nth(1).click();
      await expect(page.getByRole("dialog")).toBeHidden();
      await page.getByRole("button", { name: "Compare" }).click();
      await page.getByRole("heading", { name: /In both playlists/ }).waitFor();
    },
    proof: async (page) => expect(page.locator("main")).toContainText(LONG),
  },
  {
    path: "/playlist-cloner/",
    drive: async (page) => {
      await page.getByLabel("Original playlist URL").fill("https://soundcloud.com/a/sets/b");
      await page.getByRole("button", { name: "Clone Playlist" }).click();
      await page.getByRole("heading", { name: "Cloning Complete" }).waitFor();
    },
    proof: async (page) => expect(page.locator("main")).toContainText(LONG),
  },
  {
    path: "/export/playlists/",
    drive: async (page) => {
      // The shared picker's rows are radios, not buttons.
      await page.getByRole("button", { name: new RegExp(LONG.slice(0, 30)) }).first().click();
      await page.getByRole("button", { name: "Load playlist tracks" }).click();
      await page.getByText(/^[\d,]+ tracks? ready$/).waitFor();
    },
    proof: async (page) => expect(page.locator("main")).toContainText(LONG),
  },

  // ── The pages whose batches merged before this check existed ────────────
  // Their rows put a `shrink-0` control beside a title — a type badge, an
  // "Active:" pill, a per-row action — which is the arrangement that clips.
  // They were swept and are correct today; these keep them that way, because
  // the regression is silent in both of the other checks.
  {
    path: "/like-manager/",
    drive: async (page) => {
      await page.getByRole("checkbox", { name: new RegExp(LONG.slice(0, 30)) }).first().waitFor();
    },
    proof: async (page) => expect(page.locator("main")).toContainText(LONG),
  },
  {
    path: "/following-manager/",
    drive: async (page) => {
      await page.getByRole("checkbox", { name: new RegExp(LONG_USER.slice(0, 30)) }).first().waitFor();
    },
    proof: async (page) => expect(page.locator("main")).toContainText(LONG_USER),
  },
  {
    path: "/repost-manager/",
    drive: async (page) => {
      await page.getByRole("checkbox", { name: new RegExp(LONG.slice(0, 30)) }).first().waitFor();
    },
    proof: async (page) => expect(page.locator("main")).toContainText(LONG),
  },
  {
    path: "/combine/",
    drive: async (page) => {
      // Selected, so the selection banner and its actions are measured too —
      // the row is only half of what has to fit.
      await page.getByRole("checkbox", { name: new RegExp(LONG.slice(0, 30)) }).first().check();
    },
    proof: async (page) => expect(page.locator("main")).toContainText(LONG),
  },
  // ── Routes the review measured as over-wide on the pre-merge tree ──────
  // (`/following-library/` already had a case further up, so only these two
  //  are new.)
  // They are NOT over-wide on this one: Task 16a put `min-w-0` on
  // `SelectableRow`'s root, which is where the fix belongs, and that capped
  // every row these three render. Kept as coverage rather than as a fix —
  // they are cheap, and the primitive they depend on lives in another task's
  // file, so a regression there should surface here rather than in review.
  {
    path: "/recently-played/",
    drive: async (page) => {
      await page.getByRole("checkbox", { name: new RegExp(LONG_UNBREAKABLE.slice(0, 30)) }).first().waitFor();
    },
    proof: async (page) => expect(page.locator("main")).toContainText(LONG_UNBREAKABLE),
  },
  {
    path: "/growth/",
    drive: async (page) => {
      await page.getByRole("checkbox", { name: new RegExp(LONG_USER.slice(0, 30)) }).first().waitFor();
    },
    proof: async (page) => expect(page.locator("main")).toContainText(LONG_USER),
  },
  {
    path: "/account/",
    drive: async (page) => {
      // The profile card is the row at risk: a display name beside a
      // `shrink-0` avatar.
      await page.getByText("SoundCloud id 1000001").waitFor();
    },
    proof: async (page) => expect(page.locator("main")).toContainText(LONG),
  },
];

for (const { path, drive, proof } of CASES) {
  test(`a title too long for the screen clips nothing: ${path}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "the failure mode is a phone-width one");

    await mockApi(page);
    await withLongTitles(page);
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await drive(page);
    await proof(page);
    await assertNothingClipped(page);
  });
}
