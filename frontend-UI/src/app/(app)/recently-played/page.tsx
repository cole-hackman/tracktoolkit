"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { History } from "lucide-react";
import {
  Button,
  EmptyState,
  InlineAlert,
  ListSearch,
  PageContainer,
  PageHeader,
  Panel,
  ResultPanel,
  SelectableList,
  Skeleton,
  ToolLayout,
  TrackRow,
  useAnnounce,
  type ResultStatus,
} from "@/components/ui";
import { SaveToPlaylistPanel, type SaveMode } from "@/components/workbench/SaveToPlaylistPanel";
import { apiFetch, readApiErrorMessage } from "@/lib/api";
import {
  invalidatePlaylistCaches,
  useRecentlyPlayedQuery,
  usePlaylistDetailQuery,
  usePlaylistsQuery,
} from "@/lib/queries";
import { asArray } from "@/lib/api-shape";
import { useListSearch } from "@/lib/list-search";
import { useListSelection } from "@/lib/useListSelection";

interface Track {
  id: number;
  title: string;
  user: { username: string };
  artwork_url: string;
  duration: number;
  permalink_url: string;
}

interface Playlist {
  id: number;
  title: string;
  track_count: number;
  artwork_url?: string;
  coverUrl?: string;
}

/** The result slot's content: the sentence the old notice carried, plus a title. */
interface Outcome {
  id: number;
  status: ResultStatus;
  title: string;
  text: string;
}

const trackText = (track: Track) => `${track.title ?? ""} ${track.user?.username ?? ""}`;
const trackId = (track: Track) => track.id;

const formatDuration = (ms: number) => {
  if (!ms) return "0:00";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export default function RecentlyPlayedPage() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SaveMode>("new");
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [targetPlaylist, setTargetPlaylist] = useState<Playlist | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const selectedPlaylistId = targetPlaylist?.id ?? null;

  const recentlyPlayedQuery = useRecentlyPlayedQuery();
  // Only needed for the "existing playlist" chooser — don't block the
  // recently-played list on a fetch it doesn't need yet.
  const playlistsQuery = usePlaylistsQuery({ enabled: mode === "existing" });
  const selectedPlaylistQuery = usePlaylistDetailQuery(selectedPlaylistId ?? 0, {
    enabled: mode === "existing" && selectedPlaylistId != null,
    // Include blocked tracks so the list sent back is the whole playlist.
    allAccess: true,
  });

  const tracks = useMemo(
    () => asArray<Track>(recentlyPlayedQuery.data?.collection),
    [recentlyPlayedQuery.data?.collection],
  );
  const playlists = useMemo(
    () => asArray<Playlist>(playlistsQuery.data?.collection),
    [playlistsQuery.data?.collection],
  );
  const loading = recentlyPlayedQuery.isLoading;

  const { results: shownTracks, isFiltered } = useListSearch(tracks, query, trackText);
  const {
    selected,
    setSelected,
    toggle,
    toggleAllShown,
    toggleAllLabel,
  } = useListSelection(shownTracks, trackId, { isQueryActive: isFiltered });

  useEffect(() => {
    if (!recentlyPlayedQuery.isSuccess) return;
    announce(`${tracks.length} recently played track${tracks.length === 1 ? "" : "s"} loaded`);
  }, [recentlyPlayedQuery.isSuccess, tracks.length, announce]);

  const fail = (title: string, text: string) =>
    setOutcome({ id: Date.now(), status: "error", title, text });

  const handleSave = async () => {
    if (selected.size === 0) return;
    setSaving(true);
    setOutcome(null);

    try {
      const trackIds = Array.from(selected);

      if (mode === "new") {
        const title = newPlaylistName.trim() || `Recently Played ${new Date().toLocaleDateString()}`;
        const response = await apiFetch("/api/playlists/from-likes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trackIds, title }),
        });
        if (response.ok) {
          await invalidatePlaylistCaches(queryClient);
          setOutcome({
            id: Date.now(),
            status: "success",
            title: "Playlist saved",
            text: "Playlist saved successfully.",
          });
          setSelected(new Set());
        } else {
          fail("Couldn't create the playlist", await readApiErrorMessage(response, "Failed to create playlist."));
        }
      } else if (selectedPlaylistId) {
        if (selectedPlaylistQuery.data) {
          const existingIds = (asArray<Track>(selectedPlaylistQuery.data.tracks)).map((t) => t.id);
          const mergedIds = [...existingIds, ...trackIds];
          const response = await apiFetch(`/api/playlists/${selectedPlaylistId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tracks: mergedIds }),
          });
          if (response.ok) {
            setOutcome({
              id: Date.now(),
              status: "success",
              title: "Playlist saved",
              text: "Playlist saved successfully.",
            });
            setSelected(new Set());
            await invalidatePlaylistCaches(queryClient, selectedPlaylistId);
          } else {
            fail("Couldn't update the playlist", await readApiErrorMessage(response, "Failed to update playlist."));
            // A 409 means the server's view differs from this page's: refetch
            // so "reload and try again" has fresh data to work with. After the
            // message, so the re-crawl does not delay it.
            if (response.status === 409) {
              await invalidatePlaylistCaches(queryClient, selectedPlaylistId);
            }
          }
        } else {
          fail("Couldn't update the playlist", "Couldn’t load the selected playlist.");
        }
      }
    } catch (error) {
      console.error("Save error:", error);
      fail("Couldn't save the playlist", "An error occurred while saving the playlist.");
    } finally {
      setSaving(false);
    }
  };

  const renderTrack = useCallback(
    (track: Track, index: number) => (
      <TrackRow
        as="li"
        key={track.id}
        track={{
          ...track,
          subtitle: `${track.user?.username || "Unknown"} • ${formatDuration(track.duration)}`,
        }}
        isSelected={selected.has(track.id)}
        onToggle={(e) => toggle(track, index, e)}
      />
    ),
    [selected, toggle],
  );

  return (
    <PageContainer kind="workbench">
      <PageHeader
        title="Recently Played"
        description="View your last 25 played tracks and save them to a playlist."
      />

      <div className="space-y-6">
        {outcome ? (
          <ResultPanel
            key={outcome.id}
            status={outcome.status}
            title={outcome.title}
            description={outcome.text}
            onDismiss={() => setOutcome(null)}
          />
        ) : null}

        {loading ? (
          <ToolLayout
            main={
              <Panel>
                <div className="space-y-2">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 rounded-xl" />
                  ))}
                </div>
              </Panel>
            }
            aside={
              <Panel>
                <Skeleton className="mb-4 h-5 w-32" />
                <Skeleton className="mb-4 h-4 w-24" />
                <Skeleton className="h-10 w-full rounded-lg" />
              </Panel>
            }
          />
        ) : recentlyPlayedQuery.isError ? (
          <Panel>
            <InlineAlert variant="error">
              Couldn’t load your recently played tracks. Try refreshing the page.
            </InlineAlert>
          </Panel>
        ) : tracks.length === 0 ? (
          <Panel>
            <EmptyState
              icon={<History className="w-12 h-12" />}
              title="No recently played tracks found"
              description="Go listen to some music on SoundCloud and come back!"
            />
          </Panel>
        ) : (
          <ToolLayout
            main={
              <Panel
                title="Recently played"
                actions={
                  <Button
                    variant="ghost"
                    size="sm"
                    nowrap
                    onClick={toggleAllShown}
                    className="text-primary-text"
                  >
                    {toggleAllLabel}
                  </Button>
                }
              >
                <div className="space-y-3">
                  <ListSearch
                    label="Search recently played tracks"
                    value={query}
                    onChange={setQuery}
                    shown={shownTracks.length}
                    total={tracks.length}
                    noun={tracks.length === 1 ? "track" : "tracks"}
                    placeholder="Search tracks…"
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
              </Panel>
            }
            aside={
              <SaveToPlaylistPanel
                selectedCount={selected.size}
                mode={mode}
                onModeChange={setMode}
                name={newPlaylistName}
                onNameChange={setNewPlaylistName}
                namePlaceholder="Recently Played"
                playlists={playlists}
                playlistsLoading={playlistsQuery.isLoading}
                playlistsError={playlistsQuery.isError}
                onRetryPlaylists={() => playlistsQuery.refetch()}
                target={targetPlaylist}
                onTargetChange={setTargetPlaylist}
                saving={saving}
                onSave={handleSave}
              />
            }
          />
        )}
      </div>
    </PageContainer>
  );
}
