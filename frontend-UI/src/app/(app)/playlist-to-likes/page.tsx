"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Heart, Music } from "lucide-react";
import { apiFetch } from "@/lib/api";
import {
  ActionBar,
  Button,
  EmptyState,
  ListSearch,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  Panel,
  ProgressBar,
  ResultPanel,
  SelectableList,
  Skeleton,
  ToolLayout,
  TrackRow,
  useAnnounce,
  type ResultStatus,
} from "@/components/ui";
import { PlaylistPicker } from "@/components/playlists/PlaylistPicker";
import {
  usePlaylistsQuery,
  usePlaylistDetailQuery,
  invalidatePlaylistCaches,
  queryKeys,
} from "@/lib/queries";
import { asArray } from "@/lib/api-shape";
import { useListSearch } from "@/lib/list-search";
import { useListSelection } from "@/lib/useListSelection";

// SoundCloud bulk endpoints cap at 100 ids per request; chunk larger playlists.
const LIKE_BATCH_SIZE = 100;

interface PlaylistTrack {
  id: number;
  title?: string;
  user?: { username?: string };
  artwork_url?: string;
  duration?: number;
}

interface PlaylistOption {
  id: number;
  title: string;
  track_count: number;
  artwork_url?: string;
  coverUrl?: string;
}

/** The result slot's content, fixed when the run ends. */
interface Outcome {
  id: number;
  status: ResultStatus;
  title: string;
  description: string;
  /** What is spoken, when it differs from the description. */
  announcement?: string;
}

const trackText = (track: PlaylistTrack) => `${track.title ?? ""} ${track.user?.username ?? ""}`;
const trackId = (track: PlaylistTrack) => track.id;

const formatDuration = (ms?: number) => {
  if (!ms) return "";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export default function PlaylistToLikesPage() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistOption | null>(null);
  const [query, setQuery] = useState("");
  const [liking, setLiking] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const playlistsQuery = usePlaylistsQuery();
  const playlists = useMemo(
    () => asArray<PlaylistOption>(playlistsQuery.data?.collection),
    [playlistsQuery.data?.collection],
  );

  const detailQuery = usePlaylistDetailQuery(selectedPlaylist?.id ?? 0);
  const tracks = useMemo(
    () => asArray<PlaylistTrack>(detailQuery.data?.tracks),
    [detailQuery.data?.tracks],
  );

  // Search runs over every track the playlist holds, not the rendered rows.
  const { results: shownTracks, isFiltered } = useListSearch(tracks, query, trackText);
  const {
    selected: selectedTracks,
    setSelected: setSelectedTracks,
    toggle,
    toggleAllShown,
    toggleAllLabel,
  } = useListSelection(shownTracks, trackId, { isQueryActive: isFiltered });

  // Default to liking every track in the playlist; users can deselect.
  useEffect(() => {
    if (tracks.length > 0) {
      setSelectedTracks(new Set(tracks.map((t) => t.id)));
    }
  }, [tracks, setSelectedTracks]);

  // A playlist's tracks arriving is only a visual change; say how many.
  useEffect(() => {
    if (!selectedPlaylist || !detailQuery.isSuccess) return;
    announce(`${tracks.length} track${tracks.length === 1 ? "" : "s"} loaded`);
  }, [selectedPlaylist, detailQuery.isSuccess, tracks.length, announce]);

  // Choosing a playlist swaps the picker for its tracks, and "Change
  // playlist" swaps back. Either way the focused control is unmounted, so
  // focus moves to the panel that replaced it instead of falling to <body>.
  const focusPanel = (id: string) =>
    requestAnimationFrame(() => document.getElementById(id)?.focus({ preventScroll: false }));

  const choosePlaylist = (p: PlaylistOption) => {
    setSelectedPlaylist(p);
    setSelectedTracks(new Set());
    setQuery("");
    setOutcome(null);
    focusPanel("playlist-to-likes-tracks");
  };

  const handleLike = async () => {
    const ids = Array.from(selectedTracks);
    if (ids.length === 0) return;
    setLiking(true);
    setOutcome(null);
    setProgress({ done: 0, total: ids.length });

    let liked = 0;
    let failed = 0;
    try {
      for (let i = 0; i < ids.length; i += LIKE_BATCH_SIZE) {
        const batch = ids.slice(i, i + LIKE_BATCH_SIZE);
        const response = await apiFetch("/api/likes/tracks/bulk-like", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trackIds: batch }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = typeof data?.error === "string" ? data.error : "Failed to like tracks";
          throw new Error(message);
        }
        const results = Array.isArray(data.results) ? data.results : [];
        liked += results.filter((r: { status: string }) => r.status === "ok").length;
        failed += results.filter((r: { status: string }) => r.status === "error").length;
        setProgress({ done: Math.min(i + batch.length, ids.length), total: ids.length });

        // SoundCloud's like limit was hit and the server stopped this batch.
        // Every later batch would fail the same way, so stop here too.
        if (data.rateLimited === true) {
          if (liked > 0) {
            await queryClient.invalidateQueries({ queryKey: queryKeys.likes() });
            await invalidatePlaylistCaches(queryClient, selectedPlaylist?.id ?? null);
          }
          const text =
            `SoundCloud is limiting likes on your account right now. ` +
            `Liked ${liked} of ${ids.length} tracks before it stopped — try the rest again later.`;
          setOutcome({
            id: Date.now(),
            status: liked > 0 ? "partial" : "error",
            title: "Likes stopped early",
            description: text,
          });
          return;
        }
      }

      // Liked tracks changed the user's likes; refresh caches that show them.
      await queryClient.invalidateQueries({ queryKey: queryKeys.likes() });
      await invalidatePlaylistCaches(queryClient, selectedPlaylist?.id ?? null);

      // Liked tracks are done: keeping them ticked under "Like N Tracks"
      // would invite liking them again. (The old success screen reset it.)
      if (liked > 0) setSelectedTracks(new Set());
      setOutcome({
        id: Date.now(),
        status: liked === 0 ? (failed > 0 ? "error" : "empty") : failed > 0 ? "partial" : "success",
        announcement: `Liked ${liked} of ${ids.length} tracks${failed > 0 ? `, ${failed} failed` : ""}`,
        title: liked === 0 ? (failed > 0 ? "No tracks were liked" : "Nothing to like") : "Tracks Liked!",
        description:
          `Liked ${liked} track${liked !== 1 ? "s" : ""} from "${selectedPlaylist?.title}".` +
          (failed > 0 ? ` ${failed} could not be liked (they may be unavailable).` : ""),
      });
    } catch (error) {
      setOutcome({
        id: Date.now(),
        status: "error",
        title: "Couldn't like the tracks",
        description:
          error instanceof Error ? error.message : "An error occurred while liking tracks.",
      });
    } finally {
      setLiking(false);
      setProgress(null);
    }
  };

  const renderTrack = useCallback(
    (track: PlaylistTrack, index: number) => (
      <TrackRow
        as="li"
        key={track.id}
        track={{ ...track, title: track.title ?? "Untitled", subtitle: track.user?.username }}
        isSelected={selectedTracks.has(track.id)}
        onToggle={(e) => toggle(track, index, e)}
        rightSlot={
          <span className="text-xs text-muted-foreground">{formatDuration(track.duration)}</span>
        }
      />
    ),
    [selectedTracks, toggle],
  );

  return (
    <PageContainer kind="workbench">
      <PageHeader
        title="Playlist → Likes"
        description="Like every track in a playlist at once. Pick a playlist, then like all its tracks (uncheck any you want to skip)."
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

        {!selectedPlaylist ? (
          <Panel title="Choose a Playlist" id="playlist-to-likes-picker" tabIndex={-1} className="focus:outline-none">
            <PlaylistPicker
              playlists={playlists}
              mode="single"
              selectedIds={[]}
              onChange={(next) => next[0] && choosePlaylist(next[0])}
              loading={playlistsQuery.isLoading}
              loadError={playlistsQuery.isError}
              onRetry={() => playlistsQuery.refetch()}
            />
          </Panel>
        ) : (
          <ToolLayout
            main={
              <Panel
                id="playlist-to-likes-tracks"
                tabIndex={-1}
                className="focus:outline-none"
                title={
                  <>
                    {selectedPlaylist.title}{" "}
                    <span className="text-base font-normal text-muted-foreground">
                      ({tracks.length})
                    </span>
                  </>
                }
                actions={
                  tracks.length > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={toggleAllShown}
                      className="text-primary-text"
                      nowrap
                    >
                      {toggleAllLabel}
                    </Button>
                  ) : undefined
                }
              >
                {detailQuery.isLoading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 10 }).map((_, i) => (
                      <Skeleton key={i} className="h-16 rounded-xl" />
                    ))}
                  </div>
                ) : tracks.length === 0 ? (
                  <EmptyState icon={<Music className="w-12 h-12" />} title="This playlist has no tracks" />
                ) : (
                  <div className="space-y-3">
                    <ListSearch
                      label="Search this playlist's tracks"
                      value={query}
                      onChange={setQuery}
                      shown={shownTracks.length}
                      total={tracks.length}
                      noun={tracks.length === 1 ? "track" : "tracks"}
                      placeholder="Search by title or artist…"
                    />
                    {shownTracks.length === 0 ? (
                      <EmptyState
                        as="p"
                        className="min-h-[160px] py-8"
                        title="No tracks match your search"
                        description="Try fewer or different words."
                      />
                    ) : (
                      <SelectableList className="max-h-[60dvh] overflow-y-auto overscroll-contain pr-1">
                        {shownTracks.map(renderTrack)}
                      </SelectableList>
                    )}
                  </div>
                )}
              </Panel>
            }
            aside={
              <Panel title="Like Tracks">
                <div className="space-y-4">
                  <div className="rounded-lg bg-secondary/20 p-4">
                    <div className="text-sm text-muted-foreground">Selected Tracks</div>
                    <div className="text-2xl font-bold text-foreground">{selectedTracks.size}</div>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSelectedPlaylist(null);
                      setSelectedTracks(new Set());
                      setQuery("");
                      focusPanel("playlist-to-likes-picker");
                    }}
                    className="text-primary-text"
                  >
                    Change playlist
                  </Button>

                  {/* Progress lives outside the button: a disabled control is
                      skipped by some assistive technology, so the only report of
                      a long job would never be read out. */}
                  {liking && progress ? (
                    <ProgressBar label="Liking tracks" value={progress.done} max={progress.total} />
                  ) : null}

                  <p className="text-xs text-muted-foreground">
                    Tracks are liked one at a time to stay within SoundCloud’s limits, so large playlists take a little while.
                  </p>
                </div>

                <ActionBar layout="stretch">
                  <Button onClick={handleLike} disabled={selectedTracks.size === 0 || liking}>
                    {liking ? (
                      <>
                        <LoadingSpinner size="sm" />
                        Liking…
                      </>
                    ) : (
                      <>
                        <Heart aria-hidden="true" className="w-4 h-4" />
                        Like {selectedTracks.size} Track{selectedTracks.size !== 1 ? "s" : ""}
                      </>
                    )}
                  </Button>
                </ActionBar>
              </Panel>
            }
          />
        )}
      </div>
    </PageContainer>
  );
}
