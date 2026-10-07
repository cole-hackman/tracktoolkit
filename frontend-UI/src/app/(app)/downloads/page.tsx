"use client";

import { useState, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowLeft, Download, ExternalLink, Heart, ListMusic, Trash2, X, CheckSquare, Search, Zap } from "lucide-react";
import { apiFetch, readApiErrorMessage } from "@/lib/api";
import { startSoundCloudDownload } from "@/lib/download";
import { downloadedLabel, downloadedMap } from "@/lib/download-history";
import { DownloadQueuePanel, DownloadQueueSheet, useDownloadQueue } from "@/components/downloads/DownloadQueue";
import {
  type DownloadFilter,
  type DownloadKind,
  type DownloadStatus,
  downloadStatus,
  isFreeDownload,
  matchesFilter,
  storeSearchLinks,
} from "@/lib/download-status";
import { useAuth } from "@/contexts/AuthContext";
import {
  Button,
  BulkReviewDetails,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  InlineAlert,
  Input,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  ProgressBar,
  Select,
  Skeleton,
  TrackRow,
  useAnnounce,
} from "@/components/ui";
import {
  invalidatePlaylistCaches,
  queryKeys,
  useDownloadHistoryQuery,
  useLikesQuery,
  useMeQuery,
  usePlaylistDetailQuery,
  usePlaylistsQuery,
} from "@/lib/queries";
import { asArray } from "@/lib/api-shape";

interface Playlist {
  id: number;
  title: string;
  track_count: number;
  artwork_url: string;
  coverUrl?: string;
  kind?: "playlist";
}

interface Track {
  id: number;
  title: string;
  user: { username: string };
  artwork_url: string;
  duration: number;
  downloadable?: boolean | string;
  download_url?: string;
  access?: string;
  purchase_url?: string;
  purchase_title?: string;
  permalink_url: string;
}

interface HypedditQueueItem {
  id: number;
  title: string;
  artist: string;
  hypedditUrl: string;
}

interface HypedditProgress {
  total: number;
  index: number;
  completed: number;
  failed: number;
  active: boolean;
}

const LIKED_TRACKS_ID = -1;

const FILTER_LABELS: Record<DownloadFilter, string> = {
  downloadable: "Downloadable",
  buy: "To buy or pre-order",
  unavailable: "Not available",
  all: "Everything",
};

/**
 * Status chips: a word, coloured by token. The colour is decoration — the
 * word is the status — and every text token here is gated on `--card` by
 * `npm run contrast`, which is why the chip carries its own card surface.
 */
const CHIP_TONE: Record<DownloadKind, string> = {
  direct: "text-success-text",
  gate: "text-primary-text",
  store: "text-muted-foreground",
  preorder: "text-warning-text",
  link: "text-muted-foreground",
  blocked: "text-destructive-text",
  none: "text-muted-foreground",
};

// Rows rendered per step. A large library is hundreds of rows (one real
// account: 1,310 likes, 10k DOM nodes); render a page at a time instead.
const ROW_STEP = 200;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export default function DownloadsPage() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const { user } = useAuth();
  // Gated server-side: /api/auth/me returns canDownload based on the
  // DOWNLOAD_ALLOWLIST env (SoundCloud IDs) + admins.
  const isOwner = !!user?.canDownload;
  // "Already downloaded" is admin only (decided 2026-10-07): read from the
  // OperationLog rows downloads already leave, so nothing new is stored.
  const isAdmin = !!user?.isAdmin;
  const historyQuery = useDownloadHistoryQuery({ enabled: isAdmin });
  const downloadedAt = useMemo(() => downloadedMap(historyQuery.data?.tracks), [historyQuery.data]);
  const [hideDownloaded, setHideDownloaded] = useState(false);
  const refreshHistory = () => {
    if (isAdmin) queryClient.invalidateQueries({ queryKey: queryKeys.downloadHistory() });
  };

  const [selectedSource, setSelectedSource] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [sourceSearch, setSourceSearch] = useState("");
  // Opens on what the page is for. The other buckets are one choice away.
  const [filter, setFilter] = useState<DownloadFilter>("downloadable");
  const [visibleCount, setVisibleCount] = useState(ROW_STEP);

  // Selection mode (remove from playlist)
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<number>>(new Set());
  const [isRemoving, setIsRemoving] = useState(false);

  // Confirmation dialog + inline error
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [downloadingTrackId, setDownloadingTrackId] = useState<number | null>(null);
  // A failed download is reported in its own row, not in the page banner —
  // the banner sits at the top of a list that can be hundreds of rows long,
  // so a click on row 28 showed its error 27 rows out of sight.
  const [downloadError, setDownloadError] = useState<{ id: number; message: string } | null>(null);

  // Hypeddit batch mode
  const [hypedditMode, setHypedditMode] = useState(false);
  const [selectedHypedditIds, setSelectedHypedditIds] = useState<Set<number>>(new Set());
  const [extInstalled, setExtInstalled] = useState(false);
  const [hypedditProgress, setHypedditProgress] = useState<HypedditProgress | null>(null);
  const [queueSent, setQueueSent] = useState(false);

  const queue = useDownloadQueue(announce);
  const hasQueue = queue.hydrated && queue.state.items.length > 0;

  const playlistsQuery = usePlaylistsQuery();
  const meQuery = useMeQuery();
  const isLikedSource = selectedSource?.id === LIKED_TRACKS_ID;
  const likesQuery = useLikesQuery({ enabled: isLikedSource });
  const playlistDetailQuery = usePlaylistDetailQuery(selectedSource?.id ?? 0, {
    enabled: selectedSource != null && !isLikedSource,
    // Blocked tracks must be in the list or they can't be seen, removed, or
    // kept: the server refuses a write that drops one nobody named.
    allAccess: true,
  });

  const loading = playlistsQuery.isLoading;
  const loadingTracks =
    selectedSource != null && (isLikedSource ? likesQuery.isLoading : playlistDetailQuery.isLoading);

  const playlists = useMemo(
    () => asArray<Playlist>(playlistsQuery.data?.collection),
    [playlistsQuery.data?.collection],
  );
  const likesCount =
    (meQuery.data?.public_favorites_count as number | undefined) ??
    (meQuery.data?.likes_count as number | undefined) ??
    null;

  // Keep a local, mutable copy of the current source's tracks — synced from
  // whichever query is active for the selected source, and updated directly
  // after a remove so the UI reflects it immediately (same pattern as
  // playlist-health-check).
  useEffect(() => {
    if (!selectedSource) {
      setTracks([]);
      return;
    }
    if (isLikedSource) {
      setTracks(asArray<Track>(likesQuery.data?.collection));
    } else if (playlistDetailQuery.data) {
      setTracks(asArray<Track>(playlistDetailQuery.data.tracks));
    }
  }, [selectedSource, isLikedSource, likesQuery.data, playlistDetailQuery.data]);

  useEffect(() => {
    const urlParam = new URLSearchParams(window.location.search).get("url");
    if (urlParam) setSourceSearch(urlParam);
  }, []);

  // Detect extension and load persisted progress on mount
  useEffect(() => {
    setExtInstalled(localStorage.getItem("sc-toolkit-ext-installed") === "1.0");
    const saved = localStorage.getItem("sc-toolkit-hypeddit-progress");
    if (saved) {
      try { setHypedditProgress(JSON.parse(saved)); } catch { /* ignore */ }
    }

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as HypedditProgress;
      setHypedditProgress(detail);
    };
    window.addEventListener("sc-toolkit-progress-update", handler);
    return () => window.removeEventListener("sc-toolkit-progress-update", handler);
  }, []);

  // Re-check extension presence whenever a source is selected
  useEffect(() => {
    if (selectedSource) {
      setExtInstalled(localStorage.getItem("sc-toolkit-ext-installed") === "1.0");
    }
  }, [selectedSource]);

  const handleSelectSource = (p: Playlist) => {
    setSelectedSource(p);
    setFilter("downloadable");
    setVisibleCount(ROW_STEP);
    setSelectionMode(false);
    setHypedditMode(false);
    setSelectedTrackIds(new Set());
    setSelectedHypedditIds(new Set());
    setInlineError(null);
    setQueueSent(false);
  };

  const toggleSelectionMode = () => {
    setSelectionMode(!selectionMode);
    setHypedditMode(false);
    setSelectedTrackIds(new Set());
    setSelectedHypedditIds(new Set());
    setInlineError(null);
  };

  const toggleHypedditMode = () => {
    const entering = !hypedditMode;
    setHypedditMode(entering);
    setSelectionMode(false);
    setSelectedTrackIds(new Set());
    // Entering the mode selects every Hypeddit track, so "Queue" is ready to
    // press — it used to open on "Queue 0 tracks", disabled, until Select All.
    setSelectedHypedditIds(entering ? new Set(hypedditTracks.map((t) => t.id)) : new Set());
    setQueueSent(false);
    setInlineError(null);
  };

  const toggleTrackSelection = (id: number) => {
    const newSelected = new Set(selectedTrackIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedTrackIds(newSelected);
  };

  const toggleHypedditSelection = (id: number) => {
    const newSelected = new Set(selectedHypedditIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedHypedditIds(newSelected);
  };

  const handleRemoveSelected = () => {
    if (!selectedSource || selectedSource.id === LIKED_TRACKS_ID || selectedTrackIds.size === 0) return;

    const remainingCount = tracks.filter((t) => !selectedTrackIds.has(t.id)).length;
    if (remainingCount === 0) {
      setInlineError("Cannot remove all tracks from a playlist. Delete the playlist on SoundCloud instead.");
      return;
    }

    setShowRemoveConfirm(true);
  };

  const executeRemove = async () => {
    if (!selectedSource) return;
    setShowRemoveConfirm(false);
    setInlineError(null);

    const remainingTracks = tracks.filter((t) => !selectedTrackIds.has(t.id));
    const remainingIds = remainingTracks.map((t) => t.id);
    const removedCount = tracks.length - remainingTracks.length;

    setIsRemoving(true);
    try {
      const response = await apiFetch(`/api/playlists/${selectedSource.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracks: remainingIds, remove: [...selectedTrackIds] }),
      });

      if (response.ok) {
        announce(
          `${removedCount} track${removedCount === 1 ? "" : "s"} removed from ${selectedSource.title}`,
          { assertive: true },
        );
        setTracks(remainingTracks);
        setSelectedTrackIds(new Set());
        setSelectionMode(false);
        await invalidatePlaylistCaches(queryClient, selectedSource.id);
      } else {
        setInlineError(
          await readApiErrorMessage(response, "Failed to update playlist. Please try again."),
        );
        // A 409 means the server's view differs from this page's: refetch so
        // "reload and try again" has fresh data. After the message, so the
        // re-crawl does not delay it.
        if (response.status === 409) {
          await invalidatePlaylistCaches(queryClient, selectedSource.id);
        }
      }
    } catch (error) {
      console.error("Failed to remove tracks:", error);
      setInlineError("An error occurred while removing tracks.");
    } finally {
      setIsRemoving(false);
    }
  };

  const sendToExtension = () => {
    const toQueue = hypedditTracks.filter((t) => selectedHypedditIds.has(t.id));
    const queue: HypedditQueueItem[] = toQueue.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.user?.username ?? "",
      hypedditUrl: t.purchase_url!,
    }));
    // Wrap with a timestamp so the poller always sees a changed value, even
    // when the same tracks are queued twice in a row.
    const ts = Date.now();
    localStorage.setItem("sc-toolkit-hypeddit-queue", JSON.stringify({ queue, ts }));
    window.postMessage({ type: "sc-toolkit-queue-set", queue, ts }, "*");
    setQueueSent(true);
    setHypedditMode(false);
    setSelectedHypedditIds(new Set());
  };

  // Export the selected Hypeddit tracks as JSON for the local runner
  // (tools/hypeddit-runner) to import. The same selection as "Queue" — it
  // used to export all of them when nothing was selected.
  const exportQueue = () => {
    const toQueue = hypedditTracks.filter((t) => selectedHypedditIds.has(t.id));
    const queue: HypedditQueueItem[] = toQueue.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.user?.username ?? "",
      hypedditUrl: t.purchase_url!,
    }));
    const blob = new Blob([JSON.stringify({ queue }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "hypeddit-queue.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const dismissProgress = () => {
    localStorage.removeItem("sc-toolkit-hypeddit-progress");
    setHypedditProgress(null);
  };

  // One status per track — the only place "downloadable" is decided
  // (lib/download-status.ts). A blocked track keeps its row so it can be
  // selected and removed, but is never counted or offered as a download.
  const statusById = useMemo(() => new Map(tracks.map((t) => [t.id, downloadStatus(t)])), [tracks]);
  const statusOf = (t: Track): DownloadStatus => statusById.get(t.id) ?? downloadStatus(t);
  const isBlocked = (t: Track) => statusOf(t).kind === "blocked";

  // "Downloadable" means a file the artist lets you have: SoundCloud's own
  // download, or a free gate. A store link is not one, and no longer counts.
  const downloadableTracks = useMemo(
    () => tracks.filter((t) => isFreeDownload(statusById.get(t.id)!)),
    [tracks, statusById],
  );

  const counts = useMemo(() => {
    const c = { direct: 0, gate: 0, buy: 0, unavailable: 0 };
    for (const status of statusById.values()) {
      if (status.kind === "direct") c.direct++;
      else if (status.kind === "gate") c.gate++;
      else if (status.kind === "store" || status.kind === "preorder" || status.kind === "link") c.buy++;
      else c.unavailable++;
    }
    return c;
  }, [statusById]);

  const listedTracks = useMemo(
    () =>
      tracks.filter(
        (t) => matchesFilter(statusById.get(t.id)!, filter, t) && !(hideDownloaded && downloadedAt.has(t.id)),
      ),
    [tracks, statusById, filter, hideDownloaded, downloadedAt],
  );
  const downloadedHere = useMemo(() => tracks.filter((t) => downloadedAt.has(t.id)).length, [tracks, downloadedAt]);

  // SoundCloud's own downloads in this source — what "Download all" queues.
  // Ones already downloaded are left out; a single row's button still
  // downloads one again.
  const directTracks = useMemo(
    () =>
      tracks.filter(
        (t) => statusById.get(t.id)?.kind === "direct" && !!t.download_url && !downloadedAt.has(t.id),
      ),
    [tracks, statusById, downloadedAt],
  );
  const directDownloaded = useMemo(
    () => tracks.filter((t) => statusById.get(t.id)?.kind === "direct" && downloadedAt.has(t.id)).length,
    [tracks, statusById, downloadedAt],
  );

  // A queue that stops (finished, paused, or held by a rate limit) has
  // written new history rows; show them.
  const queueRunning = queue.state.running;
  useEffect(() => {
    if (!queueRunning && queue.summary.started > 0) refreshHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueRunning]);

  const startQueue = () => {
    if (!selectedSource) return;
    queue.begin(
      selectedSource.title,
      directTracks.map((t) => ({
        trackId: t.id,
        title: t.title,
        artist: t.user?.username ?? "",
        downloadUrl: t.download_url!,
      })),
    );
  };

  const hypedditTracks = useMemo(
    () => downloadableTracks.filter((t) => statusById.get(t.id)?.site === "Hypeddit"),
    [downloadableTracks, statusById],
  );

  // How many of the source's tracks are actually downloadable is the whole
  // point of the page, and nothing else says it out loud.
  useEffect(() => {
    if (!selectedSource || loadingTracks) return;
    announce(
      `${downloadableTracks.length} downloadable track${downloadableTracks.length === 1 ? "" : "s"} in ${selectedSource.title}`,
    );
  }, [selectedSource, loadingTracks, downloadableTracks.length, announce]);

  const filteredPlaylists = useMemo(
    () => playlists.filter((p) => p.title.toLowerCase().includes(sourceSearch.toLowerCase())),
    [playlists, sourceSearch],
  );

  const formatDuration = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  /**
   * The download button's surface, as HSL tokens rather than raw palette
   * classes. The hue is decoration — the accessible name (from
   * lib/download-status) says which route a button takes — but it still has
   * to carry its glyph at 3:1, which is why each branch names its foreground.
   * `hover:text-*` is repeated because `IconButton`'s ghost variant sets
   * `hover:text-accent-foreground`.
   */
  const getDownloadTone = (status: DownloadStatus) =>
    status.kind === "direct"
      ? "bg-tone-download text-tone-foreground hover:bg-tone-download/90 hover:text-tone-foreground"
      : "bg-tone-purchase text-tone-foreground hover:bg-tone-purchase/90 hover:text-tone-foreground";

  const handleDownload = async (track: Track) => {
    setDownloadError(null);
    const status = statusOf(track);
    if (status.kind === "blocked") return;

    if (status.kind !== "direct" || !track.download_url) {
      if (status.href) window.open(status.href, "_blank", "noopener,noreferrer");
      return;
    }

    setDownloadingTrackId(track.id);
    const result = await startSoundCloudDownload(track.download_url);
    setDownloadingTrackId(null);
    if (!result.ok) setDownloadError({ id: track.id, message: result.error });
    else refreshHistory();
  };

  const renderDownloadError = (track: Track) =>
    downloadError?.id === track.id ? (
      <InlineAlert variant="error" className="mt-1" onDismiss={() => setDownloadError(null)}>
        {`${track.title}: ${downloadError.message}`}
      </InlineAlert>
    ) : null;

  /** The row's one action: download, open the gate, or go where it's sold. */
  const renderAction = (track: Track, { stopPropagation = false } = {}) => {
    const status = statusOf(track);
    if (status.kind === "blocked" || status.kind === "none") return null;
    if (status.kind === "direct" || status.kind === "gate") {
      return (
        <IconButton
          label={status.actionLabel!}
          disabled={downloadingTrackId === track.id}
          onClick={(e) => {
            if (stopPropagation) e.stopPropagation();
            handleDownload(track);
          }}
          className={getDownloadTone(status)}
        >
          {downloadingTrackId === track.id ? (
            <LoadingSpinner className="h-5 w-5 text-current" />
          ) : (
            <Download className="h-5 w-5" />
          )}
        </IconButton>
      );
    }
    // Store, pre-order or other link: an outbound link that says so — never
    // the download glyph, which is what made a Beatport pre-order read as a
    // download.
    const verb = status.kind === "store" ? "Buy" : status.kind === "preorder" ? "Pre-order" : "Open";
    return (
      <a
        href={status.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={status.actionLabel}
        onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <ExternalLink className="h-4 w-4" aria-hidden="true" />
        {verb}
      </a>
    );
  };

  /** Status chip + the reason in words; for "nothing offered", where to look. */
  const renderStatusLine = (track: Track) => {
    const status = statusOf(track);
    const search = status.kind === "none" ? storeSearchLinks(track) : [];
    const downloaded = downloadedAt.get(track.id);
    return (
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {downloaded && (
          <span className="rounded-md border border-border bg-card px-1.5 py-0.5 font-medium text-success-text">
            {downloadedLabel(downloaded)}
          </span>
        )}
        <span className={`rounded-md border border-border bg-card px-1.5 py-0.5 font-medium ${CHIP_TONE[status.kind]}`}>
          {status.label}
        </span>
        <span className="min-w-0 text-muted-foreground">{status.reason}</span>
        {search.length > 0 && (
          <span className="text-muted-foreground">
            Search:{" "}
            {search.map((link, i) => (
              <span key={link.site}>
                {i > 0 && " · "}
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Search ${link.site} for ${track.title}`}
                  className="font-medium text-primary-text underline underline-offset-2"
                >
                  {link.site}
                </a>
              </span>
            ))}
          </span>
        )}
      </div>
    );
  };

  const hdActive = hypedditProgress?.active ?? false;
  const hdTotal = hypedditProgress?.total ?? 0;
  const hdCompleted = hypedditProgress?.completed ?? 0;
  const hdFailed = hypedditProgress?.failed ?? 0;
  const showProgressBanner = hdTotal > 0;

  // Only computed while the confirm dialog is open — no point building this
  // on every render while it's closed.
  const removeReviewItems = useMemo(() => {
    if (!showRemoveConfirm) return [];
    return tracks
      .filter((track) => selectedTrackIds.has(track.id))
      .map((track) => ({
        id: track.id,
        label: track.title,
        meta: track.user?.username,
      }));
  }, [tracks, selectedTrackIds, showRemoveConfirm]);

  return (
    <PageContainer maxWidth="default">
        <PageHeader
          title="Downloads"
          description="Find downloadable tracks in your library."
        />

        <div className={hasQueue ? "pb-24 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6 lg:pb-0" : undefined}>
        <div className="min-w-0">

        {!selectedSource ? (
          /* Source Selection */
          <Card className="p-4 sm:p-6">
            <h2 className="text-lg sm:text-xl font-bold mb-4 text-foreground">
              Select Source
            </h2>
            {loading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 rounded-lg" />
                ))}
              </div>
            ) : (
              <>
                {/* Search filter */}
                {playlists.length > 5 && (
                  <Field label="Search playlists" labelHidden className="mb-4">
                    {(field) => (
                      <div className="relative">
                        <Search
                          aria-hidden="true"
                          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground-subtle"
                        />
                        <Input
                          {...field}
                          type="search"
                          value={sourceSearch}
                          onChange={(e) => setSourceSearch(e.target.value)}
                          placeholder="Search playlists…"
                          className="h-11 pl-9 bg-transparent dark:text-foreground dark:border-border"
                        />
                      </div>
                    )}
                  </Field>
                )}

                <div className="grid md:grid-cols-2 gap-4">
                  {/* Liked Tracks — always shown */}
                  <button
                    type="button"
                    onClick={() =>
                      handleSelectSource({
                        id: LIKED_TRACKS_ID,
                        title: "Liked Tracks",
                        track_count: likesCount ?? 0,
                        artwork_url: "",
                        kind: "playlist",
                      })
                    }
                    className="flex items-center gap-4 p-4 rounded-xl bg-secondary/20 border-2 border-transparent hover:border-primary transition-all text-left"
                  >
                    <div className="w-16 h-16 rounded-lg bg-gradient-to-br from-[#FF5500] to-[#E64A00] flex items-center justify-center text-primary-foreground shrink-0">
                      <Heart className="w-8 h-8" fill="currentColor" aria-hidden="true" />
                    </div>
                    <div>
                      <div className="font-semibold text-foreground">
                        Liked Tracks
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {likesCount !== null
                          ? `${likesCount.toLocaleString()} liked tracks`
                          : "All your likes"}
                      </div>
                    </div>
                  </button>

                  {filteredPlaylists.map((playlist) => (
                    <button
                      type="button"
                      key={playlist.id}
                      onClick={() => handleSelectSource(playlist)}
                      className="flex items-center gap-4 p-4 rounded-xl bg-secondary/20 border-2 border-transparent hover:border-primary transition-all text-left"
                    >
                      <img
                        src={playlist.coverUrl || playlist.artwork_url || "/brand/icon-192.png"}
                        alt=""
                        width={64}
                        height={64}
                        loading="lazy"
                        decoding="async"
                        className="w-16 h-16 rounded-lg object-cover shrink-0"
                      />
                      <div>
                        <div className="font-semibold text-foreground">
                          {playlist.title}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {plural(playlist.track_count, "track")}
                        </div>
                      </div>
                    </button>
                  ))}

                  {sourceSearch && filteredPlaylists.length === 0 && (
                    <div className="md:col-span-2">
                      <EmptyState
                        title="No playlists match your search"
                        description="Try a different keyword."
                      />
                    </div>
                  )}
                </div>
              </>
            )}
          </Card>
        ) : (
          /* Track List */
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectedSource(null);
                setTracks([]);
                setInlineError(null);
                setHypedditMode(false);
                setSelectionMode(false);
              }}
              className="mb-4 text-muted-foreground"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              Back to sources
            </Button>

            <h2 className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-xl sm:text-2xl font-bold text-foreground">
              {selectedSource.id === LIKED_TRACKS_ID ? (
                <Heart className="w-6 h-6 shrink-0 text-primary" fill="currentColor" aria-hidden="true" />
              ) : (
                <ListMusic className="w-6 h-6 shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 break-words">{selectedSource.title}</span>
              <span className="text-base font-normal text-muted-foreground">
                ({downloadableTracks.length} downloadable)
              </span>
            </h2>

            {!loadingTracks && tracks.length > 0 && (
              <div className="-mt-4 mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <p className="text-sm text-muted-foreground">
                  {plural(counts.direct, "direct download")} · {plural(counts.gate, "free gate")} ·{" "}
                  {counts.buy.toLocaleString()} to buy or pre-order · {counts.unavailable.toLocaleString()} not available
                  {isAdmin && historyQuery.data ? ` · ${downloadedHere.toLocaleString()} already downloaded` : ""}
                </p>
                {!hypedditMode && !selectionMode && (
                  <div className="sm:w-56">
                    <Select
                      label="Show"
                      value={filter}
                      onChange={(e) => {
                        setFilter(e.target.value as DownloadFilter);
                        setVisibleCount(ROW_STEP);
                      }}
                    >
                      {(Object.keys(FILTER_LABELS) as DownloadFilter[]).map((key) => (
                        <option key={key} value={key}>
                          {FILTER_LABELS[key]}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
              </div>
            )}

            {/* Hypeddit progress banner (owner-only) */}
            {isOwner && showProgressBanner && (
              <div className="mb-4 rounded-xl border border-border bg-card px-4 py-3">
                <div className="flex items-start gap-2">
                  <ProgressBar
                    className="min-w-0 flex-1"
                    label={hdActive ? "Downloading" : "Downloaded"}
                    value={hdCompleted}
                    max={hdTotal}
                    detail={hdFailed > 0 ? `${hdFailed} failed` : undefined}
                  />
                  <IconButton label="Dismiss download progress" size="sm" onClick={dismissProgress}>
                    <X className="w-4 h-4" aria-hidden="true" />
                  </IconButton>
                </div>
                {!extInstalled && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Extension not detected — open the panel from the Chrome toolbar to control the download.
                  </p>
                )}
              </div>
            )}

            {/* Queue-sent confirmation (owner-only) */}
            {isOwner && queueSent && (
              <div
                role="status"
                className="mb-4 flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground"
              >
                <Zap className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  Queue sent to extension. Open the Track Toolkit side panel from the Chrome toolbar
                  to watch it run; it starts on its own.
                </span>
                <IconButton label="Dismiss queue message" size="sm" onClick={() => setQueueSent(false)}>
                  <X className="w-4 h-4" aria-hidden="true" />
                </IconButton>
              </div>
            )}

            {/* Inline error */}
            {inlineError && (
              <InlineAlert
                variant="error"
                className="mb-4"
                onDismiss={() => setInlineError(null)}
              >
                {inlineError}
              </InlineAlert>
            )}

            {/* Toolbar */}
            {tracks.length > 0 && (
              <div className="mb-6 flex flex-wrap items-center gap-2">
                {/* Queue every SoundCloud-native download (allow-listed accounts) */}
                {isOwner && directTracks.length > 0 && !selectionMode && !hypedditMode && (
                  <Button onClick={startQueue} disabled={queue.state.running}>
                    <Download className="w-4 h-4" aria-hidden="true" />
                    {directDownloaded > 0 ? `Download all new (${directTracks.length})` : `Download all (${directTracks.length})`}
                  </Button>
                )}
                {isOwner && directTracks.length === 0 && directDownloaded > 0 && !selectionMode && !hypedditMode && (
                  <p className="text-sm text-muted-foreground">
                    All {directDownloaded.toLocaleString()} direct downloads here are already downloaded.
                  </p>
                )}
                {isAdmin && downloadedHere > 0 && !selectionMode && !hypedditMode && (
                  <label className="touch-44 flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={hideDownloaded}
                      onChange={(e) => {
                        setHideDownloaded(e.target.checked);
                        setVisibleCount(ROW_STEP);
                      }}
                      className="h-6 w-6 shrink-0 cursor-pointer accent-primary"
                    />
                    <span className="text-sm text-foreground">Hide tracks I&rsquo;ve already downloaded</span>
                  </label>
                )}

                {/* Remove-from-playlist mode (playlists only, not likes) */}
                {selectedSource.id !== LIKED_TRACKS_ID && !hypedditMode && (
                  !selectionMode ? (
                    <Button
                      onClick={toggleSelectionMode}
                      variant="secondary"
                      className="text-muted-foreground"
                    >
                      <CheckSquare className="w-4 h-4" />
                      Select to Remove
                    </Button>
                  ) : (
                    <>
                      <Button
                        onClick={toggleSelectionMode}
                        variant="secondary"
                        className="text-muted-foreground"
                      >
                        <X className="w-4 h-4" />
                        Cancel
                      </Button>
                      <Button
                        onClick={handleRemoveSelected}
                        disabled={selectedTrackIds.size === 0 || isRemoving}
                        variant="destructive"
                      >
                        {isRemoving ? (
                          <LoadingSpinner className="w-4 h-4 text-current" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                        Remove ({selectedTrackIds.size})
                      </Button>
                    </>
                  )
                )}

                {/* Hypeddit batch mode (owner-only, only when Hypeddit tracks exist) */}
                {isOwner && hypedditTracks.length > 0 && !selectionMode && (
                  !hypedditMode ? (
                    <Button onClick={toggleHypedditMode} variant="secondary">
                      <Zap className="w-4 h-4" />
                      Auto-Download ({hypedditTracks.length})
                    </Button>
                  ) : (
                    <>
                      <Button
                        onClick={toggleHypedditMode}
                        variant="secondary"
                        className="text-muted-foreground"
                      >
                        <X className="w-4 h-4" />
                        Cancel
                      </Button>
                      <Button nowrap
                        onClick={() =>
                          setSelectedHypedditIds(new Set(hypedditTracks.map((t) => t.id)))
                        }
                        variant="secondary"
                        className="text-muted-foreground"
                      >
                        Select All ({hypedditTracks.length})
                      </Button>
                      {selectedHypedditIds.size > 0 && (
                        <Button nowrap
                          onClick={() => setSelectedHypedditIds(new Set())}
                          variant="secondary"
                          className="text-muted-foreground"
                        >
                          Deselect All
                        </Button>
                      )}
                      <Button
                        onClick={sendToExtension}
                        disabled={selectedHypedditIds.size === 0}
                        className="bg-tone-purchase text-tone-foreground hover:bg-tone-purchase/90"
                      >
                        <Zap className="w-4 h-4" />
                        Queue {selectedHypedditIds.size} track{selectedHypedditIds.size !== 1 ? "s" : ""}
                      </Button>
                      <Button
                        onClick={exportQueue}
                        disabled={selectedHypedditIds.size === 0}
                        variant="secondary"
                        className="text-muted-foreground"
                      >
                        Export queue (JSON)
                      </Button>
                      {!extInstalled && (
                        // Visible helper text, not a `title`: the reason a
                        // control may not work has to be readable without a
                        // pointer hover.
                        <p className="w-full text-xs text-muted-foreground-subtle">
                          Queueing needs the Track Toolkit browser extension.
                          &ldquo;Export queue (JSON)&rdquo; saves the same list as a file
                          for the local Hypeddit runner.
                        </p>
                      )}
                    </>
                  )
                )}
              </div>
            )}

            <Card className="p-4 sm:p-6">
              {loadingTracks ? (
                <div className="space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 rounded-lg" />
                  ))}
                </div>
              ) : (hypedditMode ? hypedditTracks : listedTracks).length === 0 ? (
                <EmptyState
                  icon={<Download className="w-12 h-12" />}
                  title={filter === "downloadable" ? "No downloadable tracks found" : `Nothing under “${FILTER_LABELS[filter]}”`}
                  description={
                    filter === "downloadable" && counts.buy + counts.unavailable > 0
                      ? `${counts.buy.toLocaleString()} to buy or pre-order and ${counts.unavailable.toLocaleString()} not available — change “Show” to see them.`
                      : "Try another playlist or source."
                  }
                />
              ) : (
                <div className="space-y-2">
                  {(hypedditMode ? hypedditTracks : listedTracks).slice(0, visibleCount).map((track, index) => {
                    if (selectionMode) {
                      return (
                        <div key={track.id}>
                          <TrackRow
                            track={{ ...track, subtitle: track.user?.username }}
                            isSelected={selectedTrackIds.has(track.id)}
                            onToggle={() => toggleTrackSelection(track.id)}
                            rightSlot={
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">
                                  {formatDuration(track.duration)}
                                </span>
                                {isBlocked(track) ? (
                                  <span className="text-xs font-medium text-destructive-text">Blocked</span>
                                ) : (
                                  renderAction(track, { stopPropagation: true })
                                )}
                              </div>
                            }
                          />
                          {renderDownloadError(track)}
                        </div>
                      );
                    }

                    if (hypedditMode) {
                      return (
                        <TrackRow
                          key={track.id}
                          track={{ ...track, subtitle: track.user?.username }}
                          isSelected={selectedHypedditIds.has(track.id)}
                          onToggle={() => toggleHypedditSelection(track.id)}
                          rightSlot={
                            <span className="text-xs text-muted-foreground">{formatDuration(track.duration)}</span>
                          }
                        />
                      );
                    }

                    return (
                      <div key={track.id}>
                        <div className="flex items-center gap-4 rounded-xl bg-secondary/20 p-3">
                          <span
                            aria-hidden="true"
                            className="hidden w-8 shrink-0 text-center text-sm text-muted-foreground-subtle sm:block"
                          >
                            {index + 1}
                          </span>
                          <img
                            src={track.artwork_url || "/brand/icon-192.png"}
                            alt=""
                            width={40}
                            height={40}
                            loading="lazy"
                            decoding="async"
                            className="h-10 w-10 shrink-0 self-start rounded-lg object-cover"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-semibold text-foreground">
                              {track.title}
                            </div>
                            <div className="truncate text-sm text-muted-foreground">
                              {track.user?.username} • {formatDuration(track.duration)}
                            </div>
                            {renderStatusLine(track)}
                          </div>
                          {renderAction(track)}
                        </div>
                        {renderDownloadError(track)}
                      </div>
                    );
                  })}
                  {(hypedditMode ? hypedditTracks : listedTracks).length > visibleCount && (
                    <div className="pt-2 text-center">
                      <Button variant="secondary" onClick={() => setVisibleCount((n) => n + ROW_STEP)}>
                        Show {Math.min(ROW_STEP, (hypedditMode ? hypedditTracks : listedTracks).length - visibleCount)} more of{" "}
                        {(hypedditMode ? hypedditTracks : listedTracks).length - visibleCount}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </Card>
          </div>
        )}

        </div>
        {hasQueue && (
          <aside className="hidden lg:block">
            <div className="sticky top-6 rounded-xl border border-border bg-card p-4">
              <DownloadQueuePanel
                state={queue.state}
                summary={queue.summary}
                onPause={queue.pause}
                onResume={queue.resume}
                onClear={queue.clear}
              />
            </div>
          </aside>
        )}
        </div>
        {hasQueue && (
          <DownloadQueueSheet
            state={queue.state}
            summary={queue.summary}
            onPause={queue.pause}
            onResume={queue.resume}
            onClear={queue.clear}
          />
        )}

      <ConfirmDialog
        open={showRemoveConfirm}
        title="Remove tracks?"
        description={`Remove ${selectedTrackIds.size} track${selectedTrackIds.size !== 1 ? "s" : ""} from "${selectedSource?.title}"? This cannot be undone.`}
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={executeRemove}
        onCancel={() => setShowRemoveConfirm(false)}
      >
        <BulkReviewDetails
          action="removing"
          warning="This updates the playlist on SoundCloud. Export the selection first if you need a record."
          exportFilename="downloads-remove-selection.csv"
          items={removeReviewItems}
        />
      </ConfirmDialog>
    </PageContainer>
  );
}
