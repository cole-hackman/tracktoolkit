"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  Shuffle,
  Save,
  ArrowUp,
  ArrowDown,
  Trash2,
  Music,
  Download,
  ExternalLink,
  MoreVertical,
  Copy,
  ArrowRightLeft,
  Heart,
  Search,
} from "lucide-react";
import {
  Button,
  BulkReviewDetails,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  InlineAlert,
  Input,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  Select,
  Skeleton,
} from "@/components/ui";
import { apiFetch, errorMessageFromBody } from "@/lib/api";
import { startSoundCloudDownload } from "@/lib/download";
import {
  invalidatePlaylistCaches,
  playlistDetailQueryOptions,
  usePlaylistDetailQuery,
  usePlaylistsQuery,
  useLikesQuery,
} from "@/lib/queries";
import { asArray } from "@/lib/api-shape";

interface Playlist {
  id: number;
  title: string;
  track_count: number;
  artwork_url: string;
  coverUrl?: string; // Backend computed fallback
}

interface Track {
  id: number;
  title: string;
  user: { username: string };
  artwork_url: string;
  duration: number;
  genre?: string;
  downloadable?: boolean | string;
  download_url?: string;
  purchase_url?: string;
  purchase_title?: string;
}

type TrackFilter = "all" | "downloadable" | "buylink";

type TransferAction = "move" | "duplicate";

type BannerState = { tone: "success" | "warning" | "error"; text: string } | null;

/**
 * Row actions are visible at every width, full stop.
 *
 * They used to be `opacity-0 group-hover:opacity-100 sm:opacity-100`: on a
 * touch screen that is an invisible but fully tappable cluster sitting on top
 * of every row — a stray touch reordered or removed a track with nothing on
 * screen to explain it. There is no hover-reveal to preserve on the other
 * side of it either, because from `sm` up the cluster was already permanently
 * visible; reintroducing one would have been a regression for mouse users, so
 * the reveal is gone rather than moved.
 */
const ROW_ACTIONS_CLASS = "flex shrink-0 items-center gap-1";

/**
 * The download affordance for a track row. Both states carry visible text —
 * the old chip said "DL" and put the real meaning in a `title`, which is
 * invisible to touch users and unreliable for a screen reader.
 */
function DownloadChip({
  track,
  busy,
  onDownload,
}: {
  track: Track;
  busy: boolean;
  onDownload: (track: Track) => void;
}) {
  const downloadable = Boolean(track.downloadable) || track.downloadable === "true";
  if (!downloadable) return null;

  if (!track.download_url) {
    return (
      <span className="inline-flex min-h-6 flex-shrink-0 items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-muted-foreground-subtle dark:bg-gray-800">
        <Download className="w-3 h-3" aria-hidden="true" />
        No download link
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onDownload(track);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      disabled={busy}
      aria-label={`Download ${track.title}`}
      className="inline-flex min-h-6 flex-shrink-0 items-center gap-1 rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 transition hover:bg-green-200 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/50"
    >
      <Download className="w-3 h-3" aria-hidden="true" />
      {busy ? "Starting…" : "Download"}
    </button>
  );
}

export default function PlaylistModifierPage() {
  const queryClient = useQueryClient();
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [baselineIds, setBaselineIds] = useState<number[]>([]);
  // The playlist currently on screen, readable from an async save handler.
  const selectedIdRef = useRef<number | null>(null);
  selectedIdRef.current = selectedPlaylist?.id ?? null;
  const [saving, setSaving] = useState(false);
  const [trackFilter, setTrackFilter] = useState<TrackFilter>("all");
  const [loadError, setLoadError] = useState(false);
  const [tracksError, setTracksError] = useState(false);
  // The row's overflow actions live in a `Dialog variant="sheet"` rather than
  // a hand-rolled popover: the old menu was absolutely positioned inside the
  // virtualized scroller, so it was clipped by the scroll container on every
  // row but the first few, and it carried no menu semantics at all.
  const [actionsTrack, setActionsTrack] = useState<Track | null>(null);
  const [transfer, setTransfer] = useState<{
    action: TransferAction;
    track: Track;
  } | null>(null);
  const [transferTargetId, setTransferTargetId] = useState<number | "">("");
  const [transferLoading, setTransferLoading] = useState(false);
  const [banner, setBanner] = useState<BannerState>(null);
  const [trackToRemove, setTrackToRemove] = useState<number | null>(null);
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);
  const [downloadingTrackId, setDownloadingTrackId] = useState<number | null>(null);

  // Liked tracks view state
  const [isLikedTracksView, setIsLikedTracksView] = useState(false);
  const [likedSearch, setLikedSearch] = useState("");
  const [likedGenreFilter, setLikedGenreFilter] = useState("All");
  const [likedDurationFilter, setLikedDurationFilter] = useState("All");
  const [alsoUnlike, setAlsoUnlike] = useState(false);

  const filteredTracks = useMemo(() => tracks.filter((t) => {
    if (trackFilter === "downloadable") return Boolean(t.downloadable) || t.downloadable === "true";
    if (trackFilter === "buylink") return !!t.purchase_url;
    return true;
  }), [tracks, trackFilter]);

  // id -> index within the full (unfiltered) track list, built once per
  // `tracks` change instead of calling tracks.indexOf(track) inside the
  // render loop (O(n) per row => O(n^2) for the whole list).
  const trackIndexById = useMemo(() => {
    const map = new Map<number, number>();
    tracks.forEach((t, i) => map.set(t.id, i));
    return map;
  }, [tracks]);

  const downloadCount = useMemo(
    () => tracks.filter((t) => Boolean(t.downloadable) || t.downloadable === "true").length,
    [tracks],
  );

  // Virtualize the track editor list — only rows scrolled into view get
  // mounted. `virtualRow.index` is the row's index into `filteredTracks`
  // itself, used only to look up the row's data; `globalIndex` (derived
  // from `trackIndexById` below) is still what drives numbering,
  // move-up/down, and removal.
  const listScrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: filteredTracks.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
  });
  const buyLinkCount = useMemo(() => tracks.filter((t) => !!t.purchase_url).length, [tracks]);

  const playlistsQuery = usePlaylistsQuery();
  const playlists = useMemo(
    () => asArray<Playlist>(playlistsQuery.data?.collection),
    [playlistsQuery.data?.collection],
  );
  const selectedPlaylistQuery = usePlaylistDetailQuery(selectedPlaylist?.id ?? 0, {
    enabled: selectedPlaylist != null,
    // Blocked tracks must be in the list: the server refuses a save that
    // would drop a track this page did not explicitly remove.
    allAccess: true,
  });
  const likesQuery = useLikesQuery({ enabled: isLikedTracksView });
  const loading = playlistsQuery.isLoading;
  const loadingTracks = selectedPlaylist != null && selectedPlaylistQuery.isLoading;
  const loadingLikes = isLikedTracksView && likesQuery.isLoading;

  // Parse liked tracks into Track[] shape
  const likedTracks: Track[] = useMemo(() => {
    if (!isLikedTracksView || !likesQuery.data?.collection) return [];
    return asArray<{ track?: Track } & Track>(likesQuery.data.collection).map(
      (item) => {
        const t = item.track || item;
        return {
          id: t.id,
          title: t.title,
          user: t.user,
          artwork_url: t.artwork_url,
          duration: t.duration,
          genre: (t as Track & { genre?: string }).genre,
          downloadable: t.downloadable,
          download_url: t.download_url,
          purchase_url: t.purchase_url,
          purchase_title: t.purchase_title,
        };
      },
    );
  }, [isLikedTracksView, likesQuery.data?.collection]);

  // Filter liked tracks
  const filteredLikedTracks = useMemo(() => {
    return likedTracks
      .filter(
        (t) =>
          !likedSearch ||
          t.title.toLowerCase().includes(likedSearch.toLowerCase()) ||
          t.user?.username?.toLowerCase().includes(likedSearch.toLowerCase())
      )
      .filter((t) => likedGenreFilter === "All" || (t as Track & { genre?: string }).genre === likedGenreFilter)
      .filter((t) => {
        if (likedDurationFilter === "All") return true;
        const mins = t.duration / 60000;
        if (likedDurationFilter === "< 3 mins") return mins < 3;
        if (likedDurationFilter === "3-5 mins") return mins >= 3 && mins <= 5;
        if (likedDurationFilter === "5-10 mins") return mins > 5 && mins <= 10;
        if (likedDurationFilter === "> 10 mins") return mins > 10;
        return true;
      });
  }, [likedTracks, likedSearch, likedGenreFilter, likedDurationFilter]);

  const likedGenres = useMemo(
    () => Array.from(new Set(likedTracks.map((t) => (t as Track & { genre?: string }).genre).filter(Boolean))) as string[],
    [likedTracks],
  );

  useEffect(() => {
    // Errors stay until dismissed: they say what to do next, and a 9 s timer
    // can remove one before it has been read.
    if (!banner || banner.tone === "error" || banner.tone === "warning") return;
    const t = window.setTimeout(() => setBanner(null), 9000);
    return () => clearTimeout(t);
  }, [banner]);

  useEffect(() => {
    if (playlistsQuery.isError) {
      setLoadError(true);
    }
  }, [playlistsQuery.isError]);

  useEffect(() => {
    setSelectedPlaylist((prev) => {
      if (!prev) return prev;
      const next = playlists.find((playlist) => playlist.id === prev.id);
      return next ? { ...prev, ...next } : prev;
    });
  }, [playlists]);

  useEffect(() => {
    if (selectedPlaylistQuery.isError) {
      setTracksError(true);
      return;
    }

    if (selectedPlaylistQuery.data) {
      const loaded = asArray<Track>(selectedPlaylistQuery.data.tracks);
      setTracks(loaded);
      // What this page actually showed the user. Removals are declared
      // against this, not against whatever the query holds at save time: a
      // refetch in between must not turn a track the user never saw into one
      // they "removed".
      setBaselineIds(loaded.map((t) => t.id));
      setTracksError(false);
    }
  }, [selectedPlaylistQuery.data, selectedPlaylistQuery.isError]);

  const selectPlaylist = (playlist: Playlist) => {
    setBanner(null);
    setIsLikedTracksView(false);
    setSelectedPlaylist(playlist);
  };

  const selectLikedTracks = () => {
    setBanner(null);
    setSelectedPlaylist(null);
    setTracks([]);
    setIsLikedTracksView(true);
    setLikedSearch("");
    setLikedGenreFilter("All");
    setLikedDurationFilter("All");
  };

  const goBackToList = () => {
    setBanner(null);
    setSelectedPlaylist(null);
    setTracks([]);
    setIsLikedTracksView(false);
  };

  const removeTrack = (trackId: number) => {
    setTrackToRemove(trackId);
  };

  const executeRemoveTrack = () => {
    if (trackToRemove === null) return;
    setTracks((prev) => prev.filter((t) => t.id !== trackToRemove));
    setTrackToRemove(null);
  };

  const moveTrack = (index: number, direction: "up" | "down") => {
    const newTracks = [...tracks];
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= tracks.length) return;
    [newTracks[index], newTracks[newIndex]] = [
      newTracks[newIndex],
      newTracks[index],
    ];
    setTracks(newTracks);
  };

  const shuffleTracks = () => {
    const shuffled = [...tracks].sort(() => Math.random() - 0.5);
    setTracks(shuffled);
  };

  const openTransferModal = (action: TransferAction, track: Track) => {
    if (!selectedPlaylist && !isLikedTracksView) return;
    setActionsTrack(null);
    setTransfer({ action, track });
    setAlsoUnlike(false);
    if (isLikedTracksView) {
      // From liked tracks: all playlists are valid targets
      setTransferTargetId(playlists[0]?.id ?? "");
    } else {
      const others = playlists.filter((p) => p.id !== selectedPlaylist!.id);
      const defaultTarget =
        action === "move"
          ? others[0]?.id
          : playlists.find((p) => p.id !== selectedPlaylist!.id)?.id ?? playlists[0]?.id;
      setTransferTargetId(defaultTarget ?? "");
    }
  };

  const submitTransfer = async () => {
    if ((!selectedPlaylist && !isLikedTracksView) || !transfer || transferTargetId === "") return;
    const targetId = Number(transferTargetId);
    if (!isLikedTracksView && transfer.action === "move" && targetId === selectedPlaylist!.id) return;

    setTransferLoading(true);
    try {
      const transferBody: Record<string, unknown> = {
        action: isLikedTracksView ? "duplicate" : transfer.action,
        trackId: transfer.track.id,
        targetPlaylistId: targetId,
      };
      if (!isLikedTracksView && selectedPlaylist) {
        transferBody.sourcePlaylistId = selectedPlaylist.id;
      }
      const res = await apiFetch("/api/playlists/transfer-track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(transferBody),
      });
      let data: Record<string, unknown> = {};
      try {
        data = await res.json();
      } catch {
        /* ignore */
      }

      if (!res.ok) {
        setBanner({
          tone: "error",
          text: typeof data.error === "string" ? data.error : "Transfer failed",
        });
        return;
      }

      if (data.partial) {
        setBanner({
          tone: "warning",
          text:
            typeof data.message === "string"
              ? data.message
              : typeof data.error === "string"
                ? data.error
                : "The track may have been added to the target playlist, but the source could not be updated.",
        });
        setTransfer(null);
        if (selectedPlaylist) {
          await invalidatePlaylistCaches(queryClient, selectedPlaylist.id);
          await Promise.all([selectedPlaylistQuery.refetch(), playlistsQuery.refetch()]);
        } else {
          await playlistsQuery.refetch();
        }
        return;
      }

      if (data.ok === false) {
        setBanner({
          tone: "error",
          text: typeof data.error === "string" ? data.error : "Transfer failed",
        });
        return;
      }

      const targetTitle =
        (typeof data.targetTitle === "string" && data.targetTitle) ||
        playlists.find((p) => p.id === targetId)?.title ||
        "playlist";

      if (data.noop && typeof data.message === "string") {
        setBanner({ tone: "success", text: data.message });
      } else if (transfer.action === "move") {
        setBanner({ tone: "success", text: `Track moved to “${targetTitle}”.` });
      } else {
        setBanner({ tone: "success", text: `Track duplicated to “${targetTitle}”.` });
      }

      // Auto-unlike from liked tracks if checkbox was checked
      if (isLikedTracksView && alsoUnlike) {
        try {
          await apiFetch("/api/likes/tracks/bulk-unlike", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trackIds: [transfer.track.id] }),
          });
        } catch {
          // Unlike failed silently — track is already in target playlist
        }
      }

      setTransfer(null);
      if (selectedPlaylist) {
        await invalidatePlaylistCaches(queryClient, selectedPlaylist.id);
        await Promise.all([selectedPlaylistQuery.refetch(), playlistsQuery.refetch()]);
      } else {
        await Promise.all([likesQuery.refetch(), playlistsQuery.refetch()]);
      }
    } catch {
      setBanner({ tone: "error", text: "Network error — try again." });
    } finally {
      setTransferLoading(false);
    }
  };

  const actionsTrackIndex =
    actionsTrack !== null ? trackIndexById.get(actionsTrack.id) ?? -1 : -1;

  const transferTargetOptions = isLikedTracksView
    ? playlists
    : transfer?.action === "move"
      ? playlists.filter((p) => p.id !== selectedPlaylist?.id)
      : playlists;

  const transferSubmitDisabled =
    transferLoading ||
    transferTargetId === "" ||
    (!isLikedTracksView && transfer?.action === "move" && Number(transferTargetId) === selectedPlaylist?.id);

  const savePlaylist = async () => {
    if (!selectedPlaylist) return;
    setShowSaveConfirm(true);
  };

  const executeSavePlaylist = async () => {
    if (!selectedPlaylist) return;
    setShowSaveConfirm(false);
    setSaving(true);
    const savedId = selectedPlaylist.id;
    // The user may open another playlist while the save is in flight; a result
    // about playlist A must not appear over playlist B.
    const selectionChanged = () => selectedIdRef.current !== savedId;
    try {
      // Everything the page loaded that is no longer in the edited list was
      // removed on purpose; the server only lets a track go if it is named.
      const editedIds = tracks.map((t) => t.id);
      const kept = new Set(editedIds);
      const removedIds = [...new Set(baselineIds.filter((id) => !kept.has(id)))];
      const response = await apiFetch(`/api/playlists/${selectedPlaylist.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracks: editedIds, remove: removedIds }),
      });
      if (response.ok) {
        if (!selectionChanged()) {
          setBanner({ tone: "success", text: "Playlist saved successfully." });
        }
        await invalidatePlaylistCaches(queryClient, savedId);
      } else {
        const body = await response.json().catch(() => null);
        // Only OUT_OF_SYNC means the server's view moved on: that one
        // refetches (which replaces the page's list and drops unsaved edits).
        // READ_INCOMPLETE and every other failure leave the edits in place and
        // just show the server's reason.
        const outOfSync = response.status === 409 && body?.code === "PLAYLIST_OUT_OF_SYNC";
        if (!selectionChanged()) {
          setBanner({
            tone: "error",
            text: outOfSync
              ? "This playlist changed on SoundCloud and has been reloaded. Your edits were not saved — make them again."
              : errorMessageFromBody(body, "Failed to save playlist."),
          });
        }
        if (outOfSync) {
          // Reset the list explicitly from the fresh read: a payload that is
          // structurally identical to the cached one would not re-run the
          // load effect, and the banner would be lying about a reload.
          const fresh = await selectedPlaylistQuery.refetch();
          if (!selectionChanged() && fresh.data) {
            const loaded = asArray<Track>(fresh.data.tracks);
            setTracks(loaded);
            setBaselineIds(loaded.map((t) => t.id));
          }
          await invalidatePlaylistCaches(queryClient, savedId);
        }
      }
    } catch (error) {
      console.error("Error saving playlist:", error);
      setBanner({ tone: "error", text: "An error occurred while saving the playlist." });
    } finally {
      setSaving(false);
    }
  };

  const formatDuration = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const handleDownload = async (track: Track) => {
    if (!track.download_url) return;
    setDownloadingTrackId(track.id);
    const result = await startSoundCloudDownload(track.download_url);
    setDownloadingTrackId(null);
    if (!result.ok) setBanner({ tone: "error", text: result.error });
  };

  // Both only computed while their confirm dialog is open — no point
  // building these on every render while closed.
  const removeTrackReviewItems = useMemo(() => {
    if (trackToRemove === null) return [];
    return tracks
      .filter((track) => track.id === trackToRemove)
      .map((track) => ({
        id: track.id,
        label: track.title,
        meta: track.user?.username,
      }));
  }, [tracks, trackToRemove]);

  const saveReviewItems = useMemo(() => {
    if (!showSaveConfirm) return [];
    return tracks.map((track, index) => ({
      id: track.id,
      label: `${index + 1}. ${track.title}`,
      meta: track.user?.username,
    }));
  }, [tracks, showSaveConfirm]);

  return (
    <PageContainer maxWidth="wide">
        <PageHeader
          title="Playlist Modifier"
          description="Reorder, remove, move, or duplicate tracks between your playlists."
        />

        {banner && (
          <InlineAlert
            variant={banner.tone}
            className="mb-6"
            onDismiss={() => setBanner(null)}
          >
            {banner.text}
          </InlineAlert>
        )}

        {!selectedPlaylist && !isLikedTracksView ? (
          /* Playlist Selection */
          <Card variant="outline" className="rounded-2xl p-4 sm:p-6">
            <h2 className="text-xl font-bold mb-4 text-foreground">
              Select a Playlist to Modify
            </h2>
            {loading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton
                    key={i}
                    className="h-16 rounded-lg bg-gray-100 dark:bg-secondary/40"
                  />
                ))}
              </div>
            ) : loadError ? (
              <EmptyState
                title="Couldn't load your playlists"
                description="The backend may be unreachable. Retry to refresh the list."
                action={
                  <Button
                    onClick={() => {
                      playlistsQuery.refetch();
                    }}
                  >
                    Retry
                  </Button>
                }
              />
            ) : playlists.length === 0 ? (
              <EmptyState
                icon={<Music className="w-12 h-12" />}
                title="No playlists found"
              />
            ) : (
              <div className="grid md:grid-cols-2 gap-4">
                {/* Liked Tracks virtual entry */}
                <button
                  type="button"
                  onClick={selectLikedTracks}
                  className="flex min-h-16 items-center gap-3 sm:gap-4 p-3 sm:p-4 rounded-xl bg-gradient-to-br from-red-50 to-orange-50 dark:from-red-950/20 dark:to-orange-950/20 border-2 border-transparent hover:border-primary transition-all text-left col-span-full"
                >
                  <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-lg bg-gradient-to-br from-[#FF5500] to-[#E64A00] flex items-center justify-center flex-shrink-0">
                    <Heart className="w-6 h-6 sm:w-8 sm:h-8 text-white" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold text-foreground">Liked Tracks</div>
                    <div className="text-sm text-muted-foreground">
                      Browse and add liked tracks to your playlists
                    </div>
                  </div>
                </button>
                {playlists.map((playlist) => (
                  <button
                    key={playlist.id}
                    type="button"
                    onClick={() => selectPlaylist(playlist)}
                    className="flex min-h-16 items-center gap-3 sm:gap-4 p-3 sm:p-4 rounded-xl bg-gray-50 dark:bg-secondary/20 border-2 border-transparent hover:border-primary transition-all text-left"
                  >
                    <img
                      src={playlist.coverUrl || playlist.artwork_url || "/brand/icon-192.png"}
                      alt=""
                      width={64}
                      height={64}
                      loading="lazy"
                      decoding="async"
                      className="w-12 h-12 sm:w-16 sm:h-16 rounded-lg object-cover flex-shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="font-semibold text-foreground truncate">
                        {playlist.title}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {playlist.track_count} tracks
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>
        ) : isLikedTracksView ? (
          /* Liked Tracks View */
          <div>
            <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={goBackToList}
                  className="self-start text-muted-foreground hover:text-primary-text"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  Back to playlists
                </Button>
                <div className="flex items-center gap-2">
                  <Heart className="h-5 w-5 shrink-0 text-[#FF5500]" aria-hidden="true" />
                  <h2 className="text-2xl font-bold text-foreground">
                    Liked Tracks
                  </h2>
                </div>
              </div>
            </div>

            <Card variant="outline" className="rounded-2xl p-4 sm:p-6">
              {/* Search and filter controls */}
              <div className="grid grid-cols-1 gap-3 mb-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Search liked tracks">
                  {(field) => (
                    <div className="relative">
                      <Search
                        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <Input
                        {...field}
                        type="search"
                        value={likedSearch}
                        onChange={(e) => setLikedSearch(e.target.value)}
                        placeholder="Title or artist"
                        className="pl-9 h-11 bg-secondary/20 border-border"
                      />
                    </div>
                  )}
                </Field>
                {likedGenres.length > 0 && (
                  <Select
                    label="Genre"
                    value={likedGenreFilter}
                    onChange={(e) => setLikedGenreFilter(e.target.value)}
                    className="bg-secondary/20"
                  >
                    <option value="All">All Genres</option>
                    {likedGenres.map((g) => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </Select>
                )}
                <Select
                  label="Duration"
                  value={likedDurationFilter}
                  onChange={(e) => setLikedDurationFilter(e.target.value)}
                  className="bg-secondary/20"
                >
                  <option value="All">All Durations</option>
                  <option value="< 3 mins">&lt; 3 mins</option>
                  <option value="3-5 mins">3-5 mins</option>
                  <option value="5-10 mins">5-10 mins</option>
                  <option value="> 10 mins">&gt; 10 mins</option>
                </Select>
              </div>

              <div className="text-sm text-muted-foreground mb-2" role="status">
                {filteredLikedTracks.length} of {likedTracks.length} tracks
              </div>

              {loadingLikes ? (
                <div className="space-y-3">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <Skeleton
                      key={i}
                      className="h-16 rounded-lg bg-gray-100 dark:bg-secondary/40"
                    />
                  ))}
                </div>
              ) : likesQuery.isError ? (
                <EmptyState
                  title="Couldn't load your liked tracks"
                  description="The backend may be unreachable. Retry to refresh."
                  action={<Button onClick={() => likesQuery.refetch()}>Retry</Button>}
                />
              ) : likedTracks.length === 0 ? (
                <EmptyState
                  icon={<Heart className="w-12 h-12" />}
                  title="No liked tracks"
                  description="You haven't liked any tracks yet."
                />
              ) : filteredLikedTracks.length === 0 ? (
                <EmptyState
                  icon={<Music className="w-12 h-12" />}
                  title="No tracks match your filters"
                  description="Try adjusting your search or filters."
                />
              ) : (
                <div className="space-y-2 max-h-[60dvh] overflow-y-auto">
                  {filteredLikedTracks.map((track) => (
                    <div
                      key={track.id}
                      className="flex items-center gap-3 sm:gap-4 p-3 rounded-xl bg-gray-50 dark:bg-secondary/20"
                    >
                      <img
                        src={track.artwork_url || "/brand/icon-192.png"}
                        alt=""
                        width={48}
                        height={48}
                        loading="lazy"
                        decoding="async"
                        className="w-12 h-12 shrink-0 rounded-lg object-cover"
                      />
                      <div className="flex-1 min-w-0">
                        {/* `truncate` belongs on the title, not on this flex
                            row — see the note on the editor row below. */}
                        <div className="flex min-w-0 items-center gap-2 font-semibold text-foreground">
                          <span className="min-w-0 truncate">{track.title}</span>
                          <DownloadChip
                            track={track}
                            busy={downloadingTrackId === track.id}
                            onDownload={handleDownload}
                          />
                        </div>
                        <div className="text-sm text-muted-foreground truncate">
                          {track.user?.username} •{" "}
                          {formatDuration(track.duration)}
                        </div>
                      </div>
                      <div className={ROW_ACTIONS_CLASS}>
                        <IconButton
                          label={`More actions for ${track.title}`}
                          size="sm"
                          onClick={() => setActionsTrack(track)}
                        >
                          <MoreVertical className="w-4 h-4" aria-hidden="true" />
                        </IconButton>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        ) : selectedPlaylist ? (
          /* Track Editor */
          <div>
            <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={goBackToList}
                  className="self-start text-muted-foreground hover:text-primary-text"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  Back to playlists
                </Button>
                <h2 className="min-w-0 truncate text-2xl font-bold text-foreground">
                  {selectedPlaylist.title}
                </h2>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0 sm:gap-3">
                <Button
                  onClick={shuffleTracks}
                  variant="outline"
                >
                  <Shuffle className="w-4 h-4" aria-hidden="true" />
                  Shuffle
                </Button>
                <Button
                  onClick={savePlaylist}
                  disabled={saving}
                >
                  {saving ? (
                    <LoadingSpinner size="sm" className="w-4 h-4 text-white" />
                  ) : (
                    <Save className="w-4 h-4" aria-hidden="true" />
                  )}
                  Save Changes
                </Button>
              </div>
            </div>

            <Card variant="outline" className="rounded-2xl p-4 sm:p-6">
              {/* Filter pills */}
              {!loadingTracks && tracks.length > 0 && (
                <div role="group" aria-label="Filter tracks" className="flex items-center gap-2 mb-4 flex-wrap">
                  {([
                    { key: "all" as TrackFilter, icon: null, label: "All", count: tracks.length },
                    { key: "downloadable" as TrackFilter, icon: "⬇", label: "Downloadable", count: downloadCount },
                    { key: "buylink" as TrackFilter, icon: "🔗", label: "Buy Link", count: buyLinkCount },
                  ]).map(({ key, icon, label, count }) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={trackFilter === key}
                      onClick={() => setTrackFilter(key)}
                      className={`inline-flex min-h-9 items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                        trackFilter === key
                          ? "bg-primary text-primary-foreground"
                          : "bg-gray-100 dark:bg-secondary/20 text-muted-foreground hover:bg-gray-200 dark:hover:bg-secondary/40"
                      }`}
                    >
                      {icon ? <span aria-hidden="true">{icon}</span> : null}
                      {label} ({count})
                    </button>
                  ))}
                </div>
              )}
              {loadingTracks ? (
                <div className="space-y-3">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <Skeleton
                      key={i}
                      className="h-16 rounded-lg bg-gray-100 dark:bg-secondary/40"
                    />
                  ))}
                </div>
              ) : tracksError ? (
                <EmptyState
                  title="Couldn’t load tracks for this playlist"
                  description="The playlist data could not be fetched. Retry to try again."
                  action={
                    <Button onClick={() => selectedPlaylistQuery.refetch()}>Retry</Button>
                  }
                />
              ) : tracks.length === 0 ? (
                <EmptyState
                  icon={<Music className="w-12 h-12" />}
                  title="This playlist has no tracks"
                />
              ) : filteredTracks.length === 0 ? (
                <EmptyState
                  icon={<Music className="w-12 h-12" />}
                  title="No tracks match this filter"
                  description="Try a different filter."
                />
              ) : (
                <div ref={listScrollRef} className="max-h-[60dvh] overflow-y-auto">
                <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const track = filteredTracks[virtualRow.index];
                    const globalIndex = trackIndexById.get(track.id) ?? virtualRow.index;
                    return (
                    <div
                      key={virtualRow.key}
                      data-index={virtualRow.index}
                      ref={rowVirtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                      className="pb-2"
                    >
                    <div
                      className="flex items-center gap-3 sm:gap-4 p-3 rounded-xl bg-gray-50 dark:bg-secondary/20"
                    >
                      <span className="hidden sm:block w-8 text-center text-sm text-muted-foreground-subtle">
                        {globalIndex + 1}
                      </span>
                      <img
                        src={track.artwork_url || "/brand/icon-192.png"}
                        alt=""
                        width={48}
                        height={48}
                        loading="lazy"
                        decoding="async"
                        className="w-12 h-12 shrink-0 rounded-lg object-cover"
                      />
                      <div className="flex-1 min-w-0">
                        {/* `truncate` used to sit on this flex row, which put
                            `white-space: nowrap` on the anonymous flex item
                            holding the bare title text. That item's
                            `min-width: auto` then resolved to its full
                            nowrap min-content width, so the title never
                            shrank — and the `shrink-0` chips after it were
                            pushed past the row's edge and clipped by the same
                            `overflow: hidden`. Invisible, untappable, still
                            in the Tab order, and invisible to a scrollWidth
                            check precisely because the overflow is hidden.
                            Truncating the title itself is what makes room. */}
                        <div className="flex min-w-0 items-center gap-2 font-semibold text-foreground">
                          <span className="min-w-0 truncate">{track.title}</span>
                          <DownloadChip
                            track={track}
                            busy={downloadingTrackId === track.id}
                            onDownload={handleDownload}
                          />
                          {track.purchase_url && (
                            <a
                              href={track.purchase_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              aria-label={`${track.purchase_title || "Buy"} — opens ${track.title} on an external site`}
                              className="inline-flex min-h-6 items-center gap-1 px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 text-xs font-medium flex-shrink-0 hover:bg-blue-200 dark:hover:bg-blue-900/50 transition"
                            >
                              <ExternalLink className="w-3 h-3" aria-hidden="true" />{" "}
                              {track.purchase_title || "Buy"}
                            </a>
                          )}
                        </div>
                        <div className="text-sm text-muted-foreground truncate">
                          {track.user?.username} •{" "}
                          {formatDuration(track.duration)}
                        </div>
                      </div>
                      <div className={ROW_ACTIONS_CLASS}>
                        <IconButton
                          label={`More actions for ${track.title}`}
                          size="sm"
                          onClick={() => setActionsTrack(track)}
                        >
                          <MoreVertical className="w-4 h-4" aria-hidden="true" />
                        </IconButton>
                        {/* Reorder and remove stay in the sheet on a phone —
                            four 44px targets plus the artwork do not fit a
                            360px row. */}
                        <IconButton
                          label="Move up"
                          size="sm"
                          className="hidden sm:inline-flex"
                          onClick={() => moveTrack(globalIndex, "up")}
                          disabled={globalIndex === 0}
                        >
                          <ArrowUp className="w-4 h-4" aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label="Move down"
                          size="sm"
                          className="hidden sm:inline-flex"
                          onClick={() => moveTrack(globalIndex, "down")}
                          disabled={globalIndex === tracks.length - 1}
                        >
                          <ArrowDown className="w-4 h-4" aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label="Remove from playlist"
                          size="sm"
                          variant="destructive"
                          className="hidden sm:inline-flex"
                          onClick={() => removeTrack(track.id)}
                        >
                          <Trash2 className="w-4 h-4" aria-hidden="true" />
                        </IconButton>
                      </div>
                    </div>
                    </div>
                    );
                  })}
                </div>
                </div>
              )}
            </Card>
          </div>
        ) : null}

      <Dialog
        open={actionsTrack !== null}
        onClose={() => setActionsTrack(null)}
        title="Track actions"
        subtitle={actionsTrack?.title}
        variant="sheet"
        size="sm"
      >
        {actionsTrack ? (
          <div className="grid gap-2">
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => openTransferModal("move", actionsTrack)}
            >
              <ArrowRightLeft className="w-4 h-4 shrink-0" aria-hidden="true" />
              {isLikedTracksView ? "Add to playlist…" : "Move to playlist…"}
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => openTransferModal("duplicate", actionsTrack)}
            >
              <Copy className="w-4 h-4 shrink-0" aria-hidden="true" />
              Duplicate to playlist…
            </Button>
            {!isLikedTracksView && (
              <>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  disabled={actionsTrackIndex <= 0}
                  onClick={() => moveTrack(actionsTrackIndex, "up")}
                >
                  <ArrowUp className="w-4 h-4 shrink-0" aria-hidden="true" />
                  Move up
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  disabled={actionsTrackIndex < 0 || actionsTrackIndex === tracks.length - 1}
                  onClick={() => moveTrack(actionsTrackIndex, "down")}
                >
                  <ArrowDown className="w-4 h-4 shrink-0" aria-hidden="true" />
                  Move down
                </Button>
                <Button
                  variant="destructive"
                  className="w-full justify-start"
                  onClick={() => {
                    const id = actionsTrack.id;
                    setActionsTrack(null);
                    removeTrack(id);
                  }}
                >
                  <Trash2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                  Remove from playlist
                </Button>
              </>
            )}
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={transfer !== null && (selectedPlaylist !== null || isLikedTracksView)}
        onClose={() => {
          if (!transferLoading) setTransfer(null);
        }}
        title={
          transfer?.action === "move"
            ? isLikedTracksView
              ? "Add track to playlist"
              : "Move track to playlist"
            : "Duplicate track to playlist"
        }
        subtitle={transfer?.track.title}
        size="sm"
        variant="sheet"
        description={
          isLikedTracksView
            ? "The track will be added to the selected playlist."
            : transfer?.action === "move"
              ? "The track is added to the target playlist first, then removed from this one."
              : "The track is copied to the end of the target playlist. Playlists you don't own aren't listed."
        }
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
            <Button
              variant="outline"
              disabled={transferLoading}
              onClick={() => setTransfer(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={transferSubmitDisabled || transferTargetOptions.length === 0}
              onClick={() => void submitTransfer()}
            >
              {transferLoading ? (
                <LoadingSpinner size="sm" className="w-4 h-4 text-white" />
              ) : null}
              {transfer?.action === "move"
                ? isLikedTracksView
                  ? "Add"
                  : "Move"
                : "Duplicate"}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          {transferTargetOptions.length === 0 ? (
            <InlineAlert variant="error">
              No target playlist available. Create another playlist on SoundCloud first.
            </InlineAlert>
          ) : (
            <Select
              label="Target playlist"
              value={transferTargetId === "" ? "" : String(transferTargetId)}
              onChange={(e) =>
                setTransferTargetId(e.target.value ? Number(e.target.value) : "")
              }
              disabled={transferLoading}
            >
              {transferTargetOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.track_count} tracks)
                </option>
              ))}
            </Select>
          )}
          {isLikedTracksView && (
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="playlist-modifier-also-unlike"
                checked={alsoUnlike}
                onChange={(e) => setAlsoUnlike(e.target.checked)}
                className="h-6 w-6 shrink-0 cursor-pointer accent-primary"
              />
              <label
                htmlFor="playlist-modifier-also-unlike"
                className="cursor-pointer select-none text-sm font-semibold text-foreground"
              >
                Also unlike this track
              </label>
            </div>
          )}
        </div>
      </Dialog>
      <ConfirmDialog
        open={trackToRemove !== null}
        title="Remove track?"
        description="Remove this track from the playlist on save? You can still cancel by not saving changes."
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={executeRemoveTrack}
        onCancel={() => setTrackToRemove(null)}
      >
        <BulkReviewDetails
          action="removing"
          warning="This removes the track locally first. The playlist is not changed on SoundCloud until you save."
          items={removeTrackReviewItems}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={showSaveConfirm}
        title="Save playlist changes?"
        description="Update this playlist on SoundCloud with the current order and removed tracks."
        confirmLabel="Save Changes"
        onConfirm={executeSavePlaylist}
        onCancel={() => setShowSaveConfirm(false)}
      >
        <BulkReviewDetails
          action="saving"
          warning="This writes the visible playlist order to SoundCloud. Export the current track list first if you want a record."
          exportFilename="playlist-save-review.csv"
          items={saveReviewItems}
        />
      </ConfirmDialog>
    </PageContainer>
  );
}
