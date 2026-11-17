/**
 * Sort Likes — the session, as pure data and a reducer.
 *
 * A session is the user's destinations (existing playlists or new ones by
 * name, each with an optional note), which tracks are marked for which
 * destinations, the "decide later" pile, an undo history, and — while a
 * commit is running or was interrupted — that commit's progress. It lives in
 * localStorage under one versioned key (`SORT_SESSION_KEY`), in this browser
 * only, by decision (2026-11-16): nothing is written to SoundCloud until the
 * commit, and a session closed halfway is there when the page is reopened.
 *
 * Only ids and labels are stored. Track details come back from /api/likes
 * each visit, so a session of thousands of marks is a few tens of kilobytes.
 */

import { normalizeSearchText } from "./list-search";

export const SORT_SESSION_KEY = "track-toolkit-sort-session-v1";
/** Which preview player the user last chose: "own" (B) or "embed" (A). */
export const SORT_PLAYER_KEY = "track-toolkit-sort-player";
/** Undo goes back this many marks; older history is dropped. */
export const SORT_HISTORY_LIMIT = 200;
/** Remembered "filed by this tool" ids, newest kept. */
export const SORT_FILED_LIMIT = 20000;
/** Hotkeys 1–9 label the first nine destinations. */
export const SORT_HOTKEY_DESTINATIONS = 9;

export interface SortDestination {
  /** Stable within the session: `pl:<id>` for an existing playlist, `new:<n>` for a new one. */
  key: string;
  /** Set for an existing playlist, and for a new one once the commit created it. */
  playlistId: number | null;
  title: string;
  /** Becomes a new playlist's description. Kept for existing playlists, never written to them. */
  note: string;
}

export interface SortHistoryEntry {
  trackId: number;
  /** The track's marks before the change (empty = none). */
  marks: string[];
  /** Whether it was in "decide later" before the change. */
  skipped: boolean;
  /** Set on every entry of one bulk action, so one undo reverts the batch. */
  group?: number;
}

export interface CommitDestinationResult {
  key: string;
  title: string;
  status: "done" | "error";
  playlists: Array<{ id: number; title: string; permalink_url: string | null; trackCount: number; created: boolean }>;
  added: number;
  alreadyPresent: number;
  /** Ids the server reported as now in this destination. */
  filed: number[];
  /** Ids sent for this destination that are not in `filed`. */
  notFiled: number[];
  error?: string;
}

export interface SortCommit {
  startedAt: number;
  unlike: boolean;
  /** trackId → destination keys, frozen when the commit started. */
  plan: Record<string, string[]>;
  /** trackId → destination keys that filed it. */
  filedBy: Record<string, string[]>;
  results: CommitDestinationResult[];
  unliked: number[];
  unlikeFailed: Array<{ trackId: number; error: string }>;
  unlikeStopped: "rate-limited" | null;
}

export interface SortSession {
  version: 1;
  destinations: SortDestination[];
  /** trackId → destination keys. A track with no marks has no entry. */
  marks: Record<string, string[]>;
  /** "Decide later". */
  skipped: number[];
  history: SortHistoryEntry[];
  /** Track ids this tool has filed in earlier commits. */
  filed: number[];
  currentTrackId: number | null;
  unlikeAfterCommit: boolean;
  advanceAfterMark: boolean;
  newDestinationCounter: number;
  commit: SortCommit | null;
}

export function emptySession(): SortSession {
  return {
    version: 1,
    destinations: [],
    marks: {},
    skipped: [],
    history: [],
    filed: [],
    currentTrackId: null,
    unlikeAfterCommit: false,
    advanceAfterMark: false,
    newDestinationCounter: 0,
    commit: null,
  };
}

// ── Storage ──────────────────────────────────────────────────────────────────

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/**
 * Parse what localStorage held. Anything malformed falls back to an empty
 * session field by field rather than throwing: a corrupt key must never stop
 * the page from rendering.
 */
export function parseSession(raw: string | null): SortSession {
  const base = emptySession();
  if (!raw) return base;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return base;
  }
  if (!data || typeof data !== "object" || (data as { version?: unknown }).version !== 1) return base;
  const d = data as Partial<SortSession>;

  const destinations = Array.isArray(d.destinations)
    ? d.destinations.filter(
        (x): x is SortDestination =>
          !!x &&
          typeof x.key === "string" &&
          typeof x.title === "string" &&
          (x.playlistId === null || isInt(x.playlistId)),
      ).map((x) => ({ ...x, note: typeof x.note === "string" ? x.note : "" }))
    : [];
  const keys = new Set(destinations.map((x) => x.key));

  const marks: Record<string, string[]> = {};
  if (d.marks && typeof d.marks === "object") {
    for (const [id, list] of Object.entries(d.marks)) {
      if (!isInt(Number(id)) || !isStringArray(list)) continue;
      const kept = list.filter((k) => keys.has(k));
      if (kept.length) marks[id] = kept;
    }
  }

  return {
    ...base,
    destinations,
    marks,
    skipped: Array.isArray(d.skipped) ? d.skipped.filter(isInt) : [],
    history: Array.isArray(d.history)
      ? d.history
          .filter((h) => !!h && isInt(h.trackId) && isStringArray(h.marks) && typeof h.skipped === "boolean")
          .map((h) => (h.group === undefined || isInt(h.group) ? h : { trackId: h.trackId, marks: h.marks, skipped: h.skipped }))
      : [],
    filed: Array.isArray(d.filed) ? d.filed.filter(isInt) : [],
    currentTrackId: isInt(d.currentTrackId) ? d.currentTrackId : null,
    unlikeAfterCommit: d.unlikeAfterCommit === true,
    advanceAfterMark: d.advanceAfterMark === true,
    newDestinationCounter: isInt(d.newDestinationCounter) ? d.newDestinationCounter : 0,
    commit: d.commit && typeof d.commit === "object" && d.commit.plan ? (d.commit as SortCommit) : null,
  };
}

export function loadSession(): SortSession {
  try {
    return parseSession(window.localStorage.getItem(SORT_SESSION_KEY));
  } catch {
    return emptySession();
  }
}

/** Returns false when the browser refused the write (private mode, quota). */
export function saveSession(session: SortSession): boolean {
  try {
    window.localStorage.setItem(SORT_SESSION_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

// ── Reducer ──────────────────────────────────────────────────────────────────

export type SortAction =
  | { type: "load"; session: SortSession }
  | { type: "addExisting"; playlistId: number; title: string }
  | { type: "addNew"; title: string }
  | { type: "removeDestination"; key: string }
  | { type: "renameDestination"; key: string; title: string }
  | { type: "setNote"; key: string; note: string }
  | { type: "toggleMark"; trackId: number; key: string }
  | { type: "toggleSkip"; trackId: number }
  /** Multi-select: mark every listed track for `key`, or unmark them all when every one already has it. */
  | { type: "bulkMark"; trackIds: number[]; key: string }
  /** Multi-select: put every listed track in decide later, or take them all out when every one is there. */
  | { type: "bulkSkip"; trackIds: number[] }
  /** Multi-select: remove every mark from the listed tracks. */
  | { type: "bulkClearMarks"; trackIds: number[] }
  | { type: "undo" }
  | { type: "setCurrent"; trackId: number | null }
  | { type: "setUnlikeAfterCommit"; value: boolean }
  | { type: "setAdvanceAfterMark"; value: boolean }
  | { type: "commitStart" }
  | { type: "commitDestination"; result: CommitDestinationResult }
  | { type: "commitUnliked"; ok: number[]; failed: Array<{ trackId: number; error: string }>; rateLimited: boolean }
  | { type: "commitFinish" }
  | { type: "clearSession" };

const normTitle = (title: string) => normalizeSearchText(title).trim();

function withHistory(session: SortSession, trackId: number): SortHistoryEntry[] {
  const entry: SortHistoryEntry = {
    trackId,
    marks: session.marks[String(trackId)] ?? [],
    skipped: session.skipped.includes(trackId),
  };
  return [...session.history, entry].slice(-SORT_HISTORY_LIMIT);
}

/** History entries for a bulk change: one per track, sharing a new group id. */
function withBulkHistory(session: SortSession, trackIds: number[]): SortHistoryEntry[] {
  const group = session.history.reduce((max, h) => Math.max(max, h.group ?? 0), 0) + 1;
  const skipped = new Set(session.skipped);
  const entries = trackIds.map((trackId) => ({
    trackId,
    marks: session.marks[String(trackId)] ?? [],
    skipped: skipped.has(trackId),
    group,
  }));
  return [...session.history, ...entries].slice(-SORT_HISTORY_LIMIT);
}

const uniqueIds = (ids: number[]) => [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];

function setMarks(marks: Record<string, string[]>, trackId: number, list: string[]) {
  const next = { ...marks };
  if (list.length) next[String(trackId)] = list;
  else delete next[String(trackId)];
  return next;
}

export function sortReducer(session: SortSession, action: SortAction): SortSession {
  // While a commit runs, marks and destinations are frozen: the commit's plan
  // was taken from them and must stay true.
  const locked = session.commit !== null;
  switch (action.type) {
    case "load":
      return action.session;

    case "addExisting": {
      if (locked) return session;
      if (session.destinations.some((d) => d.playlistId === action.playlistId)) return session;
      return {
        ...session,
        destinations: [...session.destinations, { key: `pl:${action.playlistId}`, playlistId: action.playlistId, title: action.title, note: "" }],
      };
    }

    case "addNew": {
      if (locked) return session;
      const title = action.title.trim().slice(0, 100);
      if (!title) return session;
      if (session.destinations.some((d) => d.playlistId === null && normTitle(d.title) === normTitle(title))) return session;
      const n = session.newDestinationCounter + 1;
      return {
        ...session,
        newDestinationCounter: n,
        destinations: [...session.destinations, { key: `new:${n}`, playlistId: null, title, note: "" }],
      };
    }

    case "removeDestination": {
      if (locked) return session;
      let marks = session.marks;
      for (const [id, list] of Object.entries(session.marks)) {
        if (list.includes(action.key)) marks = setMarks(marks, Number(id), list.filter((k) => k !== action.key));
      }
      return {
        ...session,
        destinations: session.destinations.filter((d) => d.key !== action.key),
        marks,
        // History entries naming the removed destination would restore a dead key.
        history: session.history.map((h) => ({ ...h, marks: h.marks.filter((k) => k !== action.key) })),
      };
    }

    case "renameDestination": {
      if (locked) return session;
      const title = action.title.trim().slice(0, 100);
      if (!title) return session;
      return {
        ...session,
        destinations: session.destinations.map((d) => (d.key === action.key && d.playlistId === null ? { ...d, title } : d)),
      };
    }

    case "setNote":
      return {
        ...session,
        destinations: session.destinations.map((d) => (d.key === action.key ? { ...d, note: action.note.slice(0, 1000) } : d)),
      };

    case "toggleMark": {
      if (locked || !session.destinations.some((d) => d.key === action.key)) return session;
      const current = session.marks[String(action.trackId)] ?? [];
      const next = current.includes(action.key) ? current.filter((k) => k !== action.key) : [...current, action.key];
      return {
        ...session,
        history: withHistory(session, action.trackId),
        marks: setMarks(session.marks, action.trackId, next),
        // Marking a track decides it: it leaves the "decide later" pile.
        skipped: next.length ? session.skipped.filter((id) => id !== action.trackId) : session.skipped,
      };
    }

    case "toggleSkip": {
      if (locked) return session;
      const isSkipped = session.skipped.includes(action.trackId);
      return {
        ...session,
        history: withHistory(session, action.trackId),
        skipped: isSkipped ? session.skipped.filter((id) => id !== action.trackId) : [...session.skipped, action.trackId],
      };
    }

    case "bulkMark": {
      const ids = uniqueIds(action.trackIds);
      if (locked || ids.length === 0 || !session.destinations.some((d) => d.key === action.key)) return session;
      const everyHas = ids.every((id) => (session.marks[String(id)] ?? []).includes(action.key));
      let marks = session.marks;
      for (const id of ids) {
        const current = marks[String(id)] ?? [];
        const next = everyHas ? current.filter((k) => k !== action.key) : current.includes(action.key) ? current : [...current, action.key];
        marks = setMarks(marks, id, next);
      }
      const marked = new Set(ids.filter((id) => (marks[String(id)] ?? []).length > 0));
      return {
        ...session,
        history: withBulkHistory(session, ids),
        marks,
        skipped: session.skipped.filter((id) => !marked.has(id)),
      };
    }

    case "bulkSkip": {
      const ids = uniqueIds(action.trackIds);
      if (locked || ids.length === 0) return session;
      const skipped = new Set(session.skipped);
      const everySkipped = ids.every((id) => skipped.has(id));
      for (const id of ids) {
        if (everySkipped) skipped.delete(id);
        else skipped.add(id);
      }
      return { ...session, history: withBulkHistory(session, ids), skipped: [...skipped] };
    }

    case "bulkClearMarks": {
      const ids = uniqueIds(action.trackIds).filter((id) => (session.marks[String(id)] ?? []).length > 0);
      if (locked || ids.length === 0) return session;
      let marks = session.marks;
      for (const id of ids) marks = setMarks(marks, id, []);
      return { ...session, history: withBulkHistory(session, ids), marks };
    }

    case "undo": {
      if (locked || session.history.length === 0) return session;
      // A bulk action undoes as one step: every trailing entry of its group.
      const last = session.history[session.history.length - 1];
      let from = session.history.length - 1;
      if (last.group !== undefined) {
        while (from > 0 && session.history[from - 1].group === last.group) from -= 1;
      }
      const undone = session.history.slice(from);
      const keys = new Set(session.destinations.map((d) => d.key));
      let marks = session.marks;
      const skipped = new Set(session.skipped);
      for (const entry of [...undone].reverse()) {
        marks = setMarks(marks, entry.trackId, entry.marks.filter((k) => keys.has(k)));
        if (entry.skipped) skipped.add(entry.trackId);
        else skipped.delete(entry.trackId);
      }
      return {
        ...session,
        history: session.history.slice(0, from),
        marks,
        skipped: [...skipped],
        currentTrackId: undone.length === 1 ? last.trackId : session.currentTrackId,
      };
    }

    case "setCurrent":
      return { ...session, currentTrackId: action.trackId };

    case "setUnlikeAfterCommit":
      return locked ? session : { ...session, unlikeAfterCommit: action.value };

    case "setAdvanceAfterMark":
      return { ...session, advanceAfterMark: action.value };

    case "commitStart": {
      // Resuming keeps the interrupted commit as it was.
      if (session.commit) return session;
      return {
        ...session,
        commit: {
          startedAt: Date.now(),
          unlike: session.unlikeAfterCommit,
          plan: { ...session.marks },
          filedBy: {},
          results: [],
          unliked: [],
          unlikeFailed: [],
          unlikeStopped: null,
        },
      };
    }

    case "commitDestination": {
      const commit = session.commit;
      if (!commit) return session;
      const { result } = action;
      const filedBy = { ...commit.filedBy };
      let marks = session.marks;
      for (const id of result.filed) {
        const k = String(id);
        filedBy[k] = [...new Set([...(filedBy[k] ?? []), result.key])];
        marks = setMarks(marks, id, (marks[k] ?? []).filter((x) => x !== result.key));
      }
      // A new playlist that now exists becomes an existing destination, so a
      // retry or a later session appends to it instead of creating another.
      const createdId = result.playlists.find((p) => p.created)?.id ?? null;
      const destinations = session.destinations.map((d) =>
        d.key === result.key && d.playlistId === null && createdId ? { ...d, playlistId: createdId } : d,
      );
      return {
        ...session,
        destinations,
        marks,
        commit: { ...commit, filedBy, results: [...commit.results.filter((r) => r.key !== result.key), result] },
      };
    }

    case "commitUnliked": {
      const commit = session.commit;
      if (!commit) return session;
      return {
        ...session,
        commit: {
          ...commit,
          unliked: [...new Set([...commit.unliked, ...action.ok])],
          unlikeFailed: [...commit.unlikeFailed.filter((f) => !action.ok.includes(f.trackId)), ...action.failed],
          unlikeStopped: action.rateLimited ? "rate-limited" : commit.unlikeStopped,
        },
      };
    }

    case "commitFinish": {
      const commit = session.commit;
      if (!commit) return session;
      const filedNow = Object.keys(commit.filedBy).map(Number);
      const filed = [...new Set([...session.filed, ...filedNow])].slice(-SORT_FILED_LIMIT);
      const keep = new Set(Object.keys(session.marks).map(Number));
      return {
        ...session,
        filed,
        // Undo cannot reach across a commit: those marks are on SoundCloud now.
        history: session.history.filter((h) => keep.has(h.trackId) && !filedNow.includes(h.trackId)),
        commit: null,
      };
    }

    case "clearSession":
      return locked ? session : { ...emptySession(), filed: session.filed };

    default:
      return session;
  }
}

// ── Commit planning ──────────────────────────────────────────────────────────

/** Track ids still to send for one destination: in the plan, not yet filed there. */
export function pendingForDestination(commit: SortCommit, key: string): number[] {
  const ids: number[] = [];
  for (const [id, keys] of Object.entries(commit.plan)) {
    if (keys.includes(key) && !(commit.filedBy[id] ?? []).includes(key)) ids.push(Number(id));
  }
  return ids;
}

/**
 * Tracks that may be unliked: every destination the plan named for it filed
 * it. A track any destination failed to file stays liked — nothing is removed
 * from likes that did not reach its playlist.
 */
export function unlikeEligible(commit: SortCommit): number[] {
  const done = new Set(commit.unliked);
  const ids: number[] = [];
  for (const [id, keys] of Object.entries(commit.plan)) {
    const filed = commit.filedBy[id] ?? [];
    if (keys.length > 0 && keys.every((k) => filed.includes(k)) && !done.has(Number(id))) ids.push(Number(id));
  }
  return ids;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Destination key → number of tracks marked for it. */
export function markCounts(marks: Record<string, string[]>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const list of Object.values(marks)) for (const k of list) counts[k] = (counts[k] ?? 0) + 1;
  return counts;
}

// ── Tracks: suggestions and filters ──────────────────────────────────────────

export interface SortTrack {
  id: number;
  title?: string | null;
  user?: { username?: string | null } | null;
  genre?: string | null;
  tag_list?: string | null;
  duration?: number | null;
  artwork_url?: string | null;
  permalink_url?: string | null;
  waveform_url?: string | null;
  access?: string | null;
}

/** SoundCloud's tag_list: space-separated, multi-word tags in double quotes. */
export function parseTagList(tagList: string | null | undefined): string[] {
  if (!tagList) return [];
  const tags: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagList))) tags.push(m[1] ?? m[2]);
  return tags;
}

const STOP_WORDS = new Set(["the", "and", "of", "a", "an", "for", "my", "to", "in", "music", "mix", "playlist"]);

function words(text: string): string[] {
  return normalizeSearchText(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Destinations whose name matches the track: every meaningful word of the
 * destination's name appears as a whole word in the track's genre, tags or
 * title ("tech house" ← genre "Tech House"; "pop remix" ← genre "Pop" plus
 * "(… Remix)" in the title). Whole words, so "house" does not match
 * "housewife". Best match first; at most three.
 */
export function suggestDestinations(track: SortTrack, destinations: SortDestination[]): string[] {
  const haystack = new Set([
    ...words(track.genre ?? ""),
    ...parseTagList(track.tag_list).flatMap(words),
    ...words(track.title ?? ""),
  ]);
  const genreWords = new Set(words(track.genre ?? ""));
  const scored: Array<{ key: string; score: number }> = [];
  for (const d of destinations) {
    const name = words(d.title).filter((w) => !STOP_WORDS.has(w));
    if (name.length === 0) continue;
    if (!name.every((w) => haystack.has(w))) continue;
    // Words found in the genre count double: it is the artist's own label.
    const score = name.reduce((s, w) => s + (genreWords.has(w) ? 2 : 1), 0) + name.length;
    scored.push({ key: d.key, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 3).map((s) => s.key);
}

export type SortView = "unsorted" | "marked" | "later" | "all";

export interface SortFilter {
  view: SortView;
  genre: string;
  order: "newest" | "oldest";
  hideInDestination: boolean;
}

export const DEFAULT_SORT_FILTER: SortFilter = { view: "unsorted", genre: "", order: "newest", hideInDestination: true };

/** A track's genre as a filter value: trimmed, case-folded for comparison. */
export function genreKey(genre: string | null | undefined): string {
  return (genre ?? "").trim().toLowerCase();
}

/** Genres present in the likes, most common first, for the genre filter. */
export function genreOptions(tracks: SortTrack[], limit = 40): Array<{ value: string; label: string; count: number }> {
  const counts = new Map<string, { label: string; count: number }>();
  for (const t of tracks) {
    const key = genreKey(t.genre);
    if (!key) continue;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { label: (t.genre ?? "").trim(), count: 1 });
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label))
    .slice(0, limit)
    .map(([value, { label, count }]) => ({ value, label, count }));
}

/**
 * Apply the view and filters. `inDestination` is the ids already in an
 * existing destination playlist; `filed` the ids this tool filed earlier.
 * Likes arrive newest-liked first from SoundCloud, so "oldest" reverses.
 * SoundCloud's API gives no like date, only that order.
 */
export function filterTracks(
  tracks: SortTrack[],
  session: Pick<SortSession, "marks" | "skipped" | "filed">,
  filter: SortFilter,
  inDestination: ReadonlySet<number>,
): SortTrack[] {
  const skipped = new Set(session.skipped);
  const filed = new Set(session.filed);
  const out = tracks.filter((t) => {
    const marked = (session.marks[String(t.id)] ?? []).length > 0;
    const isSkipped = skipped.has(t.id);
    if (filter.genre && genreKey(t.genre) !== filter.genre) return false;
    const done = filed.has(t.id) || inDestination.has(t.id);
    if (filter.hideInDestination && done && !marked) return false;
    switch (filter.view) {
      case "unsorted":
        return !marked && !isSkipped;
      case "marked":
        return marked;
      case "later":
        return isSkipped;
      default:
        return true;
    }
  });
  return filter.order === "oldest" ? out.reverse() : out;
}

export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** SoundCloud's waveform PNG link → the JSON form of the same waveform. */
export function waveformJsonUrl(waveformUrl: string | null | undefined): string | null {
  if (!waveformUrl) return null;
  try {
    const url = new URL(waveformUrl);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".sndcdn.com")) return null;
    url.pathname = url.pathname.replace(/\.png$/i, ".json");
    return url.pathname.endsWith(".json") ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Reduce SoundCloud's 1800 samples to `bars` peaks, scaled 0–1. */
export function downsampleWaveform(samples: number[], height: number, bars: number): number[] {
  if (!samples.length || bars < 1) return [];
  const per = samples.length / bars;
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    let peak = 0;
    const from = Math.floor(i * per);
    const to = Math.max(from + 1, Math.floor((i + 1) * per));
    for (let j = from; j < to && j < samples.length; j++) peak = Math.max(peak, samples[j]);
    out.push(height > 0 ? Math.min(1, peak / height) : 0);
  }
  return out;
}
