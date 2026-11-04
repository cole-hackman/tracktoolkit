"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowLeft, Download, Heart, ListMusic, Trash2, X, CheckSquare, Search, Zap } from "lucide-react";
import { apiFetch, readApiErrorMessage } from "@/lib/api";
import { startSoundCloudDownload } from "@/lib/download";
import { downloadedLabel, downloadedMap } from "@/lib/download-history";
import { supportsFolderSave } from "@/lib/download-folder";
import { useGateAnnouncements } from "@/components/downloads/GateRun";
import { DownloadCheckDialog, DownloadQueuePanel, DownloadQueueSheet, useDownloadQueue } from "@/components/downloads/DownloadQueue";
import { DownloadLinkAction, DownloadStatusLine, downloadTone } from "@/components/downloads/DownloadStatus";
import {
  type DownloadFilter,
  type DownloadStatus,
  downloadStatus,
  isFreeDownload,
  matchesFilter,
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
import {
  type GateQueueItem,
  type GateSite,
  EXT_GATES_KEY,
  downloadHypedditQueue,
  EXT_RUN_CAP_DEFAULT,
  extensionGateSites,
  gateQueueItem,
  gateSiteOf,
} from "@/lib/gate-queue";
import { GATE_RUN_STORAGE_KEY, hasGateSection, parseGateRun, parseGateRunJson, type GateRun } from "@/lib/gate-run";

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

const LIKED_TRACKS_ID = -1;
/** "0" when the user turned folder mode off; anything else is on. */
const FOLDER_MODE_KEY = "track-toolkit-download-folder";

const FILTER_LABELS: Record<DownloadFilter, string> = {
  downloadable: "Downloadable",
  buy: "To buy or pre-order",
  unavailable: "Not available",
  all: "Everything",
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

  // Auto-Download batch mode. The names predate Droploud and Cobrand; the
  // tracks it holds are every `isGatePick` gate.
  const [hypedditMode, setHypedditMode] = useState(false);
  const [selectedHypedditIds, setSelectedHypedditIds] = useState<Set<number>>(new Set());
  const [extInstalled, setExtInstalled] = useState(false);
  // Gate sites the installed extension says it can work, beyond Hypeddit.
  const [extGates, setExtGates] = useState<Set<GateSite>>(new Set());
  const backToSourcesRef = useRef<HTMLButtonElement>(null);
  // A send that contains Droploud or Cobrand gates waits here for a yes.
  // Which selection it is, not the tracks: the dialog is modal, so the
  // selection cannot change under it.
  const [confirmSend, setConfirmSend] = useState<"picked" | "auto" | null>(null);
  const [hypedditProgress, setHypedditProgress] = useState<GateRun | null>(null);

  // Rows ticked in the normal list, for "Download N selected": either kind of
  // automatic download, without going through Auto-Download's select-all.
  const [pickedIds, setPickedIds] = useState<Set<number>>(new Set());

  const queue = useDownloadQueue(announce);
  useGateAnnouncements(isOwner ? hypedditProgress : null, announce);

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
    setExtGates(extensionGateSites(localStorage.getItem(EXT_GATES_KEY)));
    const saved = parseGateRunJson(localStorage.getItem(GATE_RUN_STORAGE_KEY));
    if (saved) setHypedditProgress(saved);

    const handler = (e: Event) => {
      const next = parseGateRun((e as CustomEvent).detail);
      if (next) setHypedditProgress(next);
    };
    window.addEventListener("sc-toolkit-progress-update", handler);
    return () => window.removeEventListener("sc-toolkit-progress-update", handler);
  }, []);

  // The extension's content script can write its flags after this page
  // mounts, or a newer extension can be loaded while the page is open, so the
  // flags are read again whenever the tab comes back into view.
  useEffect(() => {
    const reread = () => {
      if (document.visibilityState !== "visible") return;
      setExtInstalled(localStorage.getItem("sc-toolkit-ext-installed") === "1.0");
      setExtGates(extensionGateSites(localStorage.getItem(EXT_GATES_KEY)));
    };
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", reread);
    return () => {
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  }, []);

  // Re-check extension presence whenever a source is selected
  useEffect(() => {
    if (selectedSource) {
      setExtInstalled(localStorage.getItem("sc-toolkit-ext-installed") === "1.0");
      setExtGates(extensionGateSites(localStorage.getItem(EXT_GATES_KEY)));
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
    setPickedIds(new Set());
    setInlineError(null);
  };

  const toggleSelectionMode = () => {
    setSelectionMode(!selectionMode);
    setHypedditMode(false);
    setSelectedTrackIds(new Set());
    setSelectedHypedditIds(new Set());
    setPickedIds(new Set());
    setInlineError(null);
  };

  const toggleHypedditMode = () => {
    const entering = !hypedditMode;
    setHypedditMode(entering);
    setSelectionMode(false);
    setSelectedTrackIds(new Set());
    // Entering the mode selects every Hypeddit track, so "Queue" is ready to
    // press — it used to open on "Queue 0 tracks", disabled, until Select All.
    setSelectedHypedditIds(entering ? new Set(gateTracks.map((t) => t.id)) : new Set());
    setPickedIds(new Set());
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

  const togglePicked = (id: number) => {
    const next = new Set(pickedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setPickedIds(next);
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

  const sendGatesToExtension = (gates: Track[]) => {
    const queue = gates.map(gateItemOf);
    // Wrap with a timestamp so the poller always sees a changed value, even
    // when the same tracks are queued twice in a row.
    const ts = Date.now();
    localStorage.setItem("sc-toolkit-hypeddit-queue", JSON.stringify({ queue, ts }));
    window.postMessage({ type: "sc-toolkit-queue-set", queue, ts }, "*");
    announce("Queue sent to the extension. Gate progress appears in the download queue.");
  };

  const sendToExtension = () => {
    sendGatesToExtension(autoSelected);
    setHypedditMode(false);
    setSelectedHypedditIds(new Set());
  };

  // Export the selected tracks as JSON for the local runner
  // (tools/hypeddit-runner) to import. The same selection as "Queue", minus
  // anything that is not a Hypeddit gate, which the runner does not do. It
  // used to export all of them when nothing was selected.
  const exportQueue = () => {
    downloadHypedditQueue(autoSelected.map(gateItemOf));
  };

  // Both ways of sending a selection to the extension come through here:
  // Droploud and Cobrand gates act on the person's own accounts, so they are
  // confirmed first. Hypeddit and direct downloads go straight through.
  const askBeforeSending = (which: "picked" | "auto", gates: Track[], send: () => void) => {
    const { droploud, cobrand } = countAccountGates(gates);
    if (droploud + cobrand > 0) setConfirmSend(which);
    else send();
  };

  const confirmGateSend = () => {
    const which = confirmSend;
    setConfirmSend(null);
    if (which === "picked") sendPicked();
    else if (which === "auto") sendToExtension();
    // Sending clears the selection, which unmounts the button that opened the
    // dialog, so focus would fall to the body. Cancel keeps that button, and
    // the dialog returns focus to it as usual.
    requestAnimationFrame(() => backToSourcesRef.current?.focus());
  };

  const dismissProgress = () => {
    localStorage.removeItem(GATE_RUN_STORAGE_KEY);
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

  // Folder mode (Chromium only): save into a picked folder as "Artist -
  // Title.ext" instead of handing CDN links to the browser. On by default
  // where supported; the choice is remembered per browser.
  const [folderSupported, setFolderSupported] = useState(false);
  const [folderMode, setFolderMode] = useState(true);
  useEffect(() => {
    setFolderSupported(supportsFolderSave());
    try {
      setFolderMode(window.localStorage.getItem(FOLDER_MODE_KEY) !== "0");
    } catch {
      /* storage blocked: default on */
    }
  }, []);
  const chooseFolderMode = (on: boolean) => {
    setFolderMode(on);
    try {
      window.localStorage.setItem(FOLDER_MODE_KEY, on ? "1" : "0");
    } catch {
      /* storage blocked: it will just default on next time */
    }
  };

  const beginDirectQueue = (toQueue: Track[]) => {
    if (!selectedSource) return;
    void queue.begin(
      selectedSource.title,
      toQueue.map((t) => ({
        trackId: t.id,
        title: t.title,
        artist: t.user?.username ?? "",
        downloadUrl: t.download_url!,
      })),
      { folder: folderSupported && folderMode },
    );
  };
  const startQueue = () => beginDirectQueue(directTracks);

  // What a tick can download without a click per track. Hypeddit gates always
  // qualify; a Droploud or Cobrand gate does only when the extension lists
  // that site in `localStorage['sc-toolkit-ext-gates']`. Any other gate gets
  // no checkbox. The row checkboxes, the "Download N selected" bar and
  // Auto-Download all go through this test, so they cannot disagree.
  const isDirectPick = (t: Track) => statusOf(t).kind === "direct" && !!t.download_url;
  const gateSiteOfTrack = (t: Track): GateSite | null => {
    const status = statusOf(t);
    if (status.kind !== "gate" || !t.purchase_url) return null;
    const site = gateSiteOf(status.site);
    if (site === null) return null;
    return site === "hypeddit" || extGates.has(site) ? site : null;
  };
  const isGatePick = (t: Track) => gateSiteOfTrack(t) !== null;
  const gateItemOf = (t: Track): GateQueueItem => gateQueueItem(t, gateSiteOfTrack(t)!, t.purchase_url!);
  const gateTracks = useMemo(
    () => downloadableTracks.filter(isGatePick),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [downloadableTracks, statusById, extGates],
  );
  const autoSelected = gateTracks.filter((t) => selectedHypedditIds.has(t.id));
  // How many of these gates act on the person's own accounts.
  const countAccountGates = (gates: Track[]) => {
    let droploud = 0;
    let cobrand = 0;
    for (const t of gates) {
      const site = gateSiteOfTrack(t);
      if (site === "droploud") droploud++;
      else if (site === "cobrand") cobrand++;
    }
    return { droploud, cobrand };
  };
  const pickedTracks = useMemo(() => tracks.filter((t) => pickedIds.has(t.id)), [tracks, pickedIds]);
  const pickedDirect = pickedTracks.filter(isDirectPick);
  const pickedGates = pickedTracks.filter((t) => !isDirectPick(t) && isGatePick(t));
  const confirmCounts = countAccountGates(confirmSend === "auto" ? autoSelected : pickedGates);

  const sendPicked = () => {
    if (pickedGates.length > 0) sendGatesToExtension(pickedGates);
    if (pickedDirect.length > 0) beginDirectQueue(pickedDirect);
    setPickedIds(new Set());
  };
  const downloadPicked = () => askBeforeSending("picked", pickedGates, sendPicked);

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
          className={downloadTone(status)}
        >
          {downloadingTrackId === track.id ? (
            <LoadingSpinner className="h-5 w-5 text-current" />
          ) : (
            <Download className="h-5 w-5" />
          )}
        </IconButton>
      );
    }
    return <DownloadLinkAction status={status} stopPropagation={stopPropagation} />;
  };

  const renderStatusLine = (track: Track) => (
    <DownloadStatusLine
      track={track}
      status={statusOf(track)}
      downloadedAt={downloadedAt.get(track.id)}
    />
  );

  // A v1 payload (counts only) keeps the banner; v2 shows the gate section in the queue panel.
  const gateRun = isOwner && hasGateSection(hypedditProgress) ? hypedditProgress : null;
  const hasQueue = (queue.hydrated && queue.state.items.length > 0) || !!gateRun;
  const hdActive = hypedditProgress?.active ?? false;
  const hdTotal = hypedditProgress?.total ?? 0;
  const hdCompleted = hypedditProgress?.completed ?? 0;
  const hdFailed = hypedditProgress?.failed ?? 0;
  const showProgressBanner = hdTotal > 0 && hypedditProgress?.version === 1;

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
        {isOwner && (
          <p className="-mt-2 mb-6 text-sm text-muted-foreground">
            DJing from Rekordbox?{" "}
            <Link href="/rekordbox-gaps/" className="font-medium text-primary-text underline underline-offset-2">
              See which of these you don&rsquo;t have yet
            </Link>
            .
          </p>
        )}

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
              ref={backToSourcesRef}
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
                {isOwner && directTracks.length > 0 && folderSupported && !selectionMode && !hypedditMode && (
                  <label className="touch-44 flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={folderMode}
                      onChange={(e) => chooseFolderMode(e.target.checked)}
                      disabled={queue.state.running}
                      className="h-6 w-6 shrink-0 cursor-pointer accent-primary"
                    />
                    <span className="text-sm text-foreground">Save into a folder I choose, named &ldquo;Artist - Title&rdquo;</span>
                  </label>
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

                {/* Auto-Download batch mode (owner-only, only when a gate the extension can work exists) */}
                {isOwner && gateTracks.length > 0 && !selectionMode && (
                  !hypedditMode ? (
                    <Button onClick={toggleHypedditMode} variant="secondary">
                      <Zap className="w-4 h-4" />
                      Auto-Download ({gateTracks.length})
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
                          setSelectedHypedditIds(new Set(gateTracks.map((t) => t.id)))
                        }
                        variant="secondary"
                        className="text-muted-foreground"
                      >
                        Select All ({gateTracks.length})
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
                        onClick={() => askBeforeSending("auto", autoSelected, sendToExtension)}
                        disabled={selectedHypedditIds.size === 0}
                        className="bg-tone-purchase text-tone-foreground hover:bg-tone-purchase/90"
                      >
                        <Zap className="w-4 h-4" />
                        Queue {selectedHypedditIds.size} track{selectedHypedditIds.size !== 1 ? "s" : ""}
                      </Button>
                      <Button
                        onClick={exportQueue}
                        disabled={!autoSelected.some((t) => gateSiteOfTrack(t) === "hypeddit")}
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
                          &ldquo;Export queue (JSON)&rdquo; saves its Hypeddit gates as a
                          file for the local Hypeddit runner.
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
              ) : (hypedditMode ? gateTracks : listedTracks).length === 0 ? (
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
                  {(hypedditMode ? gateTracks : listedTracks).slice(0, visibleCount).map((track, index) => {
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
                          {isOwner && (isDirectPick(track) || isGatePick(track)) && (
                            <label className="touch-44 flex shrink-0 cursor-pointer items-center justify-center">
                              <input
                                type="checkbox"
                                checked={pickedIds.has(track.id)}
                                onChange={() => togglePicked(track.id)}
                                aria-label={`Select ${track.title}`}
                                className="h-6 w-6 cursor-pointer accent-primary"
                              />
                            </label>
                          )}
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
                  {(hypedditMode ? gateTracks : listedTracks).length > visibleCount && (
                    <div className="pt-2 text-center">
                      <Button variant="secondary" onClick={() => setVisibleCount((n) => n + ROW_STEP)}>
                        Show {Math.min(ROW_STEP, (hypedditMode ? gateTracks : listedTracks).length - visibleCount)} more of{" "}
                        {(hypedditMode ? gateTracks : listedTracks).length - visibleCount}
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {/* Sticky: the list runs to hundreds of rows, and the toolbar is
                  a long scroll back up from the row just ticked. */}
              {isOwner && pickedTracks.length > 0 && !selectionMode && !hypedditMode && (
                <div
                  className={`sticky z-30 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 ${hasQueue ? "bottom-[calc(var(--mobile-nav-h)+6rem)] lg:bottom-3" : "bottom-[calc(var(--mobile-nav-h)+0.75rem)]"}`}
                >
                  <Button
                    onClick={downloadPicked}
                    disabled={pickedDirect.length > 0 && queue.state.running}
                  >
                    <Download className="w-4 h-4" aria-hidden="true" />
                    Download {pickedTracks.length} selected
                  </Button>
                  <Button variant="secondary" className="text-muted-foreground" onClick={() => setPickedIds(new Set())}>
                    <X className="w-4 h-4" aria-hidden="true" />
                    Clear
                  </Button>
                  {pickedGates.length > 0 && !extInstalled && (
                    <p className="w-full text-xs text-muted-foreground-subtle">
                      Gates need the Track Toolkit browser extension.
                    </p>
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
                onConfirmSaved={queue.confirmSaved}
                onRetryChecked={queue.retryChecked}
                multiOk={queue.multiOk}
                gates={gateRun}
                onGatesCleared={dismissProgress}
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
            onConfirmSaved={queue.confirmSaved}
            onRetryChecked={queue.retryChecked}
            multiOk={queue.multiOk}
            gates={gateRun}
            onGatesCleared={dismissProgress}
          />
        )}
        {hasQueue && (
          <DownloadCheckDialog
            check={queue.state.check}
            open={queue.checkOpen}
            onClose={queue.dismissCheck}
            onConfirmSaved={queue.confirmSaved}
            onRetryChecked={queue.retryChecked}
          />
        )}

      {/* The lines go in `description`, not children: that is what the dialog
          names in aria-describedby, so a screen reader reads them on open.
          After a send, confirmGateSend moves focus to "Back to sources". */}
      <ConfirmDialog
        open={confirmSend !== null}
        title="Send these gates to the extension?"
        confirmLabel="Send to extension"
        onConfirm={confirmGateSend}
        onCancel={() => setConfirmSend(null)}
        description={
          <div className="space-y-2 text-foreground">
            {confirmCounts.droploud > 0 && (
              <p>
                {plural(confirmCounts.droploud, "Droploud gate")} will follow, like, comment and repost from your SoundCloud account.
              </p>
            )}
            {confirmCounts.cobrand > 0 && (
              <p>
                {plural(confirmCounts.cobrand, "Cobrand gate")} will sign your phone number up to artist SMS.
              </p>
            )}
            {confirmCounts.cobrand > 0 && (
              <p>Chrome comes to the front for Cobrand gates, at the end of the run.</p>
            )}
            {confirmCounts.droploud + confirmCounts.cobrand > EXT_RUN_CAP_DEFAULT && (
              <p className="text-muted-foreground">
                The extension runs at most {EXT_RUN_CAP_DEFAULT} of these per queue unless you raise the limit in its options; the rest are left for the next run.
              </p>
            )}
          </div>
        }
      />

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
