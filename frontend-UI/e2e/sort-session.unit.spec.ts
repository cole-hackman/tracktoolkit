import { test, expect } from "@playwright/test";
import {
  SORT_SESSION_KEY,
  DEFAULT_SORT_FILTER,
  downsampleWaveform,
  emptySession,
  filterTracks,
  parseSession,
  parseTagList,
  pendingForDestination,
  sortReducer,
  suggestDestinations,
  unlikeEligible,
  waveformJsonUrl,
  type SortAction,
  type SortSession,
} from "../src/lib/sort-session";

/**
 * Sort Likes session logic (src/lib/sort-session.ts). The rules that keep the
 * user's likes safe live here, not in the page: a track is unliked only when
 * every destination it was marked for filed it, and marks freeze while a
 * commit runs.
 */

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "viewport-independent unit tests");
});

const run = (actions: SortAction[], start: SortSession = emptySession()) => actions.reduce(sortReducer, start);

const withTwo = () =>
  run([
    { type: "addExisting", playlistId: 7, title: "Tech House" },
    { type: "addNew", title: "Pop Remix" },
  ]);

test("destinations: existing by id, new by name, no duplicates", () => {
  const s = run([
    { type: "addExisting", playlistId: 7, title: "Tech House" },
    { type: "addExisting", playlistId: 7, title: "Tech House" },
    { type: "addNew", title: "Pop Remix" },
    { type: "addNew", title: "  pop remix " },
    { type: "addNew", title: "   " },
  ]);
  expect(s.destinations.map((d) => [d.key, d.playlistId, d.title])).toEqual([
    ["pl:7", 7, "Tech House"],
    ["new:1", null, "Pop Remix"],
  ]);
});

test("marks toggle, can be several per track, and marking takes a track out of decide later", () => {
  let s = run([{ type: "toggleSkip", trackId: 1 }], withTwo());
  expect(s.skipped).toEqual([1]);
  s = run(
    [
      { type: "toggleMark", trackId: 1, key: "pl:7" },
      { type: "toggleMark", trackId: 1, key: "new:1" },
    ],
    s,
  );
  expect(s.marks["1"]).toEqual(["pl:7", "new:1"]);
  expect(s.skipped).toEqual([]);
  s = sortReducer(s, { type: "toggleMark", trackId: 1, key: "pl:7" });
  expect(s.marks["1"]).toEqual(["new:1"]);
  // A mark for a destination that does not exist is ignored.
  expect(sortReducer(s, { type: "toggleMark", trackId: 2, key: "pl:999" })).toBe(s);
});

test("undo restores the previous marks and skip state, newest first, and returns to that track", () => {
  const s = run(
    [
      { type: "toggleMark", trackId: 1, key: "pl:7" },
      { type: "toggleSkip", trackId: 2 },
      { type: "toggleMark", trackId: 2, key: "new:1" },
      { type: "setCurrent", trackId: 3 },
    ],
    withTwo(),
  );
  const u1 = sortReducer(s, { type: "undo" });
  expect(u1.marks["2"]).toBeUndefined();
  expect(u1.skipped).toEqual([2]);
  expect(u1.currentTrackId).toBe(2);
  const u2 = sortReducer(u1, { type: "undo" });
  expect(u2.skipped).toEqual([]);
  const u3 = sortReducer(u2, { type: "undo" });
  expect(u3.marks).toEqual({});
  expect(sortReducer(u3, { type: "undo" })).toBe(u3);
});

test("removing a destination removes its marks and its history", () => {
  const s = run(
    [
      { type: "toggleMark", trackId: 1, key: "pl:7" },
      { type: "toggleMark", trackId: 1, key: "new:1" },
      { type: "removeDestination", key: "new:1" },
    ],
    withTwo(),
  );
  expect(s.marks).toEqual({ "1": ["pl:7"] });
  expect(s.history.every((h) => !h.marks.includes("new:1"))).toBe(true);
});

test("commit: only tracks every destination filed are eligible to unlike; marks freeze meanwhile", () => {
  let s = run(
    [
      { type: "toggleMark", trackId: 1, key: "pl:7" },
      { type: "toggleMark", trackId: 2, key: "pl:7" },
      { type: "toggleMark", trackId: 2, key: "new:1" },
      { type: "toggleMark", trackId: 3, key: "new:1" },
      { type: "setUnlikeAfterCommit", value: true },
      { type: "commitStart" },
    ],
    withTwo(),
  );
  expect(s.commit?.unlike).toBe(true);
  expect(pendingForDestination(s.commit!, "pl:7").sort()).toEqual([1, 2]);
  // Frozen: a mark during the commit does nothing.
  expect(sortReducer(s, { type: "toggleMark", trackId: 9, key: "pl:7" })).toBe(s);

  s = sortReducer(s, {
    type: "commitDestination",
    result: { key: "pl:7", title: "Tech House", status: "done", playlists: [{ id: 7, title: "Tech House", permalink_url: null, trackCount: 2, created: false }], added: 2, alreadyPresent: 0, filed: [1, 2], notFiled: [] },
  });
  s = sortReducer(s, {
    type: "commitDestination",
    result: { key: "new:1", title: "Pop Remix", status: "error", playlists: [], added: 0, alreadyPresent: 0, filed: [], notFiled: [2, 3], error: "503" },
  });
  // Track 2 reached Tech House but not Pop Remix: it stays liked.
  expect(unlikeEligible(s.commit!)).toEqual([1]);
  expect(s.marks).toEqual({ "2": ["new:1"], "3": ["new:1"] });

  s = sortReducer(s, { type: "commitUnliked", ok: [1], failed: [], rateLimited: false });
  expect(unlikeEligible(s.commit!)).toEqual([]);
  s = sortReducer(s, { type: "commitFinish" });
  expect(s.commit).toBeNull();
  expect(s.filed.sort()).toEqual([1, 2]);
  // The failed destination's marks are still there to retry.
  expect(s.marks).toEqual({ "2": ["new:1"], "3": ["new:1"] });
});

test("a new playlist that was created becomes an existing destination, so a retry appends", () => {
  let s = run([{ type: "toggleMark", trackId: 5, key: "new:1" }, { type: "commitStart" }], withTwo());
  s = sortReducer(s, {
    type: "commitDestination",
    result: { key: "new:1", title: "Pop Remix", status: "done", playlists: [{ id: 55, title: "Pop Remix", permalink_url: null, trackCount: 1, created: true }], added: 1, alreadyPresent: 0, filed: [5], notFiled: [] },
  });
  expect(s.destinations.find((d) => d.key === "new:1")?.playlistId).toBe(55);
});

test("storage: round-trips, and anything malformed falls back instead of throwing", () => {
  const s = run([{ type: "toggleMark", trackId: 1, key: "pl:7" }, { type: "setNote", key: "new:1", note: "warm-up" }], withTwo());
  expect(parseSession(JSON.stringify(s))).toEqual({ ...s, commit: null });
  expect(SORT_SESSION_KEY).toBe("track-toolkit-sort-session-v1");
  expect(parseSession("{nope")).toEqual(emptySession());
  expect(parseSession(JSON.stringify({ version: 2 }))).toEqual(emptySession());
  // Marks naming a missing destination are dropped.
  const odd = parseSession(JSON.stringify({ ...s, marks: { "1": ["pl:7", "pl:404"], x: ["pl:7"] } }));
  expect(odd.marks).toEqual({ "1": ["pl:7"] });
});

test("suggestions: whole words from genre, tags or title; best first", () => {
  const dests = run([
    { type: "addNew", title: "Tech House" },
    { type: "addNew", title: "Pop Remix" },
    { type: "addNew", title: "House" },
    { type: "addNew", title: "Housewife Anthems" },
  ]).destinations;
  const key = (title: string) => dests.find((d) => d.title === title)!.key;
  expect(suggestDestinations({ id: 1, title: "Groove", genre: "Tech House" }, dests)).toEqual([key("Tech House"), key("House")]);
  expect(suggestDestinations({ id: 2, title: "Song (Someone Remix)", genre: "Pop" }, dests)).toEqual([key("Pop Remix")]);
  expect(suggestDestinations({ id: 3, title: "x", genre: "", tag_list: 'garage "deep house"' }, dests)).toEqual([key("House")]);
  expect(suggestDestinations({ id: 4, title: "x", genre: "Techno" }, dests)).toEqual([]);
});

test("tag lists keep quoted multi-word tags together", () => {
  expect(parseTagList('ukg "deep house" 2step')).toEqual(["ukg", "deep house", "2step"]);
  expect(parseTagList(null)).toEqual([]);
});

test("views and filters", () => {
  const tracks = [1, 2, 3, 4, 5].map((id) => ({ id, genre: id % 2 ? "House" : "Techno" }));
  const s = run(
    [
      { type: "toggleMark", trackId: 1, key: "pl:7" },
      { type: "toggleSkip", trackId: 2 },
    ],
    withTwo(),
  );
  const session = { ...s, filed: [3] };
  const ids = (view: typeof DEFAULT_SORT_FILTER.view, extra = {}, inDest = new Set<number>([4])) =>
    filterTracks(tracks, session, { ...DEFAULT_SORT_FILTER, view, ...extra }, inDest).map((t) => t.id);
  expect(ids("unsorted")).toEqual([5]);
  expect(ids("unsorted", { hideInDestination: false })).toEqual([3, 4, 5]);
  expect(ids("marked")).toEqual([1]);
  expect(ids("later")).toEqual([2]);
  expect(ids("all", { genre: "house" })).toEqual([1, 5]);
  expect(ids("all", { order: "oldest" })).toEqual([5, 2, 1]);
});

test("waveform: JSON link from the PNG one, peaks scaled to 0–1", () => {
  expect(waveformJsonUrl("https://wave.sndcdn.com/abc_m.png")).toBe("https://wave.sndcdn.com/abc_m.json");
  expect(waveformJsonUrl("https://evil.example/abc_m.png")).toBeNull();
  expect(waveformJsonUrl(null)).toBeNull();
  expect(downsampleWaveform([0, 10, 20, 140], 140, 2)).toEqual([10 / 140, 1]);
});

test("bulk mark: marks all, or unmarks all when every one has it; one undo reverts the batch", () => {
  let s = run([{ type: "toggleMark", trackId: 1, key: "pl:7" }, { type: "toggleSkip", trackId: 3 }], withTwo());
  s = sortReducer(s, { type: "bulkMark", trackIds: [1, 2, 3, 2], key: "pl:7" });
  expect(s.marks).toEqual({ "1": ["pl:7"], "2": ["pl:7"], "3": ["pl:7"] });
  // Marking takes a track out of decide later, as a single mark does.
  expect(s.skipped).toEqual([]);
  const afterAdd = s;
  s = sortReducer(s, { type: "bulkMark", trackIds: [1, 2, 3], key: "pl:7" });
  expect(s.marks).toEqual({});
  // Undo the unmark batch, then the mark batch, then the single skip/mark.
  s = sortReducer(s, { type: "undo" });
  expect(s.marks).toEqual(afterAdd.marks);
  s = sortReducer(s, { type: "undo" });
  expect(s.marks).toEqual({ "1": ["pl:7"] });
  expect(s.skipped).toEqual([3]);
  // A missing destination or an empty selection changes nothing.
  expect(sortReducer(s, { type: "bulkMark", trackIds: [1], key: "pl:404" })).toBe(s);
  expect(sortReducer(s, { type: "bulkMark", trackIds: [], key: "pl:7" })).toBe(s);
});

test("bulk skip toggles the whole selection; bulk clear removes every mark; both freeze during a commit", () => {
  let s = run([{ type: "toggleSkip", trackId: 1 }], withTwo());
  s = sortReducer(s, { type: "bulkSkip", trackIds: [1, 2] });
  expect(s.skipped.sort()).toEqual([1, 2]);
  s = sortReducer(s, { type: "bulkSkip", trackIds: [1, 2] });
  expect(s.skipped).toEqual([]);
  s = run(
    [
      { type: "bulkMark", trackIds: [4, 5], key: "pl:7" },
      { type: "bulkMark", trackIds: [4], key: "new:1" },
      { type: "bulkClearMarks", trackIds: [4, 5, 6] },
    ],
    s,
  );
  expect(s.marks).toEqual({});
  s = sortReducer(s, { type: "undo" });
  expect(s.marks).toEqual({ "4": ["pl:7", "new:1"], "5": ["pl:7"] });
  const locked = sortReducer(s, { type: "commitStart" });
  expect(sortReducer(locked, { type: "bulkMark", trackIds: [9], key: "pl:7" })).toBe(locked);
  expect(sortReducer(locked, { type: "bulkSkip", trackIds: [9] })).toBe(locked);
});
