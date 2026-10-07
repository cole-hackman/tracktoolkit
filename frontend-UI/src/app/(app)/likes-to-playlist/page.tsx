"use client";

import { useState, useEffect, useId, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Check, Plus, Music } from "lucide-react";
import { apiFetch, errorMessageFromBody } from "@/lib/api";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  InlineAlert,
  Input,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  ResultPanel,
  SectionHeading,
  SelectableList,
  Skeleton,
  TrackRow,
  useAnnounce,
} from "@/components/ui";
import { invalidatePlaylistCaches, useLikesQuery, usePlaylistsQuery } from "@/lib/queries";
import { asArray } from "@/lib/api-shape";

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

type AddMode = "new" | "existing";

export default function LikesToPlaylistPage() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const modeGroupLabelId = useId();
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement>(null);
  const [prefillTrackId, setPrefillTrackId] = useState<number | null>(null);
  const [selectedTracks, setSelectedTracks] = useState<Set<number>>(new Set());
  const [playlistName, setPlaylistName] = useState("");
  const [addMode, setAddMode] = useState<AddMode>("new");
  const [targetPlaylist, setTargetPlaylist] = useState<Playlist | null>(null);
  const [showPlaylistPicker, setShowPlaylistPicker] = useState(false);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [success, setSuccess] = useState(false);
  const [result, setResult] = useState<{
    playlist?: { id: number; title: string; permalink_url: string };
    playlists?: CreatedPlaylist[];
    overflowPlaylists?: CreatedPlaylist[];
    totalTracks?: number;
    addedCount?: number;
    numPlaylistsCreated?: number;
  } | null>(null);

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
  const loadingPlaylists = playlistsQuery.isLoading;

  useEffect(() => {
    if (likesQuery.isError) {
      setNotice({ type: "error", text: "Couldn’t load your liked tracks. Try refreshing the page." });
    }
  }, [likesQuery.isError]);

  // The list arriving is a purely visual event; say how much of it there is.
  useEffect(() => {
    if (!likesQuery.isSuccess) return;
    announce(`${likes.length} liked track${likes.length === 1 ? "" : "s"} loaded`);
  }, [likesQuery.isSuccess, likes.length, announce]);

  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  useEffect(() => {
    const idParam = new URLSearchParams(window.location.search).get("id");
    const trackId = idParam ? Number(idParam) : NaN;
    if (Number.isInteger(trackId)) setPrefillTrackId(trackId);
  }, []);

  useEffect(() => {
    if (prefillTrackId != null && likes.some((track) => track.id === prefillTrackId)) {
      setSelectedTracks(new Set([prefillTrackId]));
    }
  }, [likes, prefillTrackId]);

  const toggleTrack = (id: number, index: number, event?: React.MouseEvent | React.KeyboardEvent) => {
    const isShiftKey = event && 'shiftKey' in event && event.shiftKey;

    if (isShiftKey && lastSelectedIndex !== null) {
      // Select a range
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      
      setSelectedTracks((prev) => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          next.add(likes[i].id);
        }
        return next;
      });
    } else {
      // Standard toggle
      setSelectedTracks((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setLastSelectedIndex(index);
    }
  };

  const selectAll = () => {
    if (selectedTracks.size === likes.length) {
      setSelectedTracks(new Set());
    } else {
      setSelectedTracks(new Set(likes.map((t) => t.id)));
    }
  };

  // The success screen replaces the page, so move focus to its heading —
  // otherwise focus sits on a button that no longer exists and a screen
  // reader is never told the operation finished.
  useEffect(() => {
    if (!success) return;
    successHeadingRef.current?.focus();
  }, [success]);

  const canCreate =
    selectedTracks.size > 0 &&
    (addMode === "existing" ? targetPlaylist !== null : playlistName.trim().length > 0);

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    setNotice(null);
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
        setResult(data);
        setSuccess(true);
        announce(
          addMode === "existing"
            ? "Tracks added to playlist"
            : "Playlist created",
          { assertive: true },
        );
      } else {
        // Show the reason first: it must not wait on a cold list refetch.
        setNotice({ type: "error", text: errorMessageFromBody(data, "Failed to create playlist") });
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
      setNotice({ type: "error", text: "An error occurred. Please try again." });
    } finally {
      setCreating(false);
    }
  };

  const formatDuration = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  // ── SUCCESS SCREEN ──────────────────────────────────────────────────────────
  if (success && result) {
    const multiple = result.playlists && result.playlists.length > 1;
    const isExisting = addMode === "existing";

    return (
      <div className="flex items-center justify-center px-6 py-6">
        <div className="max-w-2xl w-full text-center">
          <ResultPanel tone="success" className="p-5">
            <div className="w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 bg-gradient-to-br from-[#22c55e] to-[#16a34a] shadow-lg">
              <Check className="w-12 h-12 text-white" />
            </div>
            <h1
              ref={successHeadingRef}
              tabIndex={-1}
              className="text-2xl md:text-3xl font-bold mb-4 text-foreground focus:outline-none"
            >
              {isExisting ? "Tracks Added!" : multiple ? "Playlists Created!" : "Playlist Created!"}
            </h1>
            <p className="text-sm mb-6 text-muted-foreground">
              {isExisting ? (
                <>
                  Added {result.addedCount ?? selectedTracks.size} new track{(result.addedCount ?? 1) !== 1 ? "s" : ""} to &quot;{targetPlaylist?.title}&quot;.
                  {result.overflowPlaylists && result.overflowPlaylists.length > 0 &&
                    ` ${result.overflowPlaylists.length} overflow playlist(s) created for tracks beyond the 500-track limit.`}
                </>
              ) : multiple ? (
                `${result.totalTracks ?? selectedTracks.size} tracks across ${result.numPlaylistsCreated} playlists.`
              ) : (
                `"${playlistName}" has been created with ${result.totalTracks ?? selectedTracks.size} tracks.`
              )}
            </p>
            {multiple && result.playlists && (
              <div className="mb-6 space-y-2 text-left">
                {result.playlists.map((p) => (
                  <a
                    key={p.id}
                    href={p.permalink_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block px-4 py-3 rounded-lg border-2 border-gray-200 dark:border-border hover:border-primary hover:bg-primary/5 transition"
                  >
                    <span className="font-semibold text-foreground">{p.title}</span>
                    <span className="text-sm text-muted-foreground ml-2">({p.trackCount} tracks)</span>
                  </a>
                ))}
              </div>
            )}
            {!multiple && !isExisting && result.playlist?.permalink_url && (
              <div className="mb-6">
                <a
                  href={result.playlist.permalink_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block px-6 py-3 rounded-lg font-semibold bg-primary/10 text-primary-text hover:bg-primary/15 transition"
                >
                  Open in SoundCloud
                </a>
              </div>
            )}
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                href="/dashboard"
                className="inline-flex min-h-11 items-center justify-center px-8 py-3 rounded-lg font-semibold bg-gradient-to-r from-[#FF5500] to-[#E64A00] text-white hover:shadow-lg transition"
              >
                Back to Dashboard
              </Link>
              <Button
                variant="outline"
                onClick={() => {
                  setSuccess(false);
                  setResult(null);
                  setSelectedTracks(new Set());
                  setPlaylistName("");
                  setTargetPlaylist(null);
                }}
                className="px-8"
              >
                {isExisting ? "Add More" : "Create Another"}
              </Button>
            </div>
          </ResultPanel>
        </div>
      </div>
    );
  }

  // ── MAIN PAGE ───────────────────────────────────────────────────────────────
  return (
    <PageContainer maxWidth="wide">
        <PageHeader
          title="Likes → Playlist"
          description="Convert your liked tracks into an organized playlist."
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

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Track List */}
          <div className="lg:col-span-2">
            <Card className="p-4 sm:p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-bold text-foreground sm:text-xl">
                  Your Liked Tracks{" "}
                  <span className="text-base font-normal text-muted-foreground">
                    ({likes.length})
                  </span>
                </h2>
                <Button variant="ghost" size="sm" onClick={selectAll} className="text-primary-text">
                  {selectedTracks.size === likes.length ? "Deselect All" : "Select All"}
                </Button>
              </div>

              {loading ? (
                <div className="space-y-3">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 rounded-lg bg-gray-100 dark:bg-secondary/50" />
                  ))}
                </div>
              ) : likes.length === 0 ? (
                <EmptyState icon={<Music className="w-12 h-12" />} title="No liked tracks found" />
              ) : (
                <SelectableList className="max-h-[60dvh] overflow-y-auto">
                  {likes.map((track, index) => {
                    const isSelected = selectedTracks.has(track.id);
                    return (
                      <TrackRow
                        as="li"
                        key={track.id}
                        track={{ ...track, subtitle: track.user?.username }}
                        isSelected={isSelected}
                        onToggle={(e) => toggleTrack(track.id, index, e)}
                        rightSlot={
                          <span className="text-xs text-muted-foreground">
                            {formatDuration(track.duration)}
                          </span>
                        }
                      />
                    );
                  })}
                </SelectableList>
              )}
            </Card>
          </div>

          {/* Create Panel */}
          <div className="lg:col-span-1">
            <Card className="space-y-5 p-4 sm:p-6 lg:sticky lg:top-24">
              <h2 className="text-lg font-bold text-foreground sm:text-xl">
                {addMode === "existing" ? "Add to Playlist" : "Create Playlist"}
              </h2>

              <div className="p-4 bg-gray-50 dark:bg-secondary/20 rounded-lg">
                <div className="text-sm text-muted-foreground">Selected Tracks</div>
                <div className="text-2xl font-bold text-foreground">
                  {selectedTracks.size}
                </div>
              </div>

              {selectedTracks.size > 500 && addMode === "new" && (
                <p className="text-sm text-primary-text">
                  Selection exceeds 500 tracks; multiple playlists will be created.
                </p>
              )}

              {/* Mode Toggle */}
              <div>
                <span
                  id={modeGroupLabelId}
                  className="mb-2 block text-sm font-semibold text-foreground"
                >
                  Add to
                </span>
                <div
                  role="group"
                  aria-labelledby={modeGroupLabelId}
                  className="flex overflow-hidden rounded-lg border-2 border-gray-200 dark:border-border"
                >
                  <button
                    type="button"
                    aria-pressed={addMode === "new"}
                    onClick={() => setAddMode("new")}
                    className={`min-h-11 flex-1 px-2 py-2 text-sm font-medium transition ${
                      addMode === "new"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-gray-50 dark:hover:bg-secondary/20"
                    }`}
                  >
                    New playlist
                  </button>
                  <button
                    type="button"
                    aria-pressed={addMode === "existing"}
                    onClick={() => setAddMode("existing")}
                    className={`min-h-11 flex-1 px-2 py-2 text-sm font-medium transition ${
                      addMode === "existing"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-gray-50 dark:hover:bg-secondary/20"
                    }`}
                  >
                    Existing playlist
                  </button>
                </div>
              </div>

              {/* New Playlist Name (only in "new" mode) */}
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

              {/* Target Playlist Picker (only in "existing" mode) */}
              {addMode === "existing" && (
                <div className="space-y-2">
                  <SectionHeading as="h3">Target playlist</SectionHeading>
                  {loadingPlaylists ? (
                    <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground-subtle">
                      <LoadingSpinner size="sm" />
                      Loading playlists…
                    </div>
                  ) : userPlaylists.length === 0 ? (
                    <p className="text-sm text-muted-foreground-subtle py-3 text-center border-2 border-dashed border-gray-200 dark:border-border rounded-lg">
                      No playlists found
                    </p>
                  ) : targetPlaylist ? (
                    <button
                      type="button"
                      ref={pickerTriggerRef}
                      aria-haspopup="dialog"
                      onClick={() => setShowPlaylistPicker(true)}
                      className="min-h-11 w-full flex items-center gap-3 p-3 rounded-xl bg-primary/10 border-2 border-primary transition-all hover:bg-primary/15 text-left"
                    >
                      <img
                        src={targetPlaylist.coverUrl || targetPlaylist.artwork_url || "/brand/icon-192.png"}
                        alt={targetPlaylist.title}
                        width={40}
                        height={40}
                        loading="lazy"
                        decoding="async"
                        className="w-10 h-10 rounded-lg object-cover"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-foreground text-sm truncate">
                          {targetPlaylist.title}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {targetPlaylist.track_count} tracks
                        </div>
                      </div>
                      <span className="text-xs text-primary-text font-medium shrink-0">Change</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      ref={pickerTriggerRef}
                      aria-haspopup="dialog"
                      onClick={() => setShowPlaylistPicker(true)}
                      className="min-h-11 w-full px-4 py-3 rounded-lg border-2 border-dashed border-gray-300 dark:border-border text-sm text-muted-foreground-subtle hover:border-primary hover:text-primary-text transition-all text-center"
                    >
                      Choose a playlist…
                    </button>
                  )}
                </div>
              )}

              <Button
                onClick={handleCreate}
                disabled={!canCreate || creating}
                className="w-full"
              >
                {creating ? (
                  <>
                    <LoadingSpinner size="sm" className="text-white" />
                    {addMode === "existing" ? "Adding..." : "Creating..."}
                  </>
                ) : (
                  <>
                    <Plus className="w-5 h-5" />
                    {addMode === "existing" ? "Add to Playlist" : "Create Playlist"}
                  </>
                )}
              </Button>
            </Card>
          </div>
        </div>

      {/* ── PLAYLIST PICKER DIALOG ─────────────────────────────────────────── */}
      <Dialog
        open={showPlaylistPicker}
        onClose={() => setShowPlaylistPicker(false)}
        title="Your playlists"
        variant="sheet"
        size="md"
        returnFocusRef={pickerTriggerRef}
      >
        {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- Tailwind's
            preflight sets list-style:none, which makes WebKit drop the list
            semantics; the explicit role is what keeps them. Same reason as
            components/ui/SelectableList.tsx. */}
        <ul role="list" className="max-h-[60dvh] space-y-2 overflow-y-auto">
          {userPlaylists.map((playlist) => {
            const isSelected = !!targetPlaylist && Number(targetPlaylist.id) === Number(playlist.id);
            return (
              <li key={playlist.id}>
                <button
                  type="button"
                  onClick={() => {
                    setTargetPlaylist(playlist);
                    setShowPlaylistPicker(false);
                  }}
                  className={`min-h-11 w-full flex items-center gap-4 p-4 rounded-xl transition-all ${
                    isSelected
                      ? "bg-primary/10 border-2 border-primary"
                      : "bg-gray-50 dark:bg-secondary/20 border-2 border-transparent hover:border-gray-200 dark:hover:border-border"
                  }`}
                >
                  <img
                    src={playlist.coverUrl || playlist.artwork_url || "/brand/icon-192.png"}
                    alt=""
                    width={48}
                    height={48}
                    loading="lazy"
                    decoding="async"
                    className="w-12 h-12 rounded-lg object-cover"
                  />
                  <span className="flex-1 text-left min-w-0">
                    <span className="block font-semibold text-foreground truncate">
                      {playlist.title}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {playlist.track_count} tracks
                    </span>
                  </span>
                  {isSelected && (
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary">
                      <Check className="w-4 h-4 text-white" aria-hidden="true" />
                      <span className="sr-only">Currently selected</span>
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </Dialog>
    </PageContainer>
  );
}
