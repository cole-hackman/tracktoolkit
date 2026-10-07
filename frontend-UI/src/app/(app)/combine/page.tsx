"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import Link from "next/link";
import { X, Combine, Check, Music, Trash2, AlertTriangle } from "lucide-react";
import { apiFetch, errorMessageFromBody } from "@/lib/api";
import {
  BulkReviewDetails,
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
  SelectableList,
  SelectableRow,
  Card,
  Button,
  useAnnounce,
} from "@/components/ui";
import { invalidatePlaylistCaches, playlistsQueryOptions } from "@/lib/queries";
import { asArray } from "@/lib/api-shape";

interface Playlist {
  id: number;
  title: string;
  track_count: number;
  artwork_url: string;
  coverUrl?: string;
}

type MergeMode = "new" | "existing";

export default function CombinePlaylistsPage() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();

  const { data: playlistsData } = useSuspenseQuery(playlistsQueryOptions());
  const userPlaylists = useMemo(
    () => asArray<Playlist>(playlistsData?.collection),
    [playlistsData?.collection],
  );

  const [selectedPlaylists, setSelectedPlaylists] = useState<Playlist[]>([]);
  const [newPlaylistTitle, setNewPlaylistTitle] = useState("");
  const [mergeMode, setMergeMode] = useState<MergeMode>("new");
  const [targetPlaylist, setTargetPlaylist] = useState<Playlist | null>(null);
  const [showPlaylistPicker, setShowPlaylistPicker] = useState(false);
  const [deleteAfterMerge, setDeleteAfterMerge] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const pickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    playlists?: { title: string }[];
    playlist?: { title: string };
    overflowPlaylists?: { title: string }[];
    deletedPlaylistIds?: number[];
    deleteErrors?: { id: number; error: string }[];
    stats?: {
      totalTracks?: number;
      finalCount?: number;
      uniqueBeforeCap?: number;
      existingTrackCount?: number;
      addedCount?: number;
    };
    totalTracks?: number;
  } | null>(null);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  const openPlaylistPicker = (event: React.MouseEvent<HTMLButtonElement>) => {
    pickerTriggerRef.current = event.currentTarget;
    setShowPlaylistPicker(true);
  };

  const closePlaylistPicker = () => setShowPlaylistPicker(false);

  // The focus trap, the Escape handler and the focus restore that used to be
  // written out here now come from the shared `Dialog` (which adds the body
  // scroll lock and the safe-area padding this copy never had).

  const handlePlaylistToggle = (playlist: Playlist, index?: number, event?: React.MouseEvent | React.KeyboardEvent) => {
    const idNum = Number(playlist.id);
    const isShiftKey = event && 'shiftKey' in event && event.shiftKey;

    if (isShiftKey && index !== undefined && lastSelectedIndex !== null) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      
      setSelectedPlaylists((prev) => {
        // Keep existing selections, toggle the range
        // For simplicity in playlists, let's just add the range
        const next = [...prev];
        for (let i = start; i <= end; i++) {
          const p = userPlaylists[i];
          if (!next.some((s) => Number(s.id) === Number(p.id))) {
            next.push({ ...p, id: Number(p.id) });
          }
        }
        return next;
      });
    } else {
      setSelectedPlaylists((prev) =>
        prev.find((p) => Number(p.id) === idNum)
          ? prev.filter((p) => Number(p.id) !== idNum)
          : [...prev, { ...playlist, id: idNum }]
      );
      if (index !== undefined) {
        setLastSelectedIndex(index);
      }
    }
    
    // Clear target if it gets selected as source
    if (targetPlaylist && Number(targetPlaylist.id) === idNum) {
      setTargetPlaylist(null);
    }
  };

  // Playlists available as merge target (exclude selected sources)
  const availableTargets = useMemo(
    () => userPlaylists.filter((p) => !selectedPlaylists.some((s) => Number(s.id) === Number(p.id))),
    [userPlaylists, selectedPlaylists],
  );

  const canMerge =
    selectedPlaylists.length >= 2 &&
    (mergeMode === "existing" ? targetPlaylist !== null : newPlaylistTitle.trim().length > 0);

  const handleMergeClick = () => {
    if (!canMerge) return;
    if (deleteAfterMerge && selectedPlaylists.length > 0) {
      setShowDeleteConfirm(true);
    } else {
      executeMerge();
    }
  };

  const executeMerge = async () => {
    setShowDeleteConfirm(false);
    setMergeError(null);
    setIsProcessing(true);
    // One POST does the whole merge, so there is no per-playlist count to
    // drive a ProgressBar. Announce the start and the finish instead.
    announce(`Merging ${selectedPlaylists.length} playlists…`);
    try {
      const body: Record<string, unknown> = {
        sourcePlaylistIds: selectedPlaylists.map((p) => p.id),
      };
      if (mergeMode === "existing" && targetPlaylist) {
        body.targetPlaylistId = targetPlaylist.id;
        body.deleteAfterMerge = deleteAfterMerge;
      } else {
        body.title = newPlaylistTitle.trim();
      }

      const response = await apiFetch("/api/playlists/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const data = await response.json();
        await invalidatePlaylistCaches(queryClient, targetPlaylist?.id ?? null);
        setResult(data);
        setIsComplete(true);
      } else {
        const errorBody = await response.json().catch(() => null);
        if (
          response.status === 409 &&
          errorBody?.code === "PLAYLIST_NOT_FOUND"
        ) {
          // A playlist we were still offering is gone from SoundCloud. Nothing
          // was written, so drop it from the selection (and the target slot),
          // refetch the list so it stops being offered, and say why.
          const missingId = Number(errorBody.playlistId);
          if (Number.isFinite(missingId)) {
            setSelectedPlaylists((prev) => prev.filter((p) => Number(p.id) !== missingId));
            setTargetPlaylist((prev) => (prev && Number(prev.id) === missingId ? null : prev));
          }
          await invalidatePlaylistCaches(queryClient);
        }
        setMergeError(
          errorMessageFromBody(errorBody, "Failed to merge playlists. Please try again."),
        );
      }
    } catch (error) {
      console.error("Error merging playlists:", error);
      setMergeError("An error occurred. Please try again.");
    } finally {
      setIsProcessing(false);
    }
  };

  const totalTracks = useMemo(
    () => selectedPlaylists.reduce((sum, playlist) => sum + (playlist.track_count || 0), 0),
    [selectedPlaylists],
  );

  // The success screen replaces the whole page, so focus is left pointing at a
  // Merge button that no longer exists. Move it to the new heading — the same
  // thing `PageHeader` does on a client-side navigation — and say what
  // happened, because the outcome is otherwise only a change of pixels.
  // Declared before the `isComplete` early return: hooks cannot be conditional.
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!isComplete) return;
    successHeadingRef.current?.focus({ preventScroll: false });

    const created = result?.playlists || (result?.playlist ? [result.playlist] : []);
    const overflow = result?.overflowPlaylists || [];
    const count = created.length + overflow.length;
    const tracks =
      result?.stats?.totalTracks || result?.stats?.finalCount || result?.totalTracks || 0;
    announce(
      mergeMode === "existing"
        ? `Merged: ${result?.stats?.addedCount ?? tracks} tracks added.`
        : `Merged: ${count} playlist${count === 1 ? "" : "s"} created with ${tracks} tracks.`,
    );
  }, [isComplete, result, mergeMode, announce]);

  // ── SUCCESS SCREEN ──────────────────────────────────────────────────────────
  if (isComplete) {
    const playlists =
      result?.playlists || (result?.playlist ? [result.playlist] : []);
    const overflowPlaylists = result?.overflowPlaylists || [];
    const numPlaylists = playlists.length + overflowPlaylists.length;
    const totalTracksCreated =
      result?.stats?.totalTracks ||
      result?.stats?.finalCount ||
      result?.totalTracks ||
      0;
    const addedCount = result?.stats?.addedCount;
    const deletedIds = result?.deletedPlaylistIds || [];
    const deleteErrors = result?.deleteErrors || [];

    return (
      <div className="flex items-center justify-center px-6 py-12">
        <div className="max-w-2xl w-full">
          <Card className="text-center rounded-2xl p-6 sm:p-10 shadow-xl border-2">
            <div className="w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 bg-primary shadow-lg">
              <Check aria-hidden="true" className="w-12 h-12 text-primary-foreground" />
            </div>
            <h1
              ref={successHeadingRef}
              tabIndex={-1}
              className="text-3xl sm:text-5xl font-bold mb-4 text-foreground focus:outline-none"
            >
              {mergeMode === "existing" ? "Playlist Updated!" : numPlaylists > 1 ? `${numPlaylists} Playlists Created!` : "Playlist Created!"}
            </h1>
            <p className="text-lg mb-4 leading-relaxed text-muted-foreground">
              {mergeMode === "existing" ? (
                <>
                  Added {addedCount ?? totalTracksCreated} new tracks to &quot;{playlists[0]?.title || targetPlaylist?.title}&quot;.
                  {overflowPlaylists.length > 0 && ` ${overflowPlaylists.length} overflow playlist(s) created for tracks beyond the 500-track limit.`}
                </>
              ) : numPlaylists > 1 ? (
                <>Split into {numPlaylists} playlists (500 tracks each).</>
              ) : (
                <>
                  &quot;{playlists[0]?.title || newPlaylistTitle}&quot; has been created with {totalTracksCreated} tracks (duplicates removed).
                </>
              )}
            </p>

            {/* Deletion results */}
            {deletedIds.length > 0 && (
              <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg text-left">
                <p className="text-sm font-medium text-green-700 dark:text-green-400 mb-1">
                  <Trash2 className="w-4 h-4 inline mr-1" />
                  {deletedIds.length} source playlist{deletedIds.length > 1 ? "s" : ""} deleted
                </p>
              </div>
            )}
            {deleteErrors.length > 0 && (
              <div className="mb-4 p-3 bg-destructive/10 rounded-lg text-left">
                <p className="text-sm font-medium text-destructive mb-1">
                  <AlertTriangle className="w-4 h-4 inline mr-1" />
                  {deleteErrors.length} playlist{deleteErrors.length > 1 ? "s" : ""} could not be deleted
                </p>
                <ul className="text-xs text-destructive/80 space-y-0.5">
                  {deleteErrors.map((e: { id: number; error: string }) => (
                    <li key={e.id}>ID {e.id}: {e.error}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link href="/dashboard" className="w-full sm:w-auto">
                <Button size="lg" className="w-full">
                  Back to Dashboard
                </Button>
              </Link>
              <Button
                variant="outline"
                size="lg"
                onClick={() => {
                  setIsComplete(false);
                  setSelectedPlaylists([]);
                  setNewPlaylistTitle("");
                  setTargetPlaylist(null);
                  setDeleteAfterMerge(false);
                  setResult(null);
                }}
              >
                Merge More Playlists
              </Button>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  // ── MAIN PAGE ───────────────────────────────────────────────────────────────
  return (
    <PageContainer maxWidth="wide">
        <PageHeader
          title="Combine Playlists"
          description="Select playlists to merge. Duplicates will be automatically removed."
        />

        {/* `min-w-0` on both columns, and it is still doing real work — but
            not the work an earlier version of this comment claimed.

            A grid item's `min-width` is `auto`, which resolves to its
            min-content width. `SelectableRow` now caps itself (`min-w-0` on
            its root), so the playlist ROWS in the left column no longer size
            this grid. The selected-playlist chips in the right column are not
            `SelectableRow`s — each is a plain flex row with a `truncate`
            title and a `shrink-0` Remove button — and `truncate` sets
            `white-space: nowrap`, which makes a chip's min-content the full
            title width whether or not the title has spaces. Without these two
            `min-w-0`s that pushed the merge panel to ~980px inside a 360px
            viewport and the Remove button to `left: 928`, off the screen.

            So: this caps the column, and the ellipsis on the titles inside
            comes from their own `truncate` once the column stops growing.
            Removing it is not safe — verified by deleting it and watching the
            long-title case for this route go red on the selected state. */}
        <div className="grid lg:grid-cols-3 gap-6 lg:gap-8">
          {/* Playlist Selection */}
          <div className="min-w-0 lg:col-span-2">
            <Card className="rounded-2xl p-6 border-2 border-border">
              <h2 className="text-xl font-bold mb-4 text-foreground">
                Your Playlists
              </h2>
              {userPlaylists.length === 0 ? (
                <EmptyState
                  icon={<Music className="w-12 h-12" />}
                  title="No playlists found"
                  description="Create some playlists on SoundCloud first."
                />
              ) : (
                <div className="relative">
                <SelectableList className="max-h-[60dvh] overflow-y-auto pr-1">
                  {userPlaylists.map((playlist, index) => {
                    const isSelected = selectedPlaylists.some(
                      (p) => Number(p.id) === Number(playlist.id)
                    );
                    const isTarget = targetPlaylist && Number(targetPlaylist.id) === Number(playlist.id);
                    return (
                      <SelectableRow
                        key={playlist.id}
                        id={playlist.id}
                        selected={isSelected}
                        disabled={isTarget === true}
                        // The target is not selectable as a source, and the
                        // checkbox has to say so — the row used to communicate
                        // it with 40% opacity and nothing else.
                        label={isTarget ? `${playlist.title} (merge target)` : playlist.title}
                        onToggle={(e) => handlePlaylistToggle(playlist, index, e)}
                      >
                        <span className="flex min-w-0 items-center gap-4">
                          <img
                            src={playlist.artwork_url || playlist.coverUrl || "/brand/icon-192.png"}
                            alt=""
                            width={48}
                            height={48}
                            loading="lazy"
                            decoding="async"
                            className="w-12 h-12 shrink-0 rounded-lg object-cover"
                          />
                          <span className="min-w-0 flex-1 text-left">
                            <span className="block truncate font-semibold text-foreground">
                              {playlist.title}
                            </span>
                            <span className="block text-sm text-muted-foreground">
                              {playlist.track_count} tracks
                              {isTarget && <span className="ml-2 text-primary-text">(target)</span>}
                            </span>
                          </span>
                        </span>
                      </SelectableRow>
                    );
                  })}
                </SelectableList>
                <div aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-card to-transparent rounded-b-xl" />
                </div>
              )}
            </Card>
          </div>

          {/* Merge Panel */}
          <div className="min-w-0 lg:col-span-1">
            <Card className="rounded-2xl p-6 border-2 border-border lg:sticky lg:top-24 space-y-5">
              <h2 className="text-xl font-bold text-foreground">
                Merge Settings
              </h2>

              {/* Selected Playlists */}
              <div>
                <h3 className="block text-sm font-medium mb-2 text-muted-foreground">
                  Selected ({selectedPlaylists.length})
                </h3>
                {selectedPlaylists.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center border-2 border-dashed border-border rounded-lg">
                    Select at least 2 playlists
                  </p>
                ) : (
                  // eslint-disable-next-line jsx-a11y/no-redundant-roles -- Tailwind preflight strips list semantics in WebKit
                  <ul role="list" className="space-y-2">
                    {selectedPlaylists.map((playlist) => (
                      <li
                        key={playlist.id}
                        className="flex items-center gap-2 p-2 bg-secondary/20 rounded-lg"
                      >
                        <img
                          src={playlist.artwork_url || playlist.coverUrl || "/brand/icon-192.png"}
                          alt=""
                          width={28}
                          height={28}
                          loading="lazy"
                          decoding="async"
                          className="w-7 h-7 rounded object-cover shrink-0"
                        />
                        <span className="text-sm truncate flex-1 text-foreground">
                          {playlist.title}
                        </span>
                        <IconButton
                          size="sm"
                          label={`Remove ${playlist.title}`}
                          onClick={() => handlePlaylistToggle(playlist)}
                        >
                          <X className="w-4 h-4" />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Total Tracks */}
              <div className="p-4 bg-secondary/20 rounded-lg">
                <div className="text-sm text-muted-foreground">Total Tracks</div>
                <div className="text-2xl font-bold text-foreground">{totalTracks}</div>
                {totalTracks > 500 && (
                  <p className="text-xs text-primary-text mt-1">
                    Will be split into multiple playlists (500 max each)
                  </p>
                )}
              </div>

              {/* Merge Mode Toggle */}
              <div>
                <h3 className="block text-sm font-medium mb-2 text-muted-foreground" id="merge-into-label">
                  Merge into
                </h3>
                <div
                  role="group"
                  aria-labelledby="merge-into-label"
                  className="flex rounded-lg border-2 border-border overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => setMergeMode("new")}
                    aria-pressed={mergeMode === "new"}
                    className={`min-h-11 flex-1 px-2 text-sm font-medium transition ${
                      mergeMode === "new"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-secondary/20"
                    }`}
                  >
                    New playlist
                  </button>
                  <button
                    type="button"
                    onClick={() => setMergeMode("existing")}
                    aria-pressed={mergeMode === "existing"}
                    className={`min-h-11 flex-1 px-2 text-sm font-medium transition ${
                      mergeMode === "existing"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-secondary/20"
                    }`}
                  >
                    Existing playlist
                  </button>
                </div>
              </div>

              {/* New Playlist Title (only in "new" mode) */}
              {mergeMode === "new" && (
                <Field label="New Playlist Name">
                  {(field) => (
                    <Input
                      {...field}
                      type="text"
                      value={newPlaylistTitle}
                      onChange={(e) => setNewPlaylistTitle(e.target.value)}
                      placeholder="Enter playlist name..."
                      className="h-12 border-2 border-border bg-secondary/20 px-4"
                    />
                  )}
                </Field>
              )}

              {/* Target Playlist Picker (only in "existing" mode) */}
              {mergeMode === "existing" && (
                <div>
                  <h3 className="block text-sm font-medium mb-2 text-muted-foreground">
                    Target Playlist
                  </h3>
                  {availableTargets.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-3 text-center border-2 border-dashed border-border rounded-lg">
                      No available targets (deselect a source first)
                    </p>
                  ) : targetPlaylist ? (
                    <button
                      type="button"
                      onClick={openPlaylistPicker}
                      className="w-full flex items-center gap-3 p-3 rounded-xl bg-primary/10 border-2 border-primary transition-all hover:bg-primary/15 text-left"
                    >
                      <img
                        src={targetPlaylist.coverUrl || targetPlaylist.artwork_url || "/brand/icon-192.png"}
                        alt=""
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
                      onClick={openPlaylistPicker}
                      className="min-h-11 w-full px-4 py-3 rounded-lg border-2 border-dashed border-border text-sm text-muted-foreground hover:border-primary hover:text-primary-text transition-all text-center"
                    >
                      Choose a target playlist…
                    </button>
                  )}
                </div>
              )}

              {/* Delete after merge checkbox */}
              {mergeMode === "existing" && (
                <label className="touch-44 flex items-center gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={deleteAfterMerge}
                    onChange={(e) => setDeleteAfterMerge(e.target.checked)}
                    className="h-6 w-6 shrink-0 cursor-pointer accent-primary"
                  />
                  <span className="text-sm text-muted-foreground group-hover:text-foreground transition">
                    Delete source playlists after merge
                  </span>
                </label>
              )}

              {/* Inline merge error */}
              {mergeError && <InlineAlert variant="error">{mergeError}</InlineAlert>}

              {/* Merge Button */}
              <Button
                onClick={handleMergeClick}
                disabled={!canMerge || isProcessing}
                size="lg"
                className="w-full"
              >
                {isProcessing ? (
                  <>
                    <LoadingSpinner size="sm" className="text-white" />
                    {/* The spinner is decoration; this is what says the merge
                        is running, so it has to be in a live region. */}
                    <span role="status">Merging…</span>
                  </>
                ) : (
                  <>
                    <Combine aria-hidden="true" className="w-5 h-5" />
                    Merge Playlists
                  </>
                )}
              </Button>
            </Card>
          </div>
        </div>

      {/* ── DELETE CONFIRMATION DIALOG ─────────────────────────────────────── */}
      <ConfirmDialog
        open={showDeleteConfirm}
        title="Confirm Deletion"
        description="After merging, these source playlists will be permanently deleted:"
        confirmLabel="Merge & Delete"
        variant="destructive"
        onConfirm={executeMerge}
        onCancel={() => setShowDeleteConfirm(false)}
      >
        <BulkReviewDetails
          action="merging and deleting"
          warning="This cannot be undone. The merge proceeds even if some deletions fail."
          exportFilename="playlists-to-delete-after-merge.csv"
          items={selectedPlaylists.map((playlist) => ({
            id: playlist.id,
            label: playlist.title,
            meta: `${playlist.track_count} tracks`,
          }))}
        />
      </ConfirmDialog>

      {/* ── PLAYLIST PICKER MODAL ──────────────────────────────────────────── */}
      <Dialog
        open={showPlaylistPicker}
        onClose={closePlaylistPicker}
        title="Target Playlist"
        variant="sheet"
        size="md"
        returnFocusRef={pickerTriggerRef}
      >
        <div className="space-y-2 max-h-[60dvh] overflow-y-auto">
          {availableTargets.length === 0 ? (
            <p className="text-sm text-muted-foreground py-3 text-center border-2 border-dashed border-border rounded-lg">
              No available targets (deselect a source first)
            </p>
          ) : (
            availableTargets.map((playlist) => {
              const isSelected = targetPlaylist && Number(targetPlaylist.id) === Number(playlist.id);
              return (
                <button
                  key={playlist.id}
                  type="button"
                  aria-pressed={isSelected === true}
                  onClick={() => {
                    setTargetPlaylist(playlist);
                    closePlaylistPicker();
                  }}
                  className={`w-full flex items-center gap-4 p-4 rounded-xl transition-all ${
                    isSelected
                      ? "bg-primary/10 border-2 border-primary"
                      : "bg-secondary/20 border-2 border-transparent hover:border-border"
                  }`}
                >
                  <img
                    src={playlist.coverUrl || playlist.artwork_url || "/brand/icon-192.png"}
                    alt=""
                    width={48}
                    height={48}
                    loading="lazy"
                    decoding="async"
                    className="w-12 h-12 shrink-0 rounded-lg object-cover"
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
                    <span className="w-6 h-6 rounded-full bg-primary flex items-center justify-center shrink-0">
                      <Check aria-hidden="true" className="w-4 h-4 text-primary-foreground" />
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </Dialog>
    </PageContainer>
  );
}
