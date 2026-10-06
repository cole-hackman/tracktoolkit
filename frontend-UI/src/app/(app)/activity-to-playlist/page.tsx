"use client";

import { useState, useEffect, useId, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Radio, Loader2, Search, SquarePlus } from "lucide-react";
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
  useActivitiesQuery,
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

interface Activity {
  type: string;
  created_at: string;
  /**
   * Passed straight through from SoundCloud, so it is whatever that feed
   * carried: sometimes a user object, sometimes a `soundcloud:users:<id>`
   * URN, sometimes nothing.
   */
  reposter?: string | { username?: string | null } | null;
  origin: Track;
}

/**
 * The reposter's name, or null when all we have is an identifier.
 *
 * The row used to print the numeric id out of the URN — "Reposted by
 * 12345678", which names nobody and reads as noise. A URN or a bare number
 * is an internal identifier, not a name, so the fragment is dropped instead.
 */
function reposterName(reposter: Activity["reposter"]): string | null {
  if (!reposter) return null;
  if (typeof reposter === "object") return reposter.username?.trim() || null;

  const value = reposter.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return null;
  if (/^soundcloud:users:\d+$/i.test(value)) return null;
  return value;
}

interface Playlist {
  id: number;
  title: string;
  track_count: number;
}

export default function ActivityToPlaylistPage() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const modeGroupLabelId = useId();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<number | null>(null);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const activitiesQuery = useActivitiesQuery(200);
  // Only needed for the "existing playlist" dropdown — don't block the
  // activity list on a fetch it doesn't need yet.
  const playlistsQuery = usePlaylistsQuery({ enabled: mode === "existing" });
  const selectedPlaylistQuery = usePlaylistDetailQuery(selectedPlaylistId ?? 0, {
    enabled: mode === "existing" && selectedPlaylistId != null,
    // Include blocked tracks so the list sent back is the whole playlist.
    allAccess: true,
  });
  const activities = useMemo(
    () => asArray<Activity>(activitiesQuery.data?.collection),
    [activitiesQuery.data?.collection],
  );
  const playlists = useMemo(
    () => asArray<Playlist>(playlistsQuery.data?.collection),
    [playlistsQuery.data?.collection],
  );
  const loading = activitiesQuery.isLoading;
  const loadingPlaylists = mode === "existing" && playlistsQuery.isLoading;

  useEffect(() => {
    if (activitiesQuery.isError || playlistsQuery.isError) {
      setNotice({ type: "error", text: "Couldn’t load your activity feed. Try refreshing the page." });
    }
  }, [activitiesQuery.isError, playlistsQuery.isError]);

  const toggleTrack = (id: number, index: number, currentFilteredActivities: Activity[], event?: React.MouseEvent | React.KeyboardEvent) => {
    const isShiftKey = event && 'shiftKey' in event && event.shiftKey;

    if (isShiftKey && lastSelectedIndex !== null) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      
      setSelected((prev) => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          next.add(currentFilteredActivities[i].origin.id);
        }
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setLastSelectedIndex(index);
    }
  };

  const selectAll = () => {
    if (selected.size === filteredActivities.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredActivities.map((a) => a.origin.id)));
    }
  };

  const formatDuration = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const debouncedSearch = useDebouncedValue(search, 150);

  const filteredActivities = useMemo(() => {
    const query = debouncedSearch.toLowerCase();
    return activities.filter((a) =>
      !query || a.origin.title.toLowerCase().includes(query) ||
      a.origin.user?.username?.toLowerCase().includes(query)
    );
  }, [activities, debouncedSearch]);

  useEffect(() => {
    if (!activitiesQuery.isSuccess) return;
    announce(`${activities.length} activit${activities.length === 1 ? "y" : "ies"} loaded`);
  }, [activitiesQuery.isSuccess, activities.length, announce]);

  // Filtering is instant and silent; the debounce means this speaks once per
  // pause rather than once per keystroke.
  useEffect(() => {
    if (!debouncedSearch) return;
    announce(`${filteredActivities.length} track${filteredActivities.length === 1 ? "" : "s"} match`);
  }, [debouncedSearch, filteredActivities.length, announce]);

  const handleSave = async () => {
    if (selected.size === 0) return;
    setSaving(true);
    setNotice(null);

    try {
      const trackIds = Array.from(selected);

      if (mode === "new") {
        const title = newPlaylistName.trim() || `Activity Tracks ${new Date().toLocaleDateString()}`;
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
            await invalidatePlaylistCaches(queryClient, selectedPlaylistId);
            setNotice({ type: "success", text: "Playlist saved successfully." });
            announce("Playlist saved", { assertive: true });
            setSelected(new Set());
          } else {
            setNotice({
              type: "error",
              text: await readApiErrorMessage(response, "Failed to update playlist."),
            });
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
          title="Activity → Playlist"
          description="Select tracks from your activity feed and save them to a playlist."
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
        ) : activities.length === 0 ? (
          <Card className="p-4 sm:p-8">
            <EmptyState
              icon={<Radio className="w-12 h-12" />}
              title="No activities found"
              description="Your activity feed appears to be empty."
            />
          </Card>
        ) : (
          <div className="grid lg:grid-cols-3 gap-8">
            {/* Track list */}
            <Card className="min-w-0 p-4 sm:p-6 lg:col-span-2">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <Field
                  label="Search activity feed tracks"
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
                  {selected.size === filteredActivities.length ? "Deselect All" : "Select All"}
                </Button>
              </div>

              <SelectableList className="max-h-[60dvh] overflow-y-auto">
                {filteredActivities.map((activity, index) => {
                  const track = activity.origin;
                  const isSelected = selected.has(track.id);
                  const isRepost = activity.type.includes('repost');
                  const reposter = isRepost ? reposterName(activity.reposter) : null;
                  let subtitle = `${track.user?.username || "Unknown"} • ${formatDuration(track.duration)}`;

                  if (isRepost) {
                    subtitle += reposter ? ` • Reposted by ${reposter}` : ` • Reposted`;
                  }

                  return (
                    <TrackRow
                      as="li"
                      key={track.id}
                      track={{
                        ...track,
                        subtitle,
                      }}
                      isSelected={isSelected}
                      onToggle={(e) => toggleTrack(track.id, index, filteredActivities, e)}
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
                      placeholder="Activity Tracks"
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
