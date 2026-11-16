"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Clock,
  ExternalLink,
  Keyboard,
  Music,
  Pause,
  Play,
  Plus,
  SkipBack,
  SkipForward,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import { apiFetch, errorMessageFromBody } from "@/lib/api";
import { asArray } from "@/lib/api-shape";
import {
  ActionBar,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  InlineAlert,
  Input,
  ListSearch,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  Panel,
  ProgressBar,
  ResultPanel,
  SegmentedControl,
  Select,
  Skeleton,
  ToolLayout,
  useAnnounce,
  type ResultStatus,
} from "@/components/ui";
import { PlaylistChooser } from "@/components/playlists/PlaylistChooser";
import { PreviewPlayer, type PlayerHandle, type PlayerMode, type PlayerState } from "@/components/sort/PreviewPlayer";
import { Waveform } from "@/components/sort/Waveform";
import {
  invalidatePlaylistCaches,
  playlistDetailQueryOptions,
  removeTracksFromLikesCache,
  useLikesQuery,
  usePlaylistsQuery,
  type PlaylistSummary,
} from "@/lib/queries";
import { filterBySearch } from "@/lib/list-search";
import { cn } from "@/lib/utils";
import {
  DEFAULT_SORT_FILTER,
  SORT_HOTKEY_DESTINATIONS,
  SORT_PLAYER_KEY,
  chunk,
  emptySession,
  filterTracks,
  formatClock,
  genreOptions,
  loadSession,
  markCounts,
  parseTagList,
  pendingForDestination,
  saveSession,
  sortReducer,
  suggestDestinations,
  unlikeEligible,
  type CommitDestinationResult,
  type SortAction,
  type SortFilter,
  type SortSession,
  type SortTrack,
  type SortView,
} from "@/lib/sort-session";

const ROW_HEIGHT = 64;
const MAX_PLAYLIST_TRACKS = 500;

const PLAYER_MODES = [
  { value: "own", label: "Track Toolkit player" },
  { value: "embed", label: "SoundCloud embed" },
] as const;

const ORDER_OPTIONS = [
  { value: "newest", label: "Newest liked first" },
  { value: "oldest", label: "Oldest liked first" },
] as const;

const SHORTCUTS: Array<[string, string]> = [
  ["1 – 9", "Mark / unmark the current track for destination 1–9"],
  ["J", "Next track"],
  ["K", "Previous track"],
  ["S", "Decide later (and move on)"],
  ["Z", "Undo the last mark or skip"],
  ["Space", "Play / pause"],
  ["← / →", "Back / forward 10 seconds (Shift: 30)"],
  ["Q / W / E", "Jump to 25% / 50% / 75% of the track"],
  ["?", "Show these shortcuts"],
];

const trackText = (t: SortTrack) => `${t.title ?? ""} ${t.user?.username ?? ""} ${t.genre ?? ""} ${t.tag_list ?? ""}`;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function isActivatable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest("button, a, [role='slider'], summary");
}

interface Outcome {
  id: number;
  status: ResultStatus;
  title: string;
  description: string;
  results: CommitDestinationResult[];
  unliked: number;
  unlikeFailed: number;
  keptLiked: number;
  unlikeStopped: boolean;
  unlikeRequested: boolean;
  stoppedEarly: string | null;
}

function buildOutcome(session: SortSession, stoppedEarly: string | null): Outcome {
  const commit = session.commit!;
  const results = commit.results;
  const done = results.filter((r) => r.status === "done");
  const failed = results.filter((r) => r.status === "error");
  const added = results.reduce((sum, r) => sum + r.added, 0);
  const planned = Object.keys(commit.plan).length;
  const fullyFiled = Object.entries(commit.plan).filter(([id, keys]) => keys.every((k) => (commit.filedBy[id] ?? []).includes(k))).length;
  const keptLiked = commit.unlike ? planned - fullyFiled : 0;
  const unlikeOk = !commit.unlike || (commit.unlikeFailed.length === 0 && !commit.unlikeStopped && commit.unliked.length === fullyFiled);

  let status: ResultStatus = "success";
  if (done.length === 0 && failed.length > 0) status = "error";
  else if (failed.length > 0 || !unlikeOk || stoppedEarly) status = "partial";
  else if (added === 0 && commit.unliked.length === 0) status = "empty";

  const playlistCount = done.reduce((n, r) => n + r.playlists.length, 0);
  const title =
    status === "error"
      ? "Nothing was added"
      : status === "empty"
        ? "Everything was already in place"
        : `${added} track${added === 1 ? "" : "s"} added to ${playlistCount} playlist${playlistCount === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (failed.length) parts.push(`${failed.length} destination${failed.length === 1 ? "" : "s"} failed; their marks are kept so you can try again.`);
  if (commit.unlike) parts.push(`${commit.unliked.length} removed from your likes.`);
  if (stoppedEarly) parts.push(stoppedEarly);

  return {
    id: Date.now(),
    status,
    title,
    description: parts.join(" ") || "Every marked track reached its playlist.",
    results,
    unliked: commit.unliked.length,
    unlikeFailed: commit.unlikeFailed.length,
    keptLiked,
    unlikeStopped: commit.unlikeStopped === "rate-limited",
    unlikeRequested: commit.unlike,
    stoppedEarly,
  };
}

export default function SortLikesPage() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();

  // ── Session ────────────────────────────────────────────────────────────────
  const [session, dispatch] = useReducer(sortReducer, undefined, emptySession);
  const [hydrated, setHydrated] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    dispatch({ type: "load", session: loadSession() });
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (hydrated) setStorageOk(saveSession(session));
  }, [session, hydrated]);

  // ── Data ───────────────────────────────────────────────────────────────────
  const likesQuery = useLikesQuery();
  const likes = useMemo(() => asArray<SortTrack>(likesQuery.data?.collection).filter((t) => Number.isSafeInteger(t?.id)), [likesQuery.data?.collection]);
  const likesTruncated = (likesQuery.data as { truncated?: boolean } | undefined)?.truncated === true;
  const playlistsQuery = usePlaylistsQuery();
  const playlists = useMemo(() => asArray<PlaylistSummary>(playlistsQuery.data?.collection), [playlistsQuery.data?.collection]);
  const playlistById = useMemo(() => new Map(playlists.map((p) => [Number(p.id), p])), [playlists]);

  const existingDestinationIds = useMemo(
    () => session.destinations.map((d) => d.playlistId).filter((id): id is number => id !== null),
    [session.destinations],
  );
  const destinationDetails = useQueries({
    queries: existingDestinationIds.map((id) => ({ ...playlistDetailQueryOptions(id), retry: 1 })),
  });
  const inDestination = useMemo(() => {
    const ids = new Set<number>();
    for (const q of destinationDetails) for (const t of asArray<{ id: number }>(q.data?.tracks)) ids.add(Number(t.id));
    return ids;
  }, [destinationDetails]);
  const destinationsLoading = destinationDetails.some((q) => q.isLoading);

  // ── Filters ────────────────────────────────────────────────────────────────
  const [filter, setFilter] = useState<SortFilter>(DEFAULT_SORT_FILTER);
  const [query, setQuery] = useState("");
  const genres = useMemo(() => genreOptions(likes), [likes]);

  const viewCounts = useMemo(() => {
    const counts: Record<SortView, number> = { unsorted: 0, marked: 0, later: 0, all: 0 };
    for (const view of Object.keys(counts) as SortView[]) {
      counts[view] = filterTracks(likes, session, { ...filter, view }, inDestination).length;
    }
    return counts;
  }, [likes, session, filter, inDestination]);

  const viewOptions = useMemo(
    () =>
      [
        { value: "unsorted", label: `Unsorted (${viewCounts.unsorted})` },
        { value: "marked", label: `Marked (${viewCounts.marked})` },
        { value: "later", label: `Later (${viewCounts.later})` },
        { value: "all", label: `All (${viewCounts.all})` },
      ] as const,
    [viewCounts],
  );

  const filtered = useMemo(() => filterTracks(likes, session, filter, inDestination), [likes, session, filter, inDestination]);
  const shown = useMemo(() => filterBySearch(filtered, query, trackText), [filtered, query]);

  // Position in the whole likes list (in the chosen order), so "next" still
  // works after the current track leaves the view (marking it in Unsorted).
  const fullOrder = useMemo(() => {
    const ordered = filter.order === "oldest" ? [...likes].reverse() : likes;
    return new Map(ordered.map((t, i) => [t.id, i]));
  }, [likes, filter.order]);

  const trackById = useMemo(() => new Map(likes.map((t) => [t.id, t])), [likes]);
  const current: SortTrack | null =
    (session.currentTrackId !== null ? trackById.get(session.currentTrackId) : undefined) ?? shown[0] ?? null;

  // Pin the track on screen: when it came from "first in view", marking it
  // in Unsorted would otherwise swap the card to the next track under the
  // user's hands.
  useEffect(() => {
    if (hydrated && current && session.currentTrackId !== current.id) dispatch({ type: "setCurrent", trackId: current.id });
  }, [hydrated, current, session.currentTrackId]);

  const step = useCallback(
    (direction: 1 | -1) => {
      if (shown.length === 0) return;
      const at = current ? fullOrder.get(current.id) ?? -1 : -1;
      const candidates = direction === 1 ? shown : [...shown].reverse();
      const next = candidates.find((t) => {
        const pos = fullOrder.get(t.id) ?? -1;
        return direction === 1 ? pos > at : pos < at;
      });
      if (next) dispatch({ type: "setCurrent", trackId: next.id });
      else announce(direction === 1 ? "That was the last track in this view" : "This is the first track in this view");
    },
    [shown, current, fullOrder, announce],
  );

  // ── Player ─────────────────────────────────────────────────────────────────
  const [playerMode, setPlayerMode] = useState<PlayerMode>("own");
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SORT_PLAYER_KEY);
      if (saved === "own" || saved === "embed") setPlayerMode(saved);
    } catch {
      // Storage blocked: keep the default.
    }
  }, []);
  const choosePlayerMode = (mode: PlayerMode) => {
    setPlayerMode(mode);
    try {
      window.localStorage.setItem(SORT_PLAYER_KEY, mode);
    } catch {
      // Remembered for this visit only.
    }
  };
  const playerRef = useRef<PlayerHandle>(null);
  const [player, setPlayer] = useState<PlayerState>({ playing: false, positionMs: 0, durationMs: 0, loading: false, error: null, previewOnly: false });
  const wasPlaying = useRef(false);
  const onPlayerState = useCallback((s: PlayerState) => {
    setPlayer(s);
    wasPlaying.current = s.playing || (wasPlaying.current && s.loading);
  }, []);
  // Captured when the track changes: keep playing if the last one was.
  const autoPlayNext = useRef(false);
  const currentId = current?.id ?? null;
  const lastTrackId = useRef<number | null>(null);
  if (currentId !== lastTrackId.current) {
    autoPlayNext.current = wasPlaying.current && lastTrackId.current !== null;
    lastTrackId.current = currentId;
  }

  // ── Destinations ───────────────────────────────────────────────────────────
  const [newTitle, setNewTitle] = useState("");
  const [newTitleError, setNewTitleError] = useState<string | undefined>();
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const counts = useMemo(() => markCounts(session.marks), [session.marks]);
  const suggestions = useMemo(() => (current ? suggestDestinations(current, session.destinations) : []), [current, session.destinations]);
  const currentMarks = current ? session.marks[String(current.id)] ?? [] : [];
  const currentSkipped = current ? session.skipped.includes(current.id) : false;

  const addNewDestination = () => {
    const title = newTitle.trim();
    if (!title) {
      setNewTitleError("Enter a name for the new playlist.");
      return;
    }
    const exists = session.destinations.some((d) => d.title.trim().toLowerCase() === title.toLowerCase());
    if (exists) {
      setNewTitleError("You already have a destination with that name.");
      return;
    }
    dispatch({ type: "addNew", title });
    setNewTitle("");
    setNewTitleError(undefined);
    announce(`Added destination ${title}`);
  };

  const committing = session.commit !== null;
  const [running, setRunning] = useState(false);
  const interrupted = committing && !running;

  const mark = useCallback(
    (key: string) => {
      if (!current || committing) return;
      const dest = sessionRef.current.destinations.find((d) => d.key === key);
      if (!dest) return;
      const had = (sessionRef.current.marks[String(current.id)] ?? []).includes(key);
      dispatch({ type: "toggleMark", trackId: current.id, key });
      announce(`${had ? "Unmarked" : "Marked"} for ${dest.title}`);
      if (!had && sessionRef.current.advanceAfterMark) step(1);
    },
    [current, committing, announce, step],
  );

  const skip = useCallback(() => {
    if (!current || committing) return;
    const was = sessionRef.current.skipped.includes(current.id);
    dispatch({ type: "toggleSkip", trackId: current.id });
    announce(was ? "Back from decide later" : "Moved to decide later");
    if (!was) step(1);
  }, [current, committing, announce, step]);

  const undo = useCallback(() => {
    if (committing || sessionRef.current.history.length === 0) {
      announce("Nothing to undo");
      return;
    }
    dispatch({ type: "undo" });
    announce("Undone");
  }, [committing, announce]);

  // ── Hotkeys ────────────────────────────────────────────────────────────────
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const nowPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (document.querySelector("[aria-modal='true']")) return;
      const key = event.key;
      if (/^[1-9]$/.test(key)) {
        const dest = sessionRef.current.destinations[Number(key) - 1];
        if (dest) {
          event.preventDefault();
          mark(dest.key);
        }
        return;
      }
      const duration = player.durationMs || current?.duration || 0;
      switch (key.toLowerCase()) {
        case "j":
          event.preventDefault();
          step(1);
          return;
        case "k":
          event.preventDefault();
          step(-1);
          return;
        case "s":
          event.preventDefault();
          skip();
          return;
        case "z":
          event.preventDefault();
          undo();
          return;
        case "q":
        case "w":
        case "e":
          if (!duration) return;
          event.preventDefault();
          playerRef.current?.seekTo(duration * ({ q: 0.25, w: 0.5, e: 0.75 } as const)[key.toLowerCase() as "q" | "w" | "e"]);
          return;
        case "?":
          event.preventDefault();
          setShortcutsOpen(true);
          return;
        default:
      }
      if (key === " " && !isActivatable(event.target)) {
        event.preventDefault();
        playerRef.current?.toggle();
      } else if (key === "ArrowRight" || key === "ArrowLeft") {
        if (isActivatable(event.target) && (event.target as HTMLElement).getAttribute("role") === "slider") return;
        event.preventDefault();
        const amount = (event.shiftKey ? 30000 : 10000) * (key === "ArrowRight" ? 1 : -1);
        playerRef.current?.seekBy(amount);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mark, skip, undo, step, player.durationMs, current?.duration]);

  // ── List ───────────────────────────────────────────────────────────────────
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const chooseFromList = (trackId: number) => {
    dispatch({ type: "setCurrent", trackId });
    if (typeof window !== "undefined" && !window.matchMedia("(min-width: 1024px)").matches) {
      nowPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  // ── Commit ─────────────────────────────────────────────────────────────────
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [progress, setProgress] = useState<{ label: string; value: number; max: number } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const markedTotal = Object.keys(session.marks).length;
  const activeDestinations = session.destinations.filter((d) => (counts[d.key] ?? 0) > 0);

  const preview = activeDestinations.map((d) => {
    const marked = counts[d.key] ?? 0;
    const existing = d.playlistId !== null ? playlistById.get(d.playlistId)?.track_count ?? null : 0;
    const total = existing === null ? null : existing + marked;
    let note: string | null = null;
    if (existing !== null && existing > MAX_PLAYLIST_TRACKS) {
      note = `Already holds ${existing} tracks, over SoundCloud's 500 — this one will be refused and its tracks stay marked.`;
    } else if (total !== null && total > MAX_PLAYLIST_TRACKS) {
      const extra = Math.ceil((total - MAX_PLAYLIST_TRACKS) / MAX_PLAYLIST_TRACKS);
      note = `Up to ${total - MAX_PLAYLIST_TRACKS} tracks over 500 go into ${extra === 1 ? `"${d.title} (2)"` : `"${d.title} (2)" … "(${extra + 1})"`}.`;
    }
    return { d, marked, existing, note };
  });

  const runCommit = async () => {
    setConfirmOpen(false);
    setOutcome(null);
    setRunning(true);
    let cur = sortReducer(sessionRef.current, { type: "commitStart" });
    const apply = (action: SortAction) => {
      cur = sortReducer(cur, action);
      dispatch({ type: "load", session: cur });
    };
    dispatch({ type: "load", session: cur });
    let stoppedEarly: string | null = null;

    try {
      const work = cur.destinations
        .map((d) => ({ d, ids: pendingForDestination(cur.commit!, d.key) }))
        .filter((w) => w.ids.length > 0);
      for (let i = 0; i < work.length; i++) {
        const { d, ids } = work[i];
        setProgress({ label: `Adding to "${d.title}" (${i + 1} of ${work.length})`, value: i, max: work.length + (cur.commit!.unlike ? 1 : 0) });
        const body = d.playlistId !== null
          ? { playlistId: d.playlistId, trackIds: ids }
          : { title: d.title, description: d.note.trim() || undefined, trackIds: ids };
        const res = await apiFetch("/api/sort/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        const filed: number[] = Array.isArray(data?.filedTrackIds) ? data.filedTrackIds.map(Number) : [];
        const filedSet = new Set(filed);
        const result: CommitDestinationResult = {
          key: d.key,
          title: d.title,
          status: res.ok ? "done" : "error",
          playlists: Array.isArray(data?.playlists) ? data.playlists : [],
          added: res.ok ? Number(data?.added ?? 0) : filed.length,
          alreadyPresent: res.ok ? Number(data?.alreadyPresent ?? 0) : 0,
          filed,
          notFiled: ids.filter((id) => !filedSet.has(id)),
          error: res.ok ? undefined : errorMessageFromBody(data, "SoundCloud didn't accept this one."),
        };
        apply({ type: "commitDestination", result });
        if (res.status === 429) {
          stoppedEarly = "Stopped early: the hourly limit for sorting was reached. Your remaining marks are kept — commit again later.";
          break;
        }
      }

      if (cur.commit!.unlike && !stoppedEarly) {
        const eligible = unlikeEligible(cur.commit!);
        const batches = chunk(eligible, 100);
        for (let b = 0; b < batches.length; b++) {
          setProgress({ label: `Removing from your likes (${b * 100 + 1}–${b * 100 + batches[b].length} of ${eligible.length})`, value: work.length + b / batches.length, max: work.length + 1 });
          const res = await apiFetch("/api/sort/unlike", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trackIds: batches[b] }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            stoppedEarly = `Removing from likes stopped: ${errorMessageFromBody(data, "the request failed")}. The tracks are in their playlists; commit again to finish removing them.`;
            break;
          }
          const results: Array<{ trackId: number; status: string; error?: string }> = asArray(data?.results);
          const ok = results.filter((r) => r.status === "ok").map((r) => Number(r.trackId));
          const failed = results.filter((r) => r.status === "error").map((r) => ({ trackId: Number(r.trackId), error: r.error ?? "Unlike failed" }));
          apply({ type: "commitUnliked", ok, failed, rateLimited: data?.rateLimited === true });
          if (ok.length) removeTracksFromLikesCache(queryClient, new Set(ok));
          if (data?.rateLimited) {
            stoppedEarly = "SoundCloud's rate limit stopped the removals partway. The tracks are in their playlists; commit again later to finish removing them.";
            break;
          }
        }
      }

      const summary = buildOutcome(cur, stoppedEarly);
      const unfinishedUnlikes = cur.commit!.unlike && unlikeEligible(cur.commit!).length > 0;
      if (unfinishedUnlikes) {
        // Keep the commit so "Resume" can finish the removals; marks that
        // were filed are already cleared.
        setOutcome(summary);
      } else {
        apply({ type: "commitFinish" });
        setOutcome(summary);
      }
    } catch {
      setOutcome({
        ...buildOutcome(cur, null),
        status: "error",
        title: "The commit was interrupted",
        description: "The connection dropped. What finished is kept; press Resume to carry on from where it stopped.",
      });
    } finally {
      setRunning(false);
      setProgress(null);
      void invalidatePlaylistCaches(queryClient);
    }
  };

  const finishWithoutResume = () => {
    dispatch({ type: "commitFinish" });
    announce("Commit closed. Unfinished marks are kept.");
  };

  // ── Render helpers ─────────────────────────────────────────────────────────
  const destTitle = (key: string) => session.destinations.find((d) => d.key === key)?.title ?? "";
  const loading = likesQuery.isLoading || !hydrated;
  const currentIndex = current ? shown.findIndex((t) => t.id === current.id) : -1;

  const nowPanel = (
    <div ref={nowPanelRef} className="scroll-mt-4">
    <Panel
      title="Now sorting"
      description={
        current && currentIndex >= 0
          ? `Track ${currentIndex + 1} of ${shown.length} in this view`
          : current
            ? "Sorted out of this view — press J or Next for the next track"
            : undefined
      }
      actions={
        <IconButton label="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)} variant="ghost">
          <Keyboard className="h-5 w-5" aria-hidden="true" />
        </IconButton>
      }
    >
      {loading ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : !current ? (
        <EmptyState
          as="p"
          icon={<Music className="h-6 w-6" />}
          title={likes.length === 0 ? "No liked tracks found" : "Nothing left in this view"}
          description={likes.length === 0 ? undefined : "Change the view or filters to keep sorting."}
        />
      ) : (
        <div className="space-y-4" data-testid="now-sorting" data-track-id={current.id}>
          <div className="flex min-w-0 items-start gap-3">
            {current.artwork_url ? (
              <img src={current.artwork_url} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
            ) : (
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-muted" aria-hidden="true">
                <Music className="h-6 w-6 text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold text-foreground" data-testid="now-title">{current.title}</p>
              <p className="truncate text-sm text-muted-foreground">{current.user?.username}</p>
              <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {current.genre ? <span>{current.genre}</span> : null}
                {current.duration ? <span>{formatClock(current.duration)}</span> : null}
                {current.access === "preview" ? <span className="text-warning-text">30-second preview only</span> : null}
                {current.permalink_url ? (
                  <a href={current.permalink_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary-text underline-offset-2 hover:underline">
                    Open on SoundCloud <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                ) : null}
              </p>
              {parseTagList(current.tag_list).length > 0 ? (
                <p className="mt-1 truncate text-xs text-muted-foreground-subtle">{parseTagList(current.tag_list).slice(0, 8).join(" · ")}</p>
              ) : null}
            </div>
          </div>

          <SegmentedControl label="Preview player" value={playerMode} options={PLAYER_MODES} onChange={choosePlayerMode} />

          <PreviewPlayer
            ref={playerRef}
            track={current}
            mode={playerMode}
            autoPlay={autoPlayNext.current}
            onState={onPlayerState}
            onEnded={() => undefined}
          />

          <Waveform
            waveformUrl={current.waveform_url}
            positionMs={player.positionMs}
            durationMs={player.durationMs || current.duration || 0}
            onSeek={(ms) => playerRef.current?.seekTo(ms)}
            label={`Seek in ${current.title ?? "this track"}`}
          />

          {player.error ? <InlineAlert variant="error">{player.error}</InlineAlert> : null}
          {player.previewOnly ? (
            <p className="text-xs text-muted-foreground">SoundCloud only offers a 30-second preview of this track.</p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <IconButton label="Previous track (K)" onClick={() => step(-1)}>
              <SkipBack className="h-5 w-5" aria-hidden="true" />
            </IconButton>
            <Button onClick={() => playerRef.current?.toggle()} className="min-w-[7.5rem]" aria-label={player.playing ? "Pause (Space)" : "Play (Space)"}>
              {player.loading && !player.playing ? (
                <LoadingSpinner size="sm" className="text-white" />
              ) : player.playing ? (
                <Pause className="h-5 w-5" aria-hidden="true" />
              ) : (
                <Play className="h-5 w-5" aria-hidden="true" />
              )}
              {player.playing ? "Pause" : "Play"}
            </Button>
            <IconButton label="Next track (J)" onClick={() => step(1)}>
              <SkipForward className="h-5 w-5" aria-hidden="true" />
            </IconButton>
            <Button variant="outline" onClick={skip} disabled={committing} aria-pressed={currentSkipped}>
              <Clock className="h-4 w-4" aria-hidden="true" />
              {currentSkipped ? "In decide later" : "Decide later"}
            </Button>
            <Button variant="ghost" onClick={undo} disabled={committing || session.history.length === 0}>
              <Undo2 className="h-4 w-4" aria-hidden="true" />
              Undo
            </Button>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-foreground">Mark for</h3>
            {session.destinations.length === 0 ? (
              <p className="text-sm text-muted-foreground">Add a destination in the panel to start marking tracks.</p>
            ) : (
              // eslint-disable-next-line jsx-a11y/no-redundant-roles -- Tailwind preflight strips list semantics in WebKit
              <ul role="list" className="flex flex-wrap gap-2">
                {session.destinations.map((d, i) => {
                  const on = currentMarks.includes(d.key);
                  const suggested = !on && suggestions.includes(d.key);
                  return (
                    <li key={d.key} className="min-w-0 max-w-full">
                      <button
                        type="button"
                        aria-pressed={on}
                        disabled={committing}
                        onClick={() => mark(d.key)}
                        className={cn(
                          "touch-44 inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg border px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                          on
                            ? "border-primary bg-primary/15 text-foreground"
                            : suggested
                              ? "border-primary-text border-dashed bg-card text-foreground hover:bg-primary/5"
                              : "border-border bg-card text-foreground hover:bg-surface-hover",
                        )}
                      >
                        {i < SORT_HOTKEY_DESTINATIONS ? (
                          <kbd className="rounded border border-border bg-muted px-1.5 font-mono text-xs text-muted-foreground">{i + 1}</kbd>
                        ) : null}
                        <span className="truncate">{d.title}</span>
                        {suggested ? (
                          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-primary-text">
                            <Sparkles className="h-3 w-3" aria-hidden="true" />
                            Suggested
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <label className="touch-44 flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={session.advanceAfterMark}
              onChange={(e) => dispatch({ type: "setAdvanceAfterMark", value: e.target.checked })}
              className="h-5 w-5 shrink-0 cursor-pointer accent-primary"
            />
            <span className="text-sm text-foreground">Move to the next track after marking</span>
          </label>
        </div>
      )}
    </Panel>
    </div>
  );

  const listPanel = (
    <Panel title="Your likes" description={likes.length ? `${likes.length.toLocaleString()} liked tracks` : undefined}>
      {likesQuery.isError ? (
        <InlineAlert variant="error">Couldn’t load your liked tracks. Try refreshing the page.</InlineAlert>
      ) : loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-xl" />
          ))}
        </div>
      ) : likes.length === 0 ? (
        <EmptyState icon={<Music className="h-6 w-6" />} title="No liked tracks found" />
      ) : (
        <div className="space-y-4">
          {likesTruncated ? (
            <InlineAlert variant="info">
              SoundCloud stopped the crawl before the end of your likes, so the oldest ones aren’t here. They’ll load on a later visit.
            </InlineAlert>
          ) : null}
          <SegmentedControl label="Show" value={filter.view} options={viewOptions} onChange={(view) => setFilter((f) => ({ ...f, view }))} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Genre">
              {(field) => (
                <Select {...field} value={filter.genre} onChange={(e) => setFilter((f) => ({ ...f, genre: e.target.value }))}>
                  <option value="">Any genre</option>
                  {genres.map((g) => (
                    <option key={g.value} value={g.value}>
                      {g.label} ({g.count})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Order">
              {(field) => (
                <Select {...field} value={filter.order} onChange={(e) => setFilter((f) => ({ ...f, order: e.target.value as SortFilter["order"] }))}>
                  {ORDER_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <label className="touch-44 flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={filter.hideInDestination}
              onChange={(e) => setFilter((f) => ({ ...f, hideInDestination: e.target.checked }))}
              className="h-5 w-5 shrink-0 cursor-pointer accent-primary"
            />
            <span className="text-sm text-foreground">
              Hide tracks already in a destination playlist or filed earlier
              {destinationsLoading ? <span className="text-muted-foreground"> (checking playlists…)</span> : null}
            </span>
          </label>
          <ListSearch
            label="Search your liked tracks"
            value={query}
            onChange={setQuery}
            shown={shown.length}
            total={filtered.length}
            noun={filtered.length === 1 ? "track" : "tracks"}
            placeholder="Search title, artist, genre or tag…"
          />
          {shown.length === 0 ? (
            <EmptyState as="p" className="min-h-[160px] py-8" title="No tracks in this view" description="Try another view, genre or search." />
          ) : (
            <div ref={listRef} className="max-h-[60dvh] overflow-y-auto overscroll-contain pr-1" data-testid="sort-list">
              {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- Tailwind preflight strips list semantics in WebKit */}
              <ul role="list" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((row) => {
                  const t = shown[row.index];
                  const marks = session.marks[String(t.id)] ?? [];
                  const isCurrent = current?.id === t.id;
                  return (
                    <li
                      key={t.id}
                      className="absolute left-0 top-0 w-full"
                      style={{ height: ROW_HEIGHT, transform: `translateY(${row.start}px)` }}
                    >
                      <button
                        type="button"
                        onClick={() => chooseFromList(t.id)}
                        aria-current={isCurrent ? "true" : undefined}
                        className={cn(
                          "flex h-[60px] w-full min-w-0 items-center gap-3 rounded-lg border px-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          isCurrent ? "border-primary bg-primary/10" : "border-transparent hover:bg-surface-hover",
                        )}
                      >
                        {t.artwork_url ? (
                          <img src={t.artwork_url} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded object-cover" />
                        ) : (
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted" aria-hidden="true">
                            <Music className="h-4 w-4 text-muted-foreground" />
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">{t.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {t.user?.username}
                            {marks.length ? ` · ${marks.map(destTitle).join(", ")}` : ""}
                            {session.skipped.includes(t.id) ? " · Decide later" : ""}
                            {inDestination.has(t.id) ? " · Already in a destination" : ""}
                          </span>
                        </span>
                        {t.duration ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatClock(t.duration)}</span> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  );

  const destinationsPanel = (
    <Panel title="Destinations" description="Each one is a playlist. Number keys 1–9 mark the current track.">
      <div className="space-y-4">
        <PlaylistChooser
          label="Add an existing playlist"
          dialogTitle="Your playlists"
          playlists={playlists}
          value={null}
          onChange={(p) => {
            dispatch({ type: "addExisting", playlistId: Number(p.id), title: p.title });
            announce(`Added destination ${p.title}`);
          }}
          disabledReasons={new Map(existingDestinationIds.map((id) => [id, "already a destination"]))}
          loading={playlistsQuery.isLoading}
          loadError={playlistsQuery.isError}
          onRetry={() => playlistsQuery.refetch()}
          placeholder="Choose a playlist"
          unavailableText="No playlists found"
        />
        <div className="flex items-end gap-3">
          <Field label="Or a new playlist" error={newTitleError} className="min-w-0 flex-1">
            {(field) => (
              <Input
                {...field}
                value={newTitle}
                maxLength={100}
                disabled={committing}
                onChange={(e) => {
                  setNewTitle(e.target.value);
                  setNewTitleError(undefined);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addNewDestination();
                  }
                }}
                placeholder="e.g. Tech House"
                className="h-11"
              />
            )}
          </Field>
          <Button variant="outline" onClick={addNewDestination} disabled={committing} className="h-11">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add
          </Button>
        </div>

        {session.destinations.length > 0 ? (
          // eslint-disable-next-line jsx-a11y/no-redundant-roles -- Tailwind preflight strips list semantics in WebKit
          <ol role="list" className="space-y-2" data-testid="destinations">
            {session.destinations.map((d, i) => {
              const existing = d.playlistId !== null ? playlistById.get(d.playlistId) : undefined;
              return (
                <li key={d.key} className="rounded-lg border border-border p-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-5 shrink-0 text-center font-mono text-xs text-muted-foreground">{i < SORT_HOTKEY_DESTINATIONS ? i + 1 : ""}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-foreground">{d.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {d.playlistId === null ? "New playlist" : existing ? `${existing.track_count} tracks now` : "Existing playlist"}
                        {" · "}
                        {counts[d.key] ?? 0} marked
                      </span>
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => setNoteOpen(noteOpen === d.key ? null : d.key)} aria-expanded={noteOpen === d.key}>
                      Note
                    </Button>
                    <IconButton label={`Remove ${d.title}`} variant="ghost" size="sm" disabled={committing} onClick={() => dispatch({ type: "removeDestination", key: d.key })}>
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                  </div>
                  {noteOpen === d.key ? (
                    <Field
                      label={`Note for ${d.title}`}
                      hint={d.playlistId === null ? "Becomes the new playlist's description." : "For you only — an existing playlist's description is never changed."}
                      className="mt-3"
                    >
                      {(field) => (
                        <textarea
                          {...field}
                          value={d.note}
                          maxLength={1000}
                          rows={3}
                          disabled={running}
                          onChange={(e) => dispatch({ type: "setNote", key: d.key, note: e.target.value })}
                          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      )}
                    </Field>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : null}

        <div className="rounded-lg bg-secondary/20 p-4">
          <div className="text-sm text-muted-foreground">Marked tracks</div>
          <div className="text-2xl font-bold text-foreground" data-testid="marked-total">{markedTotal}</div>
          <div className="text-xs text-muted-foreground">
            {session.skipped.length} in decide later
          </div>
        </div>

        <label className="touch-44 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={session.unlikeAfterCommit}
            disabled={committing}
            onChange={(e) => dispatch({ type: "setUnlikeAfterCommit", value: e.target.checked })}
            className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-primary"
          />
          <span className="text-sm text-foreground">
            Remove filed tracks from my likes
            <span className="block text-xs text-muted-foreground">
              Only tracks that reached every playlist you marked them for. Anything that failed stays liked.
            </span>
          </span>
        </label>

        {!storageOk ? (
          <InlineAlert variant="warning">This browser isn’t saving the session, so it will be lost if you close the page.</InlineAlert>
        ) : null}
      </div>

      <ActionBar layout="stretch">
        <Button onClick={() => setConfirmOpen(true)} disabled={committing || markedTotal === 0}>
          Add {markedTotal} track{markedTotal === 1 ? "" : "s"} to {activeDestinations.length} playlist{activeDestinations.length === 1 ? "" : "s"}
        </Button>
        <Button variant="ghost" onClick={() => setClearOpen(true)} disabled={committing || (session.destinations.length === 0 && markedTotal === 0 && session.skipped.length === 0)}>
          Clear session
        </Button>
      </ActionBar>
    </Panel>
  );

  return (
    <PageContainer kind="workbench">
      <PageHeader
        title="Sort Likes"
        description="Listen through your likes, mark each track for one or more playlists, then add them all in one go. Saved in this browser until you commit."
      />

      <div className="space-y-6">
        {progress ? (
          <Panel title="Committing…">
            <ProgressBar value={progress.value} max={progress.max} label={progress.label} />
          </Panel>
        ) : null}

        {outcome ? (
          <ResultPanel
            key={outcome.id}
            status={outcome.status}
            title={outcome.title}
            description={outcome.description}
            announcement={`${outcome.title}. ${outcome.description}`}
            onDismiss={() => setOutcome(null)}
          >
            {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- Tailwind preflight strips list semantics in WebKit */}
            <ul role="list" className="space-y-3" data-testid="commit-summary">
              {outcome.results.map((r) => (
                <li key={r.key} className="rounded-lg border border-border px-4 py-3">
                  <p className="font-semibold text-foreground">{r.title}</p>
                  {r.status === "done" ? (
                    <p className="text-sm text-muted-foreground">
                      {r.added} added{r.alreadyPresent ? `, ${r.alreadyPresent} already there` : ""}
                    </p>
                  ) : (
                    <p className="text-sm text-destructive-text">
                      {r.error} {r.notFiled.length ? `${r.notFiled.length} track${r.notFiled.length === 1 ? "" : "s"} still marked.` : ""}
                    </p>
                  )}
                  {r.playlists.length ? (
                    // eslint-disable-next-line jsx-a11y/no-redundant-roles -- Tailwind preflight strips list semantics in WebKit
                    <ul role="list" className="mt-2 flex flex-wrap gap-2">
                      {r.playlists.map((p) =>
                        p.permalink_url ? (
                          <li key={p.id}>
                            <a
                              href={p.permalink_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-primary/10 px-3 text-sm font-semibold text-primary-text hover:bg-primary/15"
                            >
                              {p.title}
                              {p.created ? " (new)" : ""} · {p.trackCount}
                              <ExternalLink className="h-3 w-3" aria-hidden="true" />
                            </a>
                          </li>
                        ) : (
                          <li key={p.id} className="text-sm text-muted-foreground">
                            {p.title} · {p.trackCount}
                          </li>
                        ),
                      )}
                    </ul>
                  ) : null}
                </li>
              ))}
              {outcome.unlikeRequested ? (
                <li className="rounded-lg border border-border px-4 py-3 text-sm text-foreground">
                  Removed {outcome.unliked} from your likes.
                  {outcome.unlikeFailed ? ` ${outcome.unlikeFailed} couldn’t be removed.` : ""}
                  {outcome.keptLiked ? ` ${outcome.keptLiked} kept liked because a playlist didn’t take them.` : ""}
                  {outcome.unlikeStopped ? " SoundCloud’s rate limit stopped the rest." : ""}
                </li>
              ) : null}
            </ul>
          </ResultPanel>
        ) : null}

        {interrupted ? (
          <InlineAlert variant="warning" title="A commit didn’t finish">
            <p>
              {session.commit!.results.filter((r) => r.status === "done").length} destination(s) were done before it stopped. Resume carries on
              {session.commit!.unlike ? ", including removing filed tracks from your likes" : ""}; nothing is written twice.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <Button onClick={runCommit}>Resume</Button>
              <Button variant="ghost" onClick={finishWithoutResume}>
                Close it — keep the unfinished marks
              </Button>
            </div>
          </InlineAlert>
        ) : null}

        <ToolLayout
          main={
            <div className="space-y-6">
              {nowPanel}
              {listPanel}
            </div>
          }
          aside={destinationsPanel}
        />
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={`Add ${markedTotal} track${markedTotal === 1 ? "" : "s"} to SoundCloud?`}
        description={
          session.unlikeAfterCommit
            ? "Then the tracks that reach every playlist they’re marked for are removed from your likes."
            : "Your likes are left as they are."
        }
        confirmLabel="Add them"
        onConfirm={runCommit}
        onCancel={() => setConfirmOpen(false)}
      >
        {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- Tailwind preflight strips list semantics in WebKit */}
        <ul role="list" className="space-y-2 text-sm" data-testid="commit-preview">
          {preview.map(({ d, marked, existing, note }) => (
            <li key={d.key} className="rounded-lg border border-border px-3 py-2">
              <span className="font-semibold text-foreground">{d.title}</span>{" "}
              <span className="text-muted-foreground">
                {d.playlistId === null ? `new playlist, ${marked} track${marked === 1 ? "" : "s"}` : `+${marked} (now ${existing ?? "?"})`}
              </span>
              {note ? <span className="mt-1 block text-warning-text">{note}</span> : null}
            </li>
          ))}
        </ul>
      </ConfirmDialog>

      <ConfirmDialog
        open={clearOpen}
        title="Clear this sorting session?"
        description="Removes your destinations, marks and decide-later pile from this browser. Nothing on SoundCloud changes."
        confirmLabel="Clear session"
        variant="destructive"
        onConfirm={() => {
          dispatch({ type: "clearSession" });
          setClearOpen(false);
          announce("Session cleared");
        }}
        onCancel={() => setClearOpen(false)}
      />

      <Dialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} title="Keyboard shortcuts" size="md" variant="sheet">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys} className="contents">
              <dt>
                <kbd className="rounded border border-border bg-muted px-1.5 font-mono text-xs text-foreground">{keys}</kbd>
              </dt>
              <dd className="text-foreground">{what}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-muted-foreground">
          Shortcuts pause while you type in a field. In the SoundCloud embed, click outside the player to give them back to the page.
        </p>
      </Dialog>
    </PageContainer>
  );
}
