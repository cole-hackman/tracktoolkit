"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Stethoscope, Music, AlertTriangle, CheckCircle, Trash2 } from "lucide-react";
import {
  Button,
  BulkReviewDetails,
  Card,
  ConfirmDialog,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  Skeleton,
  useAnnounce,
} from "@/components/ui";
import { apiFetch, readApiErrorMessage } from "@/lib/api";
import {
  invalidatePlaylistCaches,
  usePlaylistDetailQuery,
  usePlaylistsQuery,
} from "@/lib/queries";
import { asArray } from "@/lib/api-shape";

interface Playlist {
  id: number;
  title: string;
  track_count: number;
  artwork_url: string;
}

interface Track {
  id: number;
  title: string;
  user: { username: string };
  artwork_url: string;
  duration: number;
  access?: string;
  streamable?: boolean;
  blocked_at?: string | null;
}

type HealthFilter = "all" | "healthy" | "issues";

export default function PlaylistHealthCheckPage() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<HealthFilter>("all");
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const playlistsQuery = usePlaylistsQuery();
  const playlistDetailQuery = usePlaylistDetailQuery(selectedPlaylist?.id ?? 0, {
    enabled: selectedPlaylist != null,
    // Blocked tracks are omitted from SoundCloud's default read, so without
    // this they never appear here and cannot be removed.
    allAccess: true,
  });
  const playlists = asArray<Playlist>(playlistsQuery.data?.collection);
  const loading = playlistsQuery.isLoading;
  const loadingTracks = selectedPlaylist != null && playlistDetailQuery.isLoading;

  useEffect(() => {
    if (playlistsQuery.isError) {
      setNotice({ type: "error", text: "Couldn’t load your playlists. Try refreshing the page." });
    }
  }, [playlistsQuery.isError]);

  useEffect(() => {
    if (playlistDetailQuery.isError) {
      setNotice({ type: "error", text: "Couldn’t load tracks for this playlist." });
      return;
    }

    if (playlistDetailQuery.data) {
      setTracks(asArray<Track>(playlistDetailQuery.data.tracks));
    }
  }, [playlistDetailQuery.data, playlistDetailQuery.isError]);

  // SoundCloud counts entries it will not hand back at any access level
  // (deleted or private). The server refuses to rewrite a playlist it cannot
  // read in full, so a shortfall here means the removal would be refused.
  // Counted the way the server counts (usable integer ids >= 1, like
  // extractOrderedTrackIds), and any mismatch with `track_count` — in either
  // direction — is a read the server would refuse to write back.
  const detailTrackCount = playlistDetailQuery.data?.track_count;
  const detailReadCount = asArray<Track>(playlistDetailQuery.data?.tracks).filter((t) => {
    const id = typeof t?.id === "number" ? t.id : parseInt(String(t?.id), 10);
    return Number.isInteger(id) && id >= 1;
  }).length;
  const readMismatch =
    typeof detailTrackCount === "number" && detailTrackCount !== detailReadCount;
  const unreadableCount = readMismatch ? Math.abs(detailTrackCount - detailReadCount) : 0;

  const selectPlaylist = (playlist: Playlist) => {
    setSelectedPlaylist(playlist);
    setFilter("all");
  };

  const getTrackStatus = (track: Track): { label: string; color: string; bg: string; icon: "ok" | "warn" | "bad" } => {
    if (!track.access || track.access === "playable") {
      return { label: "Playable", color: "text-green-700", bg: "bg-green-100", icon: "ok" };
    }
    if (track.access === "preview") {
      return { label: "Preview Only", color: "text-yellow-700", bg: "bg-yellow-100", icon: "warn" };
    }
    return { label: "Blocked", color: "text-red-700", bg: "bg-red-100", icon: "bad" };
  };

  const isHealthy = useCallback(
    (track: Track) =>
      (!track.access || track.access === "playable") &&
      track.streamable !== false &&
      !track.blocked_at,
    [],
  );

  const healthyTracks = useMemo(() => tracks.filter(isHealthy), [tracks, isHealthy]);
  const healthyCount = healthyTracks.length;
  const issueCount = tracks.length - healthyCount;
  const healthPercent = tracks.length > 0 ? Math.round((healthyCount / tracks.length) * 100) : 100;

  // The percentage and the bar were the only carriers of the verdict, and both
  // said it in colour. The word is the state; the colour is emphasis.
  const verdict =
    healthPercent === 100 ? "Healthy" : healthPercent >= 80 ? "Needs attention" : "Unhealthy";
  const VerdictIcon = healthPercent === 100 ? CheckCircle : AlertTriangle;
  const verdictTone =
    healthPercent === 100
      ? "text-success-text"
      : healthPercent >= 80
        ? "text-warning-text"
        : "text-destructive-text";

  // A scan is one request with no progress to report, so the result is what
  // gets spoken — otherwise the whole outcome is a silent repaint.
  useEffect(() => {
    if (loadingTracks || tracks.length === 0) return;
    announce(`${healthyCount} of ${tracks.length} tracks healthy — ${verdict}.`);
  }, [loadingTracks, tracks.length, healthyCount, verdict, announce]);

  const filteredTracks = useMemo(() => {
    if (filter === "healthy") return healthyTracks;
    if (filter === "issues") return tracks.filter((t) => !isHealthy(t));
    return tracks;
  }, [tracks, healthyTracks, filter, isHealthy]);

  const removeDeadTracks = async () => {
    if (!selectedPlaylist) return;
    if (healthyTracks.length === tracks.length) return;
    if (healthyTracks.length === 0) {
      setNotice({
        type: "error",
        text: "Cannot remove all tracks from a playlist. Delete the playlist on SoundCloud instead.",
      });
      return;
    }
    setShowRemoveConfirm(true);
  };

  const executeRemoveDeadTracks = async () => {
    if (!selectedPlaylist) return;
    const removedCount = tracks.length - healthyTracks.length;
    setShowRemoveConfirm(false);
    if (healthyTracks.length === 0) return;
    setSaving(true);
    setNotice(null);
    try {
      const response = await apiFetch(`/api/playlists/${selectedPlaylist.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tracks: healthyTracks.map((t) => t.id),
          // Declare every removal: the server refuses to drop a track the
          // page did not name.
          remove: tracks.filter((t) => !isHealthy(t)).map((t) => t.id),
        }),
      });
      if (response.ok) {
        await invalidatePlaylistCaches(queryClient, selectedPlaylist.id);
        setTracks(healthyTracks);
        const done = `Removed ${removedCount} unavailable track${removedCount === 1 ? "" : "s"}.`;
        // The success alert is role=status, so it is already spoken.
        setNotice({ type: "success", text: done });
      } else {
        // A 409 means the server's view differs from this page's: refetch so
        // "reload and try again" has fresh data to work with.
        if (response.status === 409) {
          await invalidatePlaylistCaches(queryClient, selectedPlaylist.id);
        }
        // The error notice renders as `InlineAlert variant="error"`, which is
        // `role="alert"` — announcing as well would say it twice.
        setNotice({
          type: "error",
          text: await readApiErrorMessage(response, "Failed to update playlist."),
        });
      }
    } catch (error) {
      console.error("Error updating playlist:", error);
      setNotice({ type: "error", text: "An error occurred while updating the playlist." });
    } finally {
      setSaving(false);
    }
  };

  const formatDuration = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  // Only computed while the confirm dialog is open — no point building this
  // on every render while it's closed.
  const unhealthyReviewItems = useMemo(() => {
    if (!showRemoveConfirm) return [];
    return tracks
      .filter((track) => !isHealthy(track))
      .map((track) => ({
        id: track.id,
        label: track.title,
        meta: track.user?.username,
      }));
  }, [tracks, isHealthy, showRemoveConfirm]);

  return (
    <PageContainer maxWidth="wide">
        <PageHeader
          title="Playlist Health Check"
          description="Scan your playlists for blocked, preview-only, or unavailable tracks."
        />

        {notice && (
          <InlineAlert
            variant={notice.type}
            className="mb-6"
            onDismiss={() => setNotice(null)}
          >
            {notice.text}
          </InlineAlert>
        )}

        {!selectedPlaylist ? (
          /* Playlist Selection */
          <Card className="p-6">
            <h2 className="text-xl font-bold mb-4 text-foreground">
              Select a Playlist to Scan
            </h2>
            {loading ? (
              <div role="status" className="space-y-3">
                <span className="sr-only">Loading your playlists…</span>
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton
                    key={i}
                    aria-hidden="true"
                    className="h-16 rounded-lg bg-gray-100 dark:bg-secondary/50"
                  />
                ))}
              </div>
            ) : playlists.length === 0 ? (
              <EmptyState
                icon={<Music className="w-12 h-12" />}
                title="No playlists found"
              />
            ) : (
              <div className="grid md:grid-cols-2 gap-4">
                {playlists.map((playlist) => (
                  <button
                    key={playlist.id}
                    type="button"
                    onClick={() => selectPlaylist(playlist)}
                    className="flex items-center gap-4 p-4 rounded-xl bg-gray-50 dark:bg-secondary/20 border-2 border-transparent hover:border-primary transition-all text-left"
                  >
                    <img
                      src={playlist.artwork_url || "/brand/icon-192.png"}
                      /* The title is right there in the button's own text. */
                      alt=""
                      width={64}
                      height={64}
                      loading="lazy"
                      decoding="async"
                      className="w-16 h-16 rounded-lg object-cover"
                    />
                    <div>
                      <div className="font-semibold text-foreground">
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
        ) : (
          /* Health Check Results */
          <div>
            <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
              <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectedPlaylist(null);
                    setTracks([]);
                  }}
                >
                  <ArrowLeft aria-hidden="true" className="h-4 w-4" />
                  Back to playlists
                </Button>
                <h2 className="min-w-0 break-words text-2xl font-bold text-foreground">
                  {selectedPlaylist.title}
                </h2>
              </div>
              {issueCount > 0 && (
                <Button
                  onClick={removeDeadTracks}
                  disabled={saving || unreadableCount > 0}
                  variant="destructive"
                >
                  {saving ? (
                    <LoadingSpinner size="sm" className="w-4 h-4 text-white" />
                  ) : (
                    <Trash2 aria-hidden="true" className="w-4 h-4" />
                  )}
                  Remove {issueCount} Dead Track{issueCount > 1 ? "s" : ""}
                </Button>
              )}
            </div>

            {unreadableCount > 0 && !loadingTracks && (
              <InlineAlert variant="warning" className="mb-6">
                {detailReadCount < (detailTrackCount ?? 0) ? (
                  <>
                    SoundCloud returned {detailReadCount} of {detailTrackCount} tracks; the other{" "}
                    {unreadableCount} can&rsquo;t be read here, so remove them on SoundCloud.
                  </>
                ) : (
                  <>
                    SoundCloud returned {detailReadCount} tracks but counts {detailTrackCount}.
                    Reload the page, or check the playlist on SoundCloud.
                  </>
                )}{" "}
                Removing tracks from this page is turned off for this playlist until then.
              </InlineAlert>
            )}

            {/* Summary bar */}
            {!loadingTracks && tracks.length > 0 && (
              <Card className="mb-6 p-6">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <Stethoscope aria-hidden="true" className="w-5 h-5 text-muted-foreground" />
                    <span className="font-semibold text-foreground">
                      {healthyCount} of {tracks.length} tracks healthy
                    </span>
                  </div>
                  <span className={`inline-flex items-center gap-1.5 text-lg font-bold ${verdictTone}`}>
                    <VerdictIcon aria-hidden="true" className="h-5 w-5" />
                    {healthPercent}%
                    <span className="text-sm font-semibold">{verdict}</span>
                  </span>
                </div>
                {/* Decorative: the line above is the same information in words. */}
                <div
                  aria-hidden="true"
                  className="w-full bg-gray-200 dark:bg-secondary/50 rounded-full h-3"
                >
                  <div
                    className={`h-3 rounded-full transition-all ${healthPercent === 100 ? "bg-green-500" : healthPercent >= 80 ? "bg-yellow-500" : "bg-red-500"}`}
                    style={{ width: `${healthPercent}%` }}
                  />
                </div>
              </Card>
            )}

            {/* Filter pills */}
            {!loadingTracks && tracks.length > 0 && (
              <div role="group" aria-label="Filter tracks" className="mb-4 flex flex-wrap items-center gap-2">
                {([
                  { key: "all" as HealthFilter, label: "All", count: tracks.length, icon: null },
                  { key: "healthy" as HealthFilter, label: "Healthy", count: healthyCount, icon: CheckCircle },
                  { key: "issues" as HealthFilter, label: "Issues", count: issueCount, icon: AlertTriangle },
                ]).map(({ key, label, count, icon: Icon }) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={filter === key}
                    onClick={() => setFilter(key)}
                    className={`inline-flex min-h-9 items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                      filter === key
                        ? "bg-primary text-primary-foreground"
                        : "bg-gray-100 dark:bg-secondary/20 text-muted-foreground hover:bg-gray-200 dark:hover:bg-secondary/40"
                    }`}
                  >
                    {Icon ? <Icon aria-hidden="true" className="h-3.5 w-3.5" /> : null}
                    {label} ({count})
                  </button>
                ))}
              </div>
            )}

            <Card className="p-6">
              {loadingTracks ? (
                <div role="status" className="space-y-3">
                  <span className="sr-only">Scanning this playlist…</span>
                  {Array.from({ length: 10 }).map((_, i) => (
                    <Skeleton
                      key={i}
                      aria-hidden="true"
                      className="h-16 rounded-lg bg-gray-100 dark:bg-secondary/50"
                    />
                  ))}
                </div>
              ) : tracks.length === 0 ? (
                <EmptyState
                  icon={<Music className="w-12 h-12" />}
                  title="This playlist has no tracks"
                />
              ) : filteredTracks.length === 0 ? (
                <EmptyState
                  icon={<CheckCircle className="w-12 h-12" />}
                  title={filter === "issues" ? "No issues found!" : "No tracks match this filter"}
                  description={filter === "issues" ? "All tracks in this playlist are playable." : undefined}
                />
              ) : (
                <div className="space-y-2">
                  {filteredTracks.map((track, index) => {
                    const status = getTrackStatus(track);
                    return (
                      /* Below `sm` the badge moves under the track instead of
                         competing with the title for the same line. */
                      <div
                        key={track.id}
                        className={`flex flex-col gap-2 p-3 rounded-xl sm:flex-row sm:items-center sm:gap-4 ${status.icon === "bad" ? "bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30" : status.icon === "warn" ? "bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-900/30" : "bg-gray-50 dark:bg-secondary/20 border border-transparent dark:border-border"}`}
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
                          <span className="w-8 shrink-0 text-center text-sm text-muted-foreground-subtle">
                            {index + 1}
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
                            <div className="font-semibold text-foreground truncate">
                              {track.title}
                            </div>
                            <div className="text-sm text-muted-foreground truncate">
                              {track.user?.username} • {formatDuration(track.duration)}
                            </div>
                          </div>
                        </div>
                        <span className={`inline-flex w-fit shrink-0 items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${status.bg} ${status.color}`}>
                          {status.icon === "ok" && <CheckCircle aria-hidden="true" className="w-3.5 h-3.5" />}
                          {status.icon === "warn" && <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5" />}
                          {status.icon === "bad" && <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5" />}
                          {status.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
        )}
      <ConfirmDialog
        open={showRemoveConfirm}
        title="Remove unavailable tracks?"
        description={`Remove ${issueCount} unavailable track${issueCount === 1 ? "" : "s"} from "${selectedPlaylist?.title}"?`}
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={executeRemoveDeadTracks}
        onCancel={() => setShowRemoveConfirm(false)}
      >
        <BulkReviewDetails
          action="removing unavailable tracks"
          warning="This updates the playlist on SoundCloud and removes tracks currently marked blocked, preview-only, or not streamable."
          exportFilename="playlist-health-removals.csv"
          items={unhealthyReviewItems}
        />
      </ConfirmDialog>
    </PageContainer>
  );
}
