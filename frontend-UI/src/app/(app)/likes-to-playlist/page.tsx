"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Music } from "lucide-react";
import { apiFetch, errorMessageFromBody } from "@/lib/api";
import {
  ActionBar,
  Button,
  EmptyState,
  Field,
  InlineAlert,
  Input,
  ListSearch,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  Panel,
  ResultPanel,
  SegmentedControl,
  SelectableList,
  Skeleton,
  ToolLayout,
  TrackRow,
  useAnnounce,
  type ResultStatus,
} from "@/components/ui";
import { PlaylistChooser } from "@/components/playlists/PlaylistChooser";
import { invalidatePlaylistCaches, useLikesQuery, usePlaylistsQuery } from "@/lib/queries";
import { asArray } from "@/lib/api-shape";
import { useListSearch } from "@/lib/list-search";
import { useListSelection } from "@/lib/useListSelection";

interface Track {
  id: number;
  title: string;
  user: { username: string };
  artwork_url: string;
  duration: number;
}

interface Playlist {
  id: number;
  title: string;
  track_count: number;
  artwork_url: string;
  coverUrl?: string;
}

interface CreatedPlaylist {
  id: number;
  title: string;
  permalink_url: string;
  trackCount: number;
}

interface FromLikesResponse {
  playlist?: { id: number; title: string; permalink_url: string };
  playlists?: CreatedPlaylist[];
  overflowPlaylists?: CreatedPlaylist[];
  totalTracks?: number;
  addedCount?: number;
  numPlaylistsCreated?: number;
}

type AddMode = "new" | "existing";

/** The result slot's content, fixed when the run ends. */
interface Outcome {
  id: number;
  status: ResultStatus;
  title: string;
  description: string;
  announcement: string;
  /** More than one playlist: each is linked in the panel body. */
  playlists: CreatedPlaylist[];
  /** One new playlist: "Open in SoundCloud". */
  openUrl?: string;
}

const ADD_MODES = [
  { value: "new", label: "New playlist" },
  { value: "existing", label: "Existing playlist" },
] as const;

const trackText = (track: Track) => `${track.title ?? ""} ${track.user?.username ?? ""}`;
const trackId = (track: Track) => track.id;

function buildOutcome(
  result: FromLikesResponse,
  isExisting: boolean,
  selectedCount: number,
  playlistName: string,
  targetTitle: string | undefined,
): Outcome {
  const multiple = Boolean(result.playlists && result.playlists.length > 1);
  let description: string;
  if (isExisting) {
    description = `Added ${result.addedCount ?? selectedCount} new track${(result.addedCount ?? 1) !== 1 ? "s" : ""} to "${targetTitle}".`;
    if (result.overflowPlaylists && result.overflowPlaylists.length > 0) {
      description += ` ${result.overflowPlaylists.length} overflow playlist(s) created for tracks beyond the 500-track limit.`;
    }
  } else if (multiple) {
    description = `${result.totalTracks ?? selectedCount} tracks across ${result.numPlaylistsCreated} playlists.`;
  } else {
    description = `"${playlistName}" has been created with ${result.totalTracks ?? selectedCount} tracks.`;
  }

  const nothingAdded =
    isExisting && result.addedCount === 0 && !(result.overflowPlaylists && result.overflowPlaylists.length > 0);

  return {
    id: Date.now(),
    status: nothingAdded ? "empty" : "success",
    title: isExisting ? "Tracks Added!" : multiple ? "Playlists Created!" : "Playlist Created!",
    description,
    announcement: isExisting ? "Tracks added to playlist" : "Playlist created",
    playlists: multiple && result.playlists ? result.playlists : [],
    openUrl: !multiple && !isExisting ? result.playlist?.permalink_url : undefined,
  };
}

const formatDuration = (ms: number) => {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export default function LikesToPlaylistPage() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [prefillTrackId, setPrefillTrackId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [playlistName, setPlaylistName] = useState("");
  const [addMode, setAddMode] = useState<AddMode>("new");
  const [targetPlaylist, setTargetPlaylist] = useState<Playlist | null>(null);
  const [creating, setCreating] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [runError, setRunError] = useState<{ id: number; title: string; text: string } | null>(null);

  const likesQuery = useLikesQuery();
  const playlistsQuery = usePlaylistsQuery({ enabled: addMode === "existing" });
  const likes = useMemo(
    () => asArray<Track>(likesQuery.data?.collection),
    [likesQuery.data?.collection],
  );
  const userPlaylists = useMemo(
    () => asArray<Playlist>(playlistsQuery.data?.collection),
    [playlistsQuery.data?.collection],
  );
  const loading = likesQuery.isLoading;

  // Search runs over every like the server returned, not the rendered rows.
  const { results: shownLikes, isFiltered } = useListSearch(likes, query, trackText);
  const {
    selected: selectedTracks,
    setSelected: setSelectedTracks,
    toggle,
    toggleAllShown,
    toggleAllLabel,
  } = useListSelection(shownLikes, trackId, { isQueryActive: isFiltered });

  // The list arriving is a purely visual event; say how much of it there is.
  useEffect(() => {
    if (!likesQuery.isSuccess) return;
    announce(`${likes.length} liked track${likes.length === 1 ? "" : "s"} loaded`);
  }, [likesQuery.isSuccess, likes.length, announce]);

  useEffect(() => {
    const idParam = new URLSearchParams(window.location.search).get("id");
    const id = idParam ? Number(idParam) : NaN;
    if (Number.isInteger(id)) setPrefillTrackId(id);
  }, []);

  useEffect(() => {
    if (prefillTrackId != null && likes.some((track) => track.id === prefillTrackId)) {
      setSelectedTracks(new Set([prefillTrackId]));
    }
  }, [likes, prefillTrackId, setSelectedTracks]);

  const canCreate =
    selectedTracks.size > 0 &&
    (addMode === "existing" ? targetPlaylist !== null : playlistName.trim().length > 0);

  const handleCreate = async () => {
    if (!canCreate) return;
    const failureTitle =
      addMode === "existing" ? "Couldn't add the tracks" : "Couldn't create the playlist";
    setCreating(true);
    setOutcome(null);
    setRunError(null);
    try {
      const body: Record<string, unknown> = {
        trackIds: Array.from(selectedTracks),
      };
      if (addMode === "existing" && targetPlaylist) {
        body.targetPlaylistId = targetPlaylist.id;
      } else {
        body.title = playlistName.trim();
      }

      const response = await apiFetch("/api/playlists/from-likes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        await invalidatePlaylistCaches(queryClient, targetPlaylist?.id ?? null);
        setOutcome(
          buildOutcome(data, addMode === "existing", selectedTracks.size, playlistName, targetPlaylist?.title),
        );
        // Ready for the next run, as "Create Another" used to do.
        setSelectedTracks(new Set());
        setPlaylistName("");
        setTargetPlaylist(null);
      } else {
        // Show the reason first: it must not wait on a cold list refetch.
        setRunError({ id: Date.now(), title: failureTitle, text: errorMessageFromBody(data, "Failed to create playlist") });
        if (response.status === 409 && data?.code === "PLAYLIST_NOT_FOUND") {
          // The chosen target is gone from SoundCloud and nothing was written:
          // drop it from the target slot and refetch the list.
          const missingId = Number(data.playlistId);
          setTargetPlaylist((prev) => (prev && Number(prev.id) === missingId ? null : prev));
          void invalidatePlaylistCaches(queryClient);
        }
      }
    } catch (error) {
      console.error("Error creating playlist:", error);
      setRunError({ id: Date.now(), title: failureTitle, text: "An error occurred. Please try again." });
    } finally {
      setCreating(false);
    }
  };

  const renderTrack = useCallback(
    (track: Track, index: number) => (
      <TrackRow
        as="li"
        key={track.id}
        track={{ ...track, subtitle: track.user?.username }}
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
        title="Likes → Playlist"
        description="Convert your liked tracks into an organized playlist."
      />

      <div className="space-y-6">
        {runError ? (
          <ResultPanel
            key={runError.id}
            status="error"
            title={runError.title}
            description={runError.text}
            announcement={runError.text}
            onDismiss={() => setRunError(null)}
          />
        ) : null}

        {outcome ? (
          <ResultPanel
            key={outcome.id}
            status={outcome.status}
            title={outcome.title}
            description={outcome.description}
            announcement={outcome.announcement}
            onDismiss={() => setOutcome(null)}
            actions={
              outcome.openUrl ? (
                <a
                  href={outcome.openUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center rounded-lg bg-primary/10 px-4 font-semibold text-primary-text transition hover:bg-primary/15"
                >
                  Open in SoundCloud
                </a>
              ) : undefined
            }
          >
            {outcome.playlists.length > 0 ? (
              // eslint-disable-next-line jsx-a11y/no-redundant-roles -- Tailwind preflight strips list semantics in WebKit
              <ul role="list" className="space-y-2">
                {outcome.playlists.map((p) => (
                  <li key={p.id}>
                    <a
                      href={p.permalink_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-lg border border-border px-4 py-3 transition hover:border-primary hover:bg-primary/5"
                    >
                      <span className="font-semibold text-foreground">{p.title}</span>
                      <span className="ml-2 text-sm text-muted-foreground">({p.trackCount} tracks)</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </ResultPanel>
        ) : null}

        <ToolLayout
          main={
            <Panel
              title={
                <>
                  Your Liked Tracks{" "}
                  <span className="text-base font-normal text-muted-foreground">({likes.length})</span>
                </>
              }
              actions={
                likes.length > 0 ? (
                  <Button variant="ghost" size="sm" onClick={toggleAllShown} className="text-primary-text" nowrap>
                    {toggleAllLabel}
                  </Button>
                ) : undefined
              }
            >
              {likesQuery.isError ? (
                <InlineAlert variant="error">
                  Couldn’t load your liked tracks. Try refreshing the page.
                </InlineAlert>
              ) : loading ? (
                <div className="space-y-2">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 rounded-xl" />
                  ))}
                </div>
              ) : likes.length === 0 ? (
                <EmptyState icon={<Music className="h-6 w-6" />} title="No liked tracks found" />
              ) : (
                <div className="space-y-3">
                  <ListSearch
                    label="Search your liked tracks"
                    value={query}
                    onChange={setQuery}
                    shown={shownLikes.length}
                    total={likes.length}
                    noun={likes.length === 1 ? "track" : "tracks"}
                    placeholder="Search by title or artist…"
                  />
                  {shownLikes.length === 0 ? (
                    <EmptyState
                      as="p"
                      className="min-h-[160px] py-8"
                      title="No liked tracks match your search"
                      description="Try fewer or different words."
                    />
                  ) : (
                    <SelectableList className="max-h-[60dvh] overflow-y-auto overscroll-contain pr-1">
                      {shownLikes.map(renderTrack)}
                    </SelectableList>
                  )}
                </div>
              )}
            </Panel>
          }
          aside={
            <Panel title={addMode === "existing" ? "Add to Playlist" : "Create Playlist"}>
              <div className="space-y-4">
                <div className="rounded-lg bg-secondary/20 p-4">
                  <div className="text-sm text-muted-foreground">Selected Tracks</div>
                  <div className="text-2xl font-bold text-foreground">{selectedTracks.size}</div>
                </div>

                {selectedTracks.size > 500 && addMode === "new" && (
                  <p className="text-sm text-primary-text">
                    Selection exceeds 500 tracks; multiple playlists will be created.
                  </p>
                )}

                <SegmentedControl label="Add to" value={addMode} options={ADD_MODES} onChange={setAddMode} />

                {addMode === "new" && (
                  <Field label="Playlist name">
                    {(field) => (
                      <Input
                        {...field}
                        type="text"
                        value={playlistName}
                        onChange={(e) => setPlaylistName(e.target.value)}
                        placeholder="Enter playlist name…"
                        className="h-11"
                      />
                    )}
                  </Field>
                )}

                {addMode === "existing" && (
                  <PlaylistChooser
                    label="Target playlist"
                    dialogTitle="Your playlists"
                    playlists={userPlaylists}
                    value={targetPlaylist}
                    onChange={setTargetPlaylist}
                    loading={playlistsQuery.isLoading}
                    loadError={playlistsQuery.isError}
                    onRetry={() => playlistsQuery.refetch()}
                    unavailableText="No playlists found"
                  />
                )}
              </div>

              <ActionBar layout="stretch">
                <Button onClick={handleCreate} disabled={!canCreate || creating}>
                  {creating ? (
                    <>
                      <LoadingSpinner size="sm" className="text-white" />
                      {addMode === "existing" ? "Adding..." : "Creating..."}
                    </>
                  ) : (
                    <>
                      <Plus aria-hidden="true" className="h-5 w-5" />
                      {addMode === "existing" ? "Add to Playlist" : "Create Playlist"}
                    </>
                  )}
                </Button>
              </ActionBar>
            </Panel>
          }
        />
      </div>
    </PageContainer>
  );
}
