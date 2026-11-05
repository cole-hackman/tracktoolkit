"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Stethoscope, Music, AlertTriangle, CheckCircle, Trash2 } from "lucide-react";
import {
  Button,
  BulkReviewDetails,
  ConfirmDialog,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  Panel,
  ResultPanel,
  Skeleton,
  useAnnounce,
} from "@/components/ui";
import { PlaylistPicker } from "@/components/playlists/PlaylistPicker";
import { apiFetch, isApiError, readApiErrorMessage } from "@/lib/api";
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

/** The result slot's content after a save (or a refused one), fixed when it ends. */
interface Outcome {
  id: number;
  status: "success" | "error";
  title: string;
  description: string;
  announcement?: string;
}

export default function PlaylistHealthCheckPage() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<HealthFilter>("all");
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Set by a successful save to the scan announcement it makes redundant.
  const postSaveScanMessage = useRef<string | null>(null);

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

  // Loading failures stay where the thing they load would be: the playlists
  // error with the picker, the tracks error in the report.
  // The server's own wording for a vanished playlist (404) or a SoundCloud
  // outage (502) says more than the generic line does.
  const detailError = playlistDetailQuery.error;
  const detailServerText =
    isApiError(detailError) &&
    (detailError.status === 404 || detailError.status === 502) &&
    // apiFetchJson's own fallback (a non-JSON body, e.g. a proxy 502) is not
    // the server's wording.
    detailError.message !== `Request failed with status ${detailError.status}`
      ? detailError.message
      : null;
  const detailErrorText = playlistDetailQuery.isError
    ? (detailServerText ?? "Couldn’t load tracks for this playlist.")
    : null;

  useEffect(() => {
    if (playlistDetailQuery.isError) return;
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
    postSaveScanMessage.current = null;
    setOutcome(null);
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
    const message = `${healthyCount} of ${tracks.length} tracks healthy — ${verdict}.`;
    // Right after a save the combined "Removed N… M of M healthy" message has
    // already been spoken; a second one would overwrite it.
    // One-shot: read and clear first, so it can never outlive this render and
    // swallow a later, legitimate announcement.
    const expected = postSaveScanMessage.current;
    postSaveScanMessage.current = null;
    if (message === expected) return;
    announce(message);
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
      setOutcome({
        id: Date.now(),
        status: "error",
        title: "Nothing was removed",
        description: "Cannot remove all tracks from a playlist. Delete the playlist on SoundCloud instead.",
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
    setOutcome(null);
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
        // Local work first, before any await: the refetch below re-crawls the
        // playlist and must not delay the result.
        setTracks(healthyTracks);
        const done = `Removed ${removedCount} unavailable track${removedCount === 1 ? "" : "s"}.`;
        const remaining = healthyTracks.length;
        // One combined announcement, spoken by the result panel. The scan
        // effect's own "M of M healthy" would overwrite it — so that message
        // is suppressed for this save.
        postSaveScanMessage.current = `${remaining} of ${remaining} tracks healthy — Healthy.`;
        setOutcome({
          id: Date.now(),
          status: "success",
          title: "Unavailable tracks removed",
          description: done,
          announcement: `${done} ${postSaveScanMessage.current}`,
        });
        await invalidatePlaylistCaches(queryClient, selectedPlaylist.id);
      } else {
        setOutcome({
          id: Date.now(),
          status: "error",
          title: "Couldn’t update the playlist",
          description: await readApiErrorMessage(response, "Failed to update playlist."),
        });
        // A 409 means the server's view differs from this page's: refetch so
        // "reload and try again" has fresh data. After the message, so the
        // re-crawl does not delay it.
        if (response.status === 409) {
          await invalidatePlaylistCaches(queryClient, selectedPlaylist.id);
        }
      }
    } catch (error) {
      console.error("Error updating playlist:", error);
      setOutcome({
        id: Date.now(),
        status: "error",
        title: "Couldn’t update the playlist",
        description: "An error occurred while updating the playlist.",
      });
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
    <PageContainer kind="list">
      <PageHeader
        title="Playlist Health Check"
        description="Scan your playlists for blocked, preview-only, or unavailable tracks."
      />

      <div className="space-y-6">
        {outcome ? (
          <ResultPanel
            key={outcome.id}
            status={outcome.status}
            title={outcome.title}
            description={outcome.description}
            announcement={outcome.announcement}
            onDismiss={() => setOutcome(null)}
          />
        ) : null}

        {/* The picker stays on screen: switching playlists is one click. */}
        <Panel title="Select a Playlist to Scan">
          {playlistsQuery.isError ? (
            <InlineAlert variant="error" className="mb-4">
              Couldn’t load your playlists. Try refreshing the page.
            </InlineAlert>
          ) : null}
          <PlaylistPicker
            playlists={playlists}
            mode="single"
            selectedIds={selectedPlaylist ? [Number(selectedPlaylist.id)] : []}
            onChange={(next) => {
              const chosen = next[0];
              if (chosen) selectPlaylist(chosen);
            }}
            loading={loading}
            loadError={playlistsQuery.isError}
            onRetry={() => playlistsQuery.refetch()}
            listClassName="max-h-[40dvh]"
          />
        </Panel>

        {selectedPlaylist ? (
          detailErrorText ? (
            <InlineAlert variant="error">{detailErrorText}</InlineAlert>
          ) : (
            <>
              <Panel
                title={<span className="break-words">{selectedPlaylist.title}</span>}
                actions={
                  issueCount > 0 ? (
                    <Button
                      onClick={() => {
                        // aria-disabled, not `disabled`: the button stays in the
                        // tab order so its explanation can be reached and read.
                        if (unreadableCount > 0) return;
                        removeDeadTracks();
                      }}
                      disabled={saving}
                      aria-disabled={unreadableCount > 0 ? true : undefined}
                      aria-describedby={unreadableCount > 0 ? "health-shortfall" : undefined}
                      variant="destructive"
                    >
                      {saving ? (
                        <LoadingSpinner size="sm" className="w-4 h-4 text-white" />
                      ) : (
                        <Trash2 aria-hidden="true" className="w-4 h-4" />
                      )}
                      Remove {issueCount} Dead Track{issueCount > 1 ? "s" : ""}
                    </Button>
                  ) : undefined
                }
              >
                <div className="space-y-4">
                  {unreadableCount > 0 && !loadingTracks && (
                    <InlineAlert id="health-shortfall" variant="warning">
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
                    <div>
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
                    </div>
                  )}

                  {/* Filter pills */}
                  {!loadingTracks && tracks.length > 0 && (
                    <div role="group" aria-label="Filter tracks" className="flex flex-wrap items-center gap-2">
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
                </div>
              </Panel>

              <Panel>
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
              </Panel>
            </>
          )
        ) : null}
      </div>
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
