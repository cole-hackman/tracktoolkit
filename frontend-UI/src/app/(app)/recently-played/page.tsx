"use client";

import { useState, useEffect, useId, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Search, SquarePlus, History } from "lucide-react";
import {
  Button,
  Card,
  EmptyState,
  Field,
  InlineAlert,
  Input,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  Select,
  SelectableList,
  Skeleton,
  TrackRow,
  useAnnounce,
} from "@/components/ui";
import { apiFetch, readApiErrorMessage } from "@/lib/api";
import {
  invalidatePlaylistCaches,
  useRecentlyPlayedQuery,
  usePlaylistDetailQuery,
  usePlaylistsQuery,
} from "@/lib/queries";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { asArray } from "@/lib/api-shape";

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
}

export default function RecentlyPlayedPage() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const modeGroupLabelId = useId();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  
  const recentlyPlayedQuery = useRecentlyPlayedQuery();
  // Only needed for the "existing playlist" dropdown — don't block the
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
  const loadingPlaylists = mode === "existing" && playlistsQuery.isLoading;

  useEffect(() => {
    if (recentlyPlayedQuery.isError || playlistsQuery.isError) {
      setNotice({ type: "error", text: "Couldn’t load your recently played tracks. Try refreshing the page." });
    }
  }, [recentlyPlayedQuery.isError, playlistsQuery.isError]);

  const toggleTrack = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === filteredTracks.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredTracks.map((t) => t.id)));
    }
  };

  const formatDuration = (ms: number) => {
    if (!ms) return "0:00";
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const debouncedSearch = useDebouncedValue(search, 150);

  useEffect(() => {
    if (!recentlyPlayedQuery.isSuccess) return;
    announce(`${tracks.length} recently played track${tracks.length === 1 ? "" : "s"} loaded`);
  }, [recentlyPlayedQuery.isSuccess, tracks.length, announce]);

  const filteredTracks = useMemo(() => {
    const query = debouncedSearch.toLowerCase();
    return tracks.filter((t) =>
      !query || t.title.toLowerCase().includes(query) ||
      t.user?.username?.toLowerCase().includes(query)
    );
  }, [tracks, debouncedSearch]);

  // Filtering is instant and silent; the debounce means this speaks once per
  // pause rather than once per keystroke.
  useEffect(() => {
    if (!debouncedSearch) return;
    announce(`${filteredTracks.length} track${filteredTracks.length === 1 ? "" : "s"} match`);
  }, [debouncedSearch, filteredTracks.length, announce]);

  const handleSave = async () => {
    if (selected.size === 0) return;
    setSaving(true);
    setNotice(null);

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
          setNotice({ type: "success", text: "Playlist saved successfully." });
          announce("Playlist saved", { assertive: true });
          setSelected(new Set());
        } else {
          setNotice({ type: "error", text: "Failed to create playlist." });
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
            setNotice({ type: "success", text: "Playlist saved successfully." });
            announce("Playlist saved", { assertive: true });
            setSelected(new Set());
            await invalidatePlaylistCaches(queryClient, selectedPlaylistId);
          } else {
            setNotice({
              type: "error",
              text: await readApiErrorMessage(response, "Failed to update playlist."),
            });
            // A 409 means the server's view differs from this page's: refetch
            // so "reload and try again" has fresh data to work with. After the
            // message, so the re-crawl does not delay it.
            if (response.status === 409) {
              await invalidatePlaylistCaches(queryClient, selectedPlaylistId);
            }
          }
        } else {
          setNotice({ type: "error", text: "Couldn’t load the selected playlist." });
        }
      }
    } catch (error) {
      console.error("Save error:", error);
      setNotice({ type: "error", text: "An error occurred while saving the playlist." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageContainer maxWidth="wide">
        <PageHeader
          title="Recently Played"
          description="View your last 25 played tracks and save them to a playlist."
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

        {loading ? (
          <div className="grid lg:grid-cols-3 gap-8">
            <Card className="min-w-0 p-4 sm:p-6 lg:col-span-2">
              <div className="space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 rounded-lg" />
                ))}
              </div>
            </Card>
            <Card className="h-fit min-w-0 p-4 sm:p-6">
              <Skeleton className="h-5 w-32 mb-4" />
              <Skeleton className="h-4 w-24 mb-4" />
              <Skeleton className="h-10 w-full rounded-lg" />
            </Card>
          </div>
        ) : tracks.length === 0 ? (
          <Card className="p-4 sm:p-8">
            <EmptyState
              icon={<History className="w-12 h-12" />}
              title="No recently played tracks found"
              description="Go listen to some music on SoundCloud and come back!"
            />
          </Card>
        ) : (
          <div className="grid lg:grid-cols-3 gap-8">
            {/* Track list */}
            <Card className="min-w-0 p-4 sm:p-6 lg:col-span-2">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <Field
                  label="Search recently played tracks"
                  labelHidden
                  className="min-w-0 flex-1"
                >
                  {(field) => (
                    <div className="relative">
                      <Search
                        aria-hidden="true"
                        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground-subtle"
                      />
                      <Input
                        {...field}
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search tracks…"
                        className="h-11 pl-10"
                      />
                    </div>
                  )}
                </Field>
                <Button
                  variant="ghost"
                  size="sm"
                  nowrap
                  onClick={selectAll}
                  className="shrink-0 text-primary-text"
                >
                  {selected.size === filteredTracks.length ? "Deselect All" : "Select All"}
                </Button>
              </div>

              <SelectableList className="max-h-[60dvh] overflow-y-auto">
                {filteredTracks.map((track) => {
                  const isSelected = selected.has(track.id);
                  const subtitle = `${track.user?.username || "Unknown"} • ${formatDuration(track.duration)}`;

                  return (
                    <TrackRow
                      as="li"
                      key={track.id}
                      track={{
                        ...track,
                        subtitle,
                      }}
                      isSelected={isSelected}
                      onToggle={() => toggleTrack(track.id)}
                    />
                  );
                })}
              </SelectableList>
            </Card>

            {/* Save panel */}
            <Card className="h-fit min-w-0 space-y-4 p-4 sm:p-6 lg:sticky lg:top-24">
              <div>
                <h2 className="text-lg font-bold text-foreground">Save to Playlist</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selected.size} track{selected.size !== 1 ? "s" : ""} selected
                </p>
              </div>

              <div>
                <span
                  id={modeGroupLabelId}
                  className="mb-2 block text-sm font-semibold text-foreground"
                >
                  Save to
                </span>
                <div role="group" aria-labelledby={modeGroupLabelId} className="flex gap-2">
                  <button
                    type="button"
                    aria-pressed={mode === "new"}
                    onClick={() => setMode("new")}
                    className={`min-h-11 flex-1 px-3 py-2 rounded-lg text-sm font-medium transition ${
                      mode === "new" ? "bg-primary text-primary-foreground" : "bg-gray-100 dark:bg-secondary/50 text-muted-foreground"
                    }`}
                  >
                    New Playlist
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === "existing"}
                    onClick={() => setMode("existing")}
                    className={`min-h-11 flex-1 px-3 py-2 rounded-lg text-sm font-medium transition ${
                      mode === "existing" ? "bg-primary text-primary-foreground" : "bg-gray-100 dark:bg-secondary/50 text-muted-foreground"
                    }`}
                  >
                    Existing
                  </button>
                </div>
              </div>

              {mode === "new" ? (
                <Field label="Playlist name" hint="Optional — a dated name is used if you leave it blank.">
                  {(field) => (
                    <Input
                      {...field}
                      type="text"
                      value={newPlaylistName}
                      onChange={(e) => setNewPlaylistName(e.target.value)}
                      placeholder="Recently Played"
                      className="h-11"
                    />
                  )}
                </Field>
              ) : loadingPlaylists ? (
                <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground-subtle">
                  <LoadingSpinner size="sm" />
                  Loading playlists…
                </div>
              ) : (
                <Select
                  label="Playlist"
                  value={selectedPlaylistId || ""}
                  onChange={(e) => setSelectedPlaylistId(Number(e.target.value))}
                >
                  <option value="">Choose a playlist…</option>
                  {playlists.map((pl) => (
                    <option key={pl.id} value={pl.id}>
                      {pl.title} ({pl.track_count} tracks)
                    </option>
                  ))}
                </Select>
              )}

              <Button
                onClick={handleSave}
                disabled={saving || selected.size === 0 || (mode === "existing" && !selectedPlaylistId)}
                className="w-full"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <SquarePlus className="w-4 h-4" />
                    Save to Playlist
                  </>
                )}
              </Button>
            </Card>
          </div>
        )}
    </PageContainer>
  );
}
