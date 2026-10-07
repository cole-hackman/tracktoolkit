import type { Page } from "@playwright/test";

/**
 * Mocked `/api/*` responses for the e2e harness.
 *
 * Every value here is obviously fake ("Test User", "Sample Playlist 1") —
 * never real account data, so a recording or a diff of this file never
 * carries anything that needs to be treated as sensitive.
 *
 * Shapes mirror what `src/lib/queries.ts` / `src/lib/progressive.ts` ask
 * for, not necessarily the exact SoundCloud-wrapped shape the live backend
 * returns for every route — this is a fixture for exercising pages and
 * running axe against them, not a contract test of the API.
 */

const FAKE_USER = {
  userId: "u1",
  // The account page prints this back as "SoundCloud id N"; it is the same
  // fake numeric id FAKE_ME carries.
  soundcloudId: 1000001,
  username: "testuser",
  displayName: "Test User",
  avatarUrl: null as string | null,
};

const FAKE_ME = {
  id: 1000001,
  username: "testuser",
  full_name: "Test User",
  avatar_url: null as string | null,
  followers_count: 12,
  followings_count: 8,
  likes_count: 5,
  track_count: 0,
  playlist_count: 3,
  permalink_url: "https://soundcloud.com/testuser",
};

const FAKE_DASHBOARD_SUMMARY = {
  followers_count: 12,
  followings_count: 8,
  likes_count: 5,
  playlist_count: 3,
};

const FAKE_PLAYLISTS = {
  collection: [
    { id: 1, title: "Sample Playlist 1", track_count: 12, artwork_url: null, permalink_url: "https://soundcloud.com/testuser/sets/sample-playlist-1" },
    { id: 2, title: "Sample Playlist 2", track_count: 40, artwork_url: null, permalink_url: "https://soundcloud.com/testuser/sets/sample-playlist-2" },
    { id: 3, title: "Sample Playlist 3", track_count: 7, artwork_url: null, permalink_url: "https://soundcloud.com/testuser/sets/sample-playlist-3" },
  ],
  total: 3,
};

/**
 * A title long enough that it cannot fit a 360px row alongside the artwork
 * and the download chip. Real playlists are full of titles this long
 * ("Artist - Track (Extended Mix) [Label]"), and a short fixture title hid a
 * clipping bug that only shows up once the title has to compete for width.
 */
const LONG_TRACK_TITLE = "Sample Playlist Track 4 With A Deliberately Very Long Title";

/**
 * `GET /api/playlists/:id` — the one playlist detail every tool that opens on
 * a playlist chooser reads, so it has to cover all of them at once.
 *
 * Rows 1-4 are the track-editor state of /playlist-modifier/, where the row
 * action cluster lives: three short rows cover first/middle/last (move-up and
 * move-down disabled states) and the fourth is the long-title case.
 *
 * Rows 5-6 are /downloads/'s two download flavours — "Sample Track 1" carries
 * a direct `download_url`, "Sample Track 2" a Hypeddit `purchase_url` — and
 * are also the rows /playlist-to-likes/ selects by name. They are deliberately
 * named differently from the "Sample Playlist Track N" rows above so that
 * neither set is a substring of the other and `getByRole` stays unambiguous.
 *
 * The health states /playlist-health-check/ needs — one `preview`, one
 * `blocked`, so its summary bar, filter pills and per-row badges are all
 * really on the page — ride on rows 2 and 3 rather than on two extra rows.
 * Row count is load-bearing elsewhere: the export cards preview ten lines
 * inside a `max-h-48` box, and at nine lines that box starts to scroll, which
 * is a `scrollable-region-focusable` violation the /export/playlists/ audit
 * catches. Six rows is the largest this fixture can be without every export
 * audit reporting an app bug that has nothing to do with the page under test.
 */
const FAKE_PLAYLIST_DETAIL = {
  id: 1,
  title: "Sample Playlist 1",
  track_count: 6,
  artwork_url: null as string | null,
  permalink_url: "https://soundcloud.com/testuser/sets/sample-playlist-1",
  tracks: [
    ...Array.from({ length: 4 }, (_, i) => ({
      id: 300 + i,
      title: i === 3 ? LONG_TRACK_TITLE : `Sample Playlist Track ${i + 1}`,
      user: { username: "testartist" },
      artwork_url: null as string | null,
      duration: 210000,
      downloadable: i === 0 || i === 3,
      download_url:
        i === 0 || i === 3
          ? `https://api.soundcloud.com/tracks/soundcloud:tracks:${300 + i}/download`
          : undefined,
      purchase_url: undefined as string | undefined,
      permalink_url: `https://soundcloud.com/testartist/sample-playlist-track-${i + 1}`,
      access: i === 1 ? "preview" : i === 2 ? "blocked" : "playable",
      streamable: i !== 2,
      blocked_at: i === 2 ? "2026-01-01T00:00:00.000Z" : null,
    })),
    {
      id: 100,
      title: "Sample Track 1",
      user: { username: "testartist" },
      artwork_url: null as string | null,
      duration: 200000,
      downloadable: true,
      download_url: "https://api.soundcloud.com/tracks/soundcloud:tracks:100/download",
      purchase_url: undefined as string | undefined,
      permalink_url: "https://soundcloud.com/testartist/sample-track-1",
      access: "playable",
      streamable: true,
      blocked_at: null as string | null,
    },
    {
      id: 101,
      title: "Sample Track 2",
      user: { username: "testartist" },
      artwork_url: null as string | null,
      duration: 180000,
      downloadable: false,
      download_url: undefined as string | undefined,
      purchase_url: "https://hypeddit.com/example/sample-track-2",
      permalink_url: "https://soundcloud.com/testartist/sample-track-2",
      access: "playable",
      streamable: true,
      blocked_at: null as string | null,
    },
  ],
};

export { LONG_TRACK_TITLE, FAKE_PLAYLIST_DETAIL };

const FAKE_LIKES_PAGED = {
  collection: Array.from({ length: 5 }, (_, i) => ({
    id: 100 + i,
    title: `Sample Track ${i + 1}`,
    user: { username: "testartist" },
    artwork_url: null,
    duration: 200000,
    permalink_url: `https://soundcloud.com/testartist/sample-track-${i + 1}`,
  })),
  next_href: null as string | null,
};

/** `GET /api/recently-played` — the shape `useRecentlyPlayedQuery` reads. */
const FAKE_RECENTLY_PLAYED = {
  collection: Array.from({ length: 3 }, (_, i) => ({
    id: 300 + i,
    title: `Sample Track ${i + 1}`,
    user: { username: "testartist" },
    artwork_url: null,
    duration: 200000,
    permalink_url: `https://soundcloud.com/testartist/sample-track-${i + 1}`,
  })),
};

/**
 * `GET /api/activities` — one plain track activity and one repost. The repost
 * carries a URN-shaped `reposter` with no username, which is the case the row
 * subtitle must not print as a bare numeric id.
 */
const FAKE_ACTIVITIES = {
  collection: [
    {
      type: "track",
      created_at: "2026-09-20T12:00:00.000Z",
      reposter: null,
      origin: {
        id: 400,
        title: "Sample Track 1",
        user: { username: "testartist" },
        artwork_url: null,
        duration: 200000,
        permalink_url: "https://soundcloud.com/testartist/sample-track-1",
      },
    },
    {
      type: "track-repost",
      created_at: "2026-09-19T12:00:00.000Z",
      reposter: "soundcloud:users:1000002",
      origin: {
        id: 401,
        title: "Sample Track 2",
        user: { username: "testartist" },
        artwork_url: null,
        duration: 180000,
        permalink_url: "https://soundcloud.com/testartist/sample-track-2",
      },
    },
  ],
};

/** `GET /api/tracks/search` — genre-search results. */
const FAKE_TRACK_SEARCH = {
  collection: Array.from({ length: 2 }, (_, i) => ({
    id: 500 + i,
    title: `Sample Track ${i + 1}`,
    user: { username: "testartist" },
    artwork_url: null,
    duration: 200000,
    genre: "house",
    permalink_url: `https://soundcloud.com/testartist/sample-track-${i + 1}`,
  })),
  next_href: null as string | null,
};

const FAKE_FOLLOWINGS_PAGED = {
  collection: Array.from({ length: 3 }, (_, i) => ({
    id: 200 + i,
    username: `testfollowing${i + 1}`,
    avatar_url: null,
    followers_count: 100 + i,
    track_count: 10 + i,
    permalink_url: `https://soundcloud.com/testfollowing${i + 1}`,
  })),
  next_href: null as string | null,
};

/**
 * `GET /api/followers/paged` — the followers side of the following manager.
 * Only the first fake following is also a follower, so the "Not Following
 * Back" filter has something to actually filter and the toggle leaves its
 * disabled-while-loading state.
 */
const FAKE_FOLLOWERS_PAGED = {
  collection: [
    {
      id: 200,
      username: "testfollowing1",
      avatar_url: null,
      followers_count: 100,
      track_count: 10,
      permalink_url: "https://soundcloud.com/testfollowing1",
    },
  ],
  next_href: null as string | null,
};

/**
 * `GET /api/reposts/paged` — offset-paged, so the shape is `has_more` rather
 * than a cursor. One playlist among the tracks, because the repost row
 * renders a different badge and fallback icon per `resourceType` and an
 * audit that only ever saw tracks would miss half the row.
 */
const FAKE_REPOSTS_PAGED = {
  collection: Array.from({ length: 4 }, (_, i) => ({
    id: 300 + i,
    urn: `soundcloud:tracks:${300 + i}`,
    resourceType: i === 1 ? "playlist" : "track",
    title: `Sample Repost ${i + 1}`,
    user: { username: "testartist" },
    artwork_url: null as string | null,
    permalink_url: `https://soundcloud.com/testartist/sample-repost-${i + 1}`,
    created_at: "2026-09-01T12:00:00.000Z",
  })),
  has_more: false,
  total: 4,
};

/** What `POST /api/feedback` answers with on a 201 — id and timestamp only. */
const FAKE_FEEDBACK_CREATED = {
  id: "fb_1",
  createdAt: "2026-09-22T12:00:00.000Z",
};

/** `GET /api/feedback/mine` — empty, so the "Your recent reports" list stays
 *  out of the way of the submit flow under test. */
const FAKE_FEEDBACK_MINE = { items: [] as unknown[] };

/**
 * A stand-in for `GET /api/auth/export`. Shaped like the real payload's
 * envelope but with one obviously-fake row per collection — the account page
 * only navigates to this route, so nothing renders it.
 */
const FAKE_EXPORT = {
  schemaVersion: 1,
  generatedAt: "2026-09-22T12:00:00.000Z",
  user: {
    id: "u1",
    soundcloudId: 1000001,
    username: "testuser",
    displayName: "Test User",
    avatarUrl: null as string | null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastLoginAt: "2026-09-22T11:00:00.000Z",
  },
  token: { expiresAt: "2026-09-23T11:00:00.000Z" },
  operationLogs: [] as unknown[],
  growthActions: [] as unknown[],
  feedback: [] as unknown[],
  rebrandVotes: [] as unknown[],
  surveyResponses: [] as unknown[],
  betaSignups: [] as unknown[],
  libraryCacheState: [] as unknown[],
  libraryCachePages: [] as unknown[],
};

const FAKE_GROWTH_LIMITS = {
  dailyCap: 50,
  used24h: 0,
  remaining: 50,
  cooldownRemainingMs: 0,
};

const FAKE_GROWTH_STATS = {
  totalFollowed: 0,
  totalLiked: 0,
  followedBackRate: 0,
  activeFollows: 0,
  reversedFollows: 0,
  uncheckedFollows: 0,
};

/**
 * `POST /api/growth/discover`. Answers by whether the body carries a `genre`,
 * so one handler serves both the focused scan and "scan again with any genre".
 */
function growthDiscoverResponse(genre: string | undefined) {
  const user = (id: number, name: string) => ({
    id,
    username: name,
    avatar_url: "",
    permalink_url: `https://soundcloud.com/${name}`,
    followers_count: 420,
    followings_count: 300,
    track_count: 6,
  });
  const track = (id: number, title: string) => ({
    id,
    title,
    artwork_url: "",
    likes_count: 1234,
    playback_count: 56000,
    permalink_url: `https://soundcloud.com/x/${id}`,
    created_at: "2026-09-01T00:00:00Z",
  });
  const base = {
    inspirationUsers: 1,
    candidatesScanned: 480,
    afterDedup: 350,
    seedGenres: ["house", "deep house"],
    durationMs: 21000,
    sampleCapPerSeed: 1000,
    sampledFollowers: false,
    partial: false,
  };
  if (genre) {
    return {
      suggestions: [
        {
          user: user(7001, "housefocus-one"),
          score: 78,
          scoreLabel: "high",
          signals: { followBackRatio: 0.7, sharedInspirationCount: 1, isRelatedArtist: true, isCreator: true, genreAffinity: 1 },
          genres: ["deep house", "house", "groove"],
          suggestedTrack: track(9001, "Warehouse Sunrise Extended Mix"),
        },
        {
          user: user(7002, "housefocus-two"),
          score: 61,
          scoreLabel: "medium",
          signals: { followBackRatio: 1.1, sharedInspirationCount: 1, isRelatedArtist: false, isCreator: true, genreAffinity: 0.5 },
          genres: ["tech house"],
          suggestedTrack: track(9002, "Late Night Tools"),
        },
      ],
      stats: {
        ...base,
        suggestionsReturned: 2,
        genreFocus: genre,
        genreChecked: 150,
        genreMatched: 2,
        genreUnknown: 4,
        genreSkipped: 0,
      },
    };
  }
  return {
    suggestions: [
      {
        user: user(7003, "anygenre-one"),
        score: 55,
        scoreLabel: "medium",
        signals: { followBackRatio: 0.9, sharedInspirationCount: 1, isRelatedArtist: false, isCreator: true, genreAffinity: 0.5 },
        genres: ["country"],
        suggestedTrack: null,
      },
    ],
    stats: { ...base, suggestionsReturned: 1, genreFocus: null, genreChecked: null, genreMatched: null, genreUnknown: null, genreSkipped: null },
  };
}

/**
 * `POST /api/resolve?v=2` — the result state of /link-resolver/, which is the
 * half of that page with the layout, the copy buttons and the embed in it.
 * Without this the page only ever shows its empty form.
 */
const FAKE_RESOLVE = {
  data: {
    type: "track",
    kind: "track",
    id: 400,
    title: "Sample Resolved Track",
    username: "testartist",
    user: { id: 1000002, username: "testartist" },
    permalink_url: "https://soundcloud.com/testartist/sample-resolved-track",
    artwork_url: null as string | null,
    duration_ms: 214000,
    description: "An obviously fake track used by the e2e harness.",
    tag_list: "house techno",
    created_at: "2026-01-02T03:04:05Z",
    playback_count: 1234,
    likes_count: 56,
    reposts_count: 7,
    comment_count: 8,
  },
  meta: {
    version: "2",
    source_url: "https://soundcloud.com/testartist/sample-resolved-track",
    resolved_at: "2026-09-22T12:00:00.000Z",
    cached: false,
  },
};

/** `GET /api/growth/history` — the empty state of the Campaign History tab. */
const FAKE_GROWTH_HISTORY = {
  actions: [] as unknown[],
  sessions: [] as unknown[],
};

/** `GET /api/growth/analytics` — the empty state of the Analytics tab. */
const FAKE_GROWTH_ANALYTICS = {
  perSeed: [] as unknown[],
  followBackCurve: [
    { bucket: "0-24h", followedBack: 0, notFollowedBack: 0 },
    { bucket: "1-3d", followedBack: 0, notFollowedBack: 0 },
  ],
  totalFollows: 0,
};

/**
 * Rebrand announcement gate — matches the keys/value `src/lib/rebrand.ts`
 * checks, so the one-time modal and the site-wide banner both treat the
 * current announcement as already acknowledged and stay out of the way of
 * whatever the test is actually looking at.
 */
const REBRAND_ANNOUNCEMENT_VERSION = "2026-09-track-toolkit";
const REBRAND_BANNER_KEY = "track-toolkit-rebrand-banner";
const REBRAND_ACK_KEY = "track-toolkit-rebrand-ack";

/** Matches `src/lib/whatsNew.ts` — keeps the unrelated "what's new" modal
 *  from also covering the page during a dashboard run. */
const WHATS_NEW_VERSION = "2026-07-growth";
const WHATS_NEW_DISMISS_KEY = "sc-toolkit-whatsnew-dismissed";

/**
 * `GET /api/playlists/search-tracks`. Two of the three rows are the same track
 * in the same playlist, which is what makes the "x2 in this playlist" badge —
 * the widest thing on a match row — part of what gets audited and measured.
 */
const FAKE_SEARCH_TRACKS = {
  keywords: ["sample"],
  matches: [
    {
      trackId: 100,
      title: "Sample Track 1",
      artist: "testartist",
      permalink_url: "https://soundcloud.com/testartist/sample-track-1",
      position: 0,
      playlistId: 1,
      playlistTitle: "Sample Playlist 1",
      keyword: "sample",
      matchedIn: "title",
    },
    {
      trackId: 101,
      title: "Sample Track 2",
      artist: "testartist",
      permalink_url: null,
      position: 1,
      playlistId: 1,
      playlistTitle: "Sample Playlist 1",
      keyword: "sample",
      matchedIn: "title",
    },
    {
      trackId: 101,
      title: "Sample Track 2",
      artist: "testartist",
      permalink_url: null,
      position: 4,
      playlistId: 1,
      playlistTitle: "Sample Playlist 1",
      keyword: "sample",
      matchedIn: "title",
    },
  ],
  stats: {
    playlistsSearched: 3,
    tracksScanned: 59,
    matchCount: 3,
    uniqueTrackCount: 2,
    playlistsFailed: 0,
  },
  failed: [] as unknown[],
  capped: false,
  page: {
    limit: 20,
    offset: 0,
    returned: 3,
    total: 3,
    hasMore: false,
    from: 1,
    to: 3,
    stale: false,
    truncated: false,
  },
};

/**
 * `GET /api/library/audit`. One playlist with findings and one without, so
 * both verdicts ("Issues found" / "Healthy") are on the page when it is
 * audited.
 */
const FAKE_LIBRARY_AUDIT = {
  page: {
    limit: 20,
    offset: 0,
    returned: 2,
    total: 2,
    hasMore: false,
    from: 1,
    to: 2,
    stale: false,
    truncated: false,
  },
  failed: [] as unknown[],
  summary: {
    playlists: 2,
    tracks: 52,
    duplicates: 1,
    unavailable: 2,
    directDownloads: 3,
    purchaseLinks: 1,
    nearCap: 0,
  },
  playlists: [
    {
      id: 1,
      title: "Sample Playlist 1",
      trackCount: 12,
      summary: {
        totalTracks: 12,
        duplicateTracks: 1,
        unavailableTracks: 2,
        directDownloads: 3,
        purchaseLinks: 1,
        nearCap: false,
      },
    },
    {
      id: 2,
      title: "Sample Playlist 2",
      trackCount: 40,
      summary: {
        totalTracks: 40,
        duplicateTracks: 0,
        unavailableTracks: 0,
        directDownloads: 0,
        purchaseLinks: 0,
        nearCap: false,
      },
    },
  ],
};

/**
 * `GET /api/followings/:id/likes|playlists|liked-playlists/paged` — one page of
 * a followed user's public library, so Following Library renders real rows in
 * every tab instead of the "no public liked tracks" empty state.
 */
const FAKE_FOLLOWED_LIKES_PAGED = {
  collection: Array.from({ length: 3 }, (_, i) => ({
    id: 300 + i,
    title: `Sample Public Track ${i + 1}`,
    user: { username: "testfollowing1" },
    artwork_url: null as string | null,
    duration: 195000,
    permalink_url: `https://soundcloud.com/testfollowing1/sample-public-track-${i + 1}`,
  })),
  next_href: null as string | null,
};

const FAKE_FOLLOWED_PLAYLISTS_PAGED = {
  collection: Array.from({ length: 2 }, (_, i) => ({
    id: 400 + i,
    title: `Sample Public Playlist ${i + 1}`,
    user: { username: "testfollowing1" },
    artwork_url: null as string | null,
    track_count: 9 + i,
    permalink_url: `https://soundcloud.com/testfollowing1/sets/sample-public-playlist-${i + 1}`,
  })),
  next_href: null as string | null,
};

/**
 * `POST /api/resolve/batch?v=2` — one of each row shape (track, playlist and a
 * failure), so the batch resolver's filters, row actions and the error styling
 * are all on the page when it is audited.
 */
const FAKE_RESOLVE_BATCH = {
  results: [
    {
      index: 0,
      url: "https://soundcloud.com/testartist/sample-track-1",
      status: "ok",
      data: {
        type: "track",
        id: 100,
        title: "Sample Track 1",
        user: { username: "testartist" },
        duration_ms: 200000,
        permalink_url: "https://soundcloud.com/testartist/sample-track-1",
      },
    },
    {
      index: 1,
      url: "https://soundcloud.com/testuser/sets/sample-playlist-1",
      status: "ok",
      data: {
        type: "playlist",
        id: 1,
        title: "Sample Playlist 1",
        user: { username: "testuser" },
        track_count: 12,
        permalink_url: "https://soundcloud.com/testuser/sets/sample-playlist-1",
      },
    },
    {
      index: 2,
      url: "https://soundcloud.com/testartist/does-not-exist",
      status: "error",
      error: "Not found",
    },
  ],
  summary: { total: 3, ok: 2, error: 1 },
  meta: { version: "2", resolved_at: "2026-09-22T12:00:00.000Z" },
};

/** `POST /api/playlists/compare` — a shared track plus one unique to each side. */
const FAKE_COMPARE = {
  summary: {
    playlistA: { id: 1, title: "Sample Playlist 1", trackCount: 2 },
    playlistB: { id: 2, title: "Sample Playlist 2", trackCount: 2 },
    overlapCount: 1,
    uniqueToACount: 1,
    uniqueToBCount: 1,
    overlapPercent: 33,
  },
  overlap: [{ id: 100, title: "Sample Track 1", user: { username: "testartist" } }],
  uniqueToA: [{ id: 101, title: "Sample Track 2", user: { username: "testartist" } }],
  uniqueToB: [{ id: 102, title: "Sample Track 3", user: { username: "testartist" } }],
};

/**
 * `GET /api/reposts` — the full (non-paged) crawl the reposts export asks for.
 * One track and one playlist, which is the shape that distinguishes it.
 */
const FAKE_REPOSTS = {
  collection: [
    {
      id: 500,
      urn: "soundcloud:tracks:500",
      resourceType: "track",
      title: "Sample Reposted Track",
      user: { username: "testartist" },
      artwork_url: null as string | null,
      permalink_url: "https://soundcloud.com/testartist/sample-reposted-track",
      created_at: "2026-09-01T00:00:00.000Z",
    },
    {
      id: 501,
      urn: "soundcloud:playlists:501",
      resourceType: "playlist",
      title: "Sample Reposted Playlist",
      user: { username: "testartist" },
      artwork_url: null as string | null,
      permalink_url: "https://soundcloud.com/testartist/sets/sample-reposted-playlist",
      created_at: "2026-09-02T00:00:00.000Z",
    },
  ],
  total: 2,
};

/** `POST /api/playlists/clone` — two parts, so the "Parts Created" card renders. */
const FAKE_CLONE = {
  playlists: [
    { id: 11, title: "Clone of Sample Playlist 1 (1/2)", permalink_url: "https://soundcloud.com/testuser/sets/clone-1" },
    { id: 12, title: "Clone of Sample Playlist 1 (2/2)", permalink_url: "https://soundcloud.com/testuser/sets/clone-2" },
  ],
  stats: { totalTracks: 12, numPlaylistsCreated: 2 },
};

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

/**
 * Route every `/api/**` request to a fixed, obviously-fake response and seed
 * localStorage so the rebrand announcements don't cover the page under test.
 */
export async function mockApi(page: Page): Promise<void> {
  await page.addInitScript(
    ({ version, bannerKey, ackKey, whatsNewVersion, whatsNewKey }) => {
      try {
        window.localStorage.setItem(bannerKey, version);
        window.localStorage.setItem(ackKey, version);
        window.localStorage.setItem(whatsNewKey, whatsNewVersion);
      } catch {
        // Private mode / blocked storage — nothing this init script can do.
      }
    },
    {
      version: REBRAND_ANNOUNCEMENT_VERSION,
      bannerKey: REBRAND_BANNER_KEY,
      ackKey: REBRAND_ACK_KEY,
      whatsNewVersion: WHATS_NEW_VERSION,
      whatsNewKey: WHATS_NEW_DISMISS_KEY,
    },
  );

  // The SoundCloud embed widget. Stubbed so a test never depends on a
  // third-party origin being up, and so an axe run over the page is not
  // scoring SoundCloud's own player markup (which has its own violations
  // and is not ours to fix). The `<iframe>` element, and therefore its
  // `title`, is still exactly what the page rendered.
  await page.route("**/w.soundcloud.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html lang=\"en\"><head><title>Player stub</title></head><body></body></html>",
    }),
  );

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    if (method === "GET" && path === "/api/auth/me") {
      return route.fulfill(json(FAKE_USER));
    }
    if (method === "GET" && path === "/api/me") {
      return route.fulfill(json(FAKE_ME));
    }
    if (method === "GET" && path === "/api/dashboard/summary") {
      return route.fulfill(json(FAKE_DASHBOARD_SUMMARY));
    }
    if (method === "GET" && path === "/api/playlists/search-tracks") {
      return route.fulfill(json(FAKE_SEARCH_TRACKS));
    }
    if (method === "GET" && path === "/api/library/audit") {
      return route.fulfill(json(FAKE_LIBRARY_AUDIT));
    }
    if (method === "GET" && path === "/api/playlists") {
      return route.fulfill(json(FAKE_PLAYLISTS));
    }
    if (method === "GET" && /^\/api\/playlists\/\d+$/.test(path)) {
      return route.fulfill(
        json({ ...FAKE_PLAYLIST_DETAIL, id: Number(path.split("/").pop()) }),
      );
    }
    if (method === "GET" && path === "/api/recently-played") {
      return route.fulfill(json(FAKE_RECENTLY_PLAYED));
    }
    if (method === "GET" && path === "/api/activities") {
      return route.fulfill(json(FAKE_ACTIVITIES));
    }
    if (method === "GET" && path === "/api/tracks/search") {
      return route.fulfill(json(FAKE_TRACK_SEARCH));
    }
    if (method === "GET" && path === "/api/likes/paged") {
      return route.fulfill(json(FAKE_LIKES_PAGED));
    }
    if (method === "GET" && path === "/api/likes") {
      return route.fulfill(
        json({ collection: FAKE_LIKES_PAGED.collection, total: FAKE_LIKES_PAGED.collection.length }),
      );
    }
    if (method === "GET" && (path === "/api/followings/paged" || path === "/api/followings")) {
      return route.fulfill(json(FAKE_FOLLOWINGS_PAGED));
    }
    if (method === "GET" && /^\/api\/followings\/\d+\/likes\/paged$/.test(path)) {
      return route.fulfill(json(FAKE_FOLLOWED_LIKES_PAGED));
    }
    if (method === "GET" && /^\/api\/followings\/\d+\/(liked-)?playlists\/paged$/.test(path)) {
      return route.fulfill(json(FAKE_FOLLOWED_PLAYLISTS_PAGED));
    }
    if (method === "GET" && (path === "/api/followers/paged" || path === "/api/followers")) {
      return route.fulfill(json(FAKE_FOLLOWERS_PAGED));
    }
    if (method === "GET" && path === "/api/reposts/paged") {
      return route.fulfill(json(FAKE_REPOSTS_PAGED));
    }
    // `/api/reposts` only — the non-paged crawl the reposts *export* asks for.
    // `/api/reposts/paged` above is offset-paged with a different shape and
    // belongs to the repost-manager fixture; answering both from one fixture
    // would shadow that.
    if (method === "GET" && path === "/api/reposts") {
      return route.fulfill(json(FAKE_REPOSTS));
    }
    if (method === "GET" && path === "/api/growth/limits") {
      return route.fulfill(json(FAKE_GROWTH_LIMITS));
    }
    if (method === "GET" && path === "/api/growth/stats") {
      return route.fulfill(json(FAKE_GROWTH_STATS));
    }
    if (method === "GET" && path === "/api/growth/history") {
      return route.fulfill(json(FAKE_GROWTH_HISTORY));
    }
    if (method === "GET" && path === "/api/growth/analytics") {
      return route.fulfill(json(FAKE_GROWTH_ANALYTICS));
    }
    if (method === "POST" && path === "/api/growth/discover") {
      const body = route.request().postDataJSON() as { genre?: string } | null;
      return route.fulfill(json(growthDiscoverResponse(body?.genre)));
    }
    if (method === "POST" && path === "/api/resolve/batch") {
      return route.fulfill(json(FAKE_RESOLVE_BATCH));
    }
    if (method === "POST" && path === "/api/resolve") {
      return route.fulfill(json(FAKE_RESOLVE));
    }
    if (method === "POST" && path === "/api/playlists/clone") {
      return route.fulfill(json(FAKE_CLONE));
    }
    if (method === "POST" && path === "/api/playlists/compare") {
      return route.fulfill(json(FAKE_COMPARE));
    }
    if (method === "POST" && path === "/api/playlists/from-likes") {
      return route.fulfill(
        json({
          playlist: {
            id: 9,
            title: "Sample Playlist 9",
            permalink_url: "https://soundcloud.com/testuser/sets/sample-playlist-9",
          },
          totalTracks: 1,
          addedCount: 1,
          numPlaylistsCreated: 1,
        }),
      );
    }
    if (method === "POST" && path === "/api/events") {
      return route.fulfill({ status: 204, body: "" });
    }
    if (method === "POST" && path === "/api/feedback") {
      return route.fulfill(json(FAKE_FEEDBACK_CREATED, 201));
    }
    if (method === "GET" && path === "/api/feedback/mine") {
      return route.fulfill(json(FAKE_FEEDBACK_MINE));
    }

    // ── Account page (see e2e/account.spec.ts) ──
    // The real route answers with `Content-Disposition: attachment`, so the
    // browser saves the file instead of navigating; keep that here, otherwise
    // the click would replace the page under the rest of the test.
    if (method === "GET" && path === "/api/auth/export") {
      return route.fulfill({
        ...json(FAKE_EXPORT),
        headers: {
          "content-type": "application/json",
          "content-disposition":
            'attachment; filename="track-toolkit-export-2026-09-22.json"',
        },
      });
    }
    if (method === "POST" && path === "/api/auth/disconnect") {
      return route.fulfill(json({ success: true }));
    }
    if (method === "DELETE" && path === "/api/auth/account") {
      return route.fulfill(json({ success: true }));
    }

    // eslint-disable-next-line no-console
    console.warn(`[e2e mockApi] unhandled ${method} ${path} — returning {} 200`);
    return route.fulfill(json({}));
  });
}
