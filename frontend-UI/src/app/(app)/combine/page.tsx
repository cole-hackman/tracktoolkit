"use client";

import { useState, useMemo } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { X, Combine, Trash2, AlertTriangle } from "lucide-react";
import { apiFetch, errorMessageFromBody } from "@/lib/api";
import {
  ActionBar,
  BulkReviewDetails,
  Button,
  ConfirmDialog,
  Field,
  IconButton,
  Input,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  Panel,
  ResultPanel,
  SectionHeading,
  SegmentedControl,
  ToolLayout,
  useAnnounce,
  type ResultStatus,
} from "@/components/ui";
import { PlaylistPicker } from "@/components/playlists/PlaylistPicker";
import { PlaylistChooser } from "@/components/playlists/PlaylistChooser";
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

interface MergeResponse {
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
}

/** What the result slot shows. Strings are fixed when the run ends, so
 *  clearing the form for the next run cannot change what the result says. */
interface MergeOutcome {
  id: number;
  status: ResultStatus;
  title: string;
  description: string;
  announcement: string;
  deletedCount: number;
  deleteErrors: { id: number; error: string }[];
}

const MERGE_MODES = [
  { value: "new", label: "New playlist" },
  { value: "existing", label: "Existing playlist" },
] as const;

function buildOutcome(
  result: MergeResponse,
  mergeMode: MergeMode,
  newPlaylistTitle: string,
  targetTitle: string | undefined,
): MergeOutcome {
  const playlists = result.playlists || (result.playlist ? [result.playlist] : []);
  const overflowPlaylists = result.overflowPlaylists || [];
  const numPlaylists = playlists.length + overflowPlaylists.length;
  const totalTracksCreated =
    result.stats?.totalTracks || result.stats?.finalCount || result.totalTracks || 0;
  const addedCount = result.stats?.addedCount;
  const deletedIds = result.deletedPlaylistIds || [];
  const deleteErrors = result.deleteErrors || [];

  const title =
    mergeMode === "existing"
      ? "Playlist Updated!"
      : numPlaylists > 1
        ? `${numPlaylists} Playlists Created!`
        : "Playlist Created!";

  let description: string;
  if (mergeMode === "existing") {
    description = `Added ${addedCount ?? totalTracksCreated} new tracks to "${playlists[0]?.title || targetTitle}".`;
    if (overflowPlaylists.length > 0) {
      description += ` ${overflowPlaylists.length} overflow playlist(s) created for tracks beyond the 500-track limit.`;
    }
  } else if (numPlaylists > 1) {
    description = `Split into ${numPlaylists} playlists (500 tracks each).`;
  } else {
    description = `"${playlists[0]?.title || newPlaylistTitle}" has been created with ${totalTracksCreated} tracks (duplicates removed).`;
  }

  const announcement =
    mergeMode === "existing"
      ? `Merged: ${addedCount ?? totalTracksCreated} tracks added.`
      : `Merged: ${numPlaylists} playlist${numPlaylists === 1 ? "" : "s"} created with ${totalTracksCreated} tracks.`;

  const nothingAdded =
    mergeMode === "existing" && addedCount === 0 && overflowPlaylists.length === 0;

  return {
    id: Date.now(),
    status: deleteErrors.length > 0 ? "partial" : nothingAdded ? "empty" : "success",
    title,
    description,
    announcement,
    deletedCount: deletedIds.length,
    deleteErrors,
  };
}

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
  const [deleteAfterMerge, setDeleteAfterMerge] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [outcome, setOutcome] = useState<MergeOutcome | null>(null);
  const [mergeError, setMergeError] = useState<{ id: number; text: string } | null>(null);

  const selectedIds = useMemo(
    () => new Set(selectedPlaylists.map((p) => Number(p.id))),
    [selectedPlaylists],
  );

  const removeSource = (playlist: Playlist) => {
    const idNum = Number(playlist.id);
    setSelectedPlaylists((prev) => prev.filter((p) => Number(p.id) !== idNum));
  };

  // The target is not selectable as a source, and a source is not offered as
  // the target. The reason is shown on the row and read as part of its name.
  const sourceDisabled = useMemo(
    () =>
      targetPlaylist && mergeMode === "existing"
        ? new Map([[Number(targetPlaylist.id), "merge target"]])
        : undefined,
    [targetPlaylist, mergeMode],
  );
  const targetDisabled = useMemo(
    () => new Map(selectedPlaylists.map((p) => [Number(p.id), "selected to merge"] as const)),
    [selectedPlaylists],
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
    setOutcome(null);
    setIsProcessing(true);
    // One POST does the whole merge, so there is no per-playlist count to
    // drive a ProgressBar. Announce the start; the result panel speaks the end.
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
        const data: MergeResponse = await response.json();
        await invalidatePlaylistCaches(queryClient, targetPlaylist?.id ?? null);
        setOutcome(buildOutcome(data, mergeMode, newPlaylistTitle, targetPlaylist?.title));
        // Ready for the next merge. Sources may have just been deleted, so the
        // old selection must not survive into it.
        setSelectedPlaylists([]);
        setNewPlaylistTitle("");
        setTargetPlaylist(null);
        setDeleteAfterMerge(false);
      } else {
        const errorBody = await response.json().catch(() => null);
        // Show the reason first: it must not wait on a cold list refetch.
        setMergeError({
          id: Date.now(),
          text: errorMessageFromBody(errorBody, "Failed to merge playlists. Please try again."),
        });
        if (response.status === 409 && errorBody?.code === "PLAYLIST_NOT_FOUND") {
          // A playlist we were still offering is gone from SoundCloud. Nothing
          // was written, so drop it from the selection (and the target slot)
          // and refetch the list so it stops being offered.
          const missingId = Number(errorBody.playlistId);
          if (Number.isFinite(missingId)) {
            setSelectedPlaylists((prev) => prev.filter((p) => Number(p.id) !== missingId));
            setTargetPlaylist((prev) => (prev && Number(prev.id) === missingId ? null : prev));
          }
          void invalidatePlaylistCaches(queryClient);
        }
      }
    } catch (error) {
      console.error("Error merging playlists:", error);
      setMergeError({ id: Date.now(), text: "An error occurred. Please try again." });
    } finally {
      setIsProcessing(false);
    }
  };

  const totalTracks = useMemo(
    () => selectedPlaylists.reduce((sum, playlist) => sum + (playlist.track_count || 0), 0),
    [selectedPlaylists],
  );

  return (
    <PageContainer kind="workbench">
      <PageHeader
        title="Combine Playlists"
        description="Select playlists to merge. Duplicates will be automatically removed."
      />

      <div className="space-y-6">
        {mergeError ? (
          <ResultPanel
            key={mergeError.id}
            status="error"
            title="Couldn't merge playlists"
            description={mergeError.text}
            announcement={mergeError.text}
            onDismiss={() => setMergeError(null)}
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
          >
            {outcome.deletedCount > 0 || outcome.deleteErrors.length > 0 ? (
              <>
                {outcome.deletedCount > 0 && (
                  <p className="font-medium text-success-text">
                    <Trash2 aria-hidden="true" className="mr-1 inline h-4 w-4" />
                    {outcome.deletedCount} source playlist{outcome.deletedCount > 1 ? "s" : ""} deleted
                  </p>
                )}
                {outcome.deleteErrors.length > 0 && (
                  <div>
                    <p className="mb-1 font-medium text-destructive-text">
                      <AlertTriangle aria-hidden="true" className="mr-1 inline h-4 w-4" />
                      {outcome.deleteErrors.length} playlist{outcome.deleteErrors.length > 1 ? "s" : ""} could not be deleted
                    </p>
                    <ul className="space-y-0.5 text-xs text-destructive-text">
                      {outcome.deleteErrors.map((e) => (
                        <li key={e.id}>ID {e.id}: {e.error}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : null}
          </ResultPanel>
        ) : null}

        <ToolLayout
          main={
            <Panel title="Your Playlists">
              <PlaylistPicker
                playlists={userPlaylists}
                mode="multi"
                selectedIds={selectedIds}
                onChange={(next) => {
                  setSelectedPlaylists(next.map((p) => ({ ...p, id: Number(p.id) })));
                  // A playlist cannot be both a source and the target.
                  if (targetPlaylist && next.some((p) => Number(p.id) === Number(targetPlaylist.id))) {
                    setTargetPlaylist(null);
                  }
                }}
                disabledReasons={sourceDisabled}
                searchLabel="Search your playlists"
              />
            </Panel>
          }
          aside={
            <Panel title="Merge Settings">
              <div className="space-y-4">
                {/* Selected Playlists */}
                <div>
                  <SectionHeading as="h3" className="mb-2">
                    Selected ({selectedPlaylists.length})
                  </SectionHeading>
                  {selectedPlaylists.length === 0 ? (
                    <p className="rounded-lg border-2 border-dashed border-border py-4 text-center text-sm text-muted-foreground">
                      Select at least 2 playlists
                    </p>
                  ) : (
                    // eslint-disable-next-line jsx-a11y/no-redundant-roles -- Tailwind preflight strips list semantics in WebKit
                    <ul role="list" className="max-h-64 space-y-2 overflow-y-auto">
                      {selectedPlaylists.map((playlist) => (
                        <li
                          key={playlist.id}
                          className="flex min-w-0 items-center gap-2 rounded-lg bg-secondary/20 p-2"
                        >
                          <img
                            src={playlist.artwork_url || playlist.coverUrl || "/brand/icon-192.png"}
                            alt=""
                            width={28}
                            height={28}
                            loading="lazy"
                            decoding="async"
                            className="h-7 w-7 shrink-0 rounded object-cover"
                          />
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                            {playlist.title}
                          </span>
                          <IconButton
                            size="sm"
                            label={`Remove ${playlist.title}`}
                            onClick={() => removeSource(playlist)}
                          >
                            <X className="h-4 w-4" />
                          </IconButton>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Total Tracks */}
                <div className="rounded-lg bg-secondary/20 p-4">
                  <div className="text-sm text-muted-foreground">Total Tracks</div>
                  <div className="text-2xl font-bold text-foreground">{totalTracks}</div>
                  {totalTracks > 500 && (
                    <p className="mt-1 text-xs text-primary-text">
                      Will be split into multiple playlists (500 max each)
                    </p>
                  )}
                </div>

                <SegmentedControl
                  label="Merge into"
                  value={mergeMode}
                  options={MERGE_MODES}
                  onChange={setMergeMode}
                />

                {mergeMode === "new" && (
                  <Field label="New Playlist Name">
                    {(field) => (
                      <Input
                        {...field}
                        type="text"
                        value={newPlaylistTitle}
                        onChange={(e) => setNewPlaylistTitle(e.target.value)}
                        placeholder="Enter playlist name..."
                        className="h-11"
                      />
                    )}
                  </Field>
                )}

                {mergeMode === "existing" && (
                  <PlaylistChooser
                    label="Target Playlist"
                    playlists={userPlaylists}
                    value={targetPlaylist}
                    onChange={setTargetPlaylist}
                    disabledReasons={targetDisabled}
                    placeholder="Choose a target playlist…"
                    unavailableText="No available targets (deselect a source first)"
                  />
                )}

                {mergeMode === "existing" && (
                  <label className="touch-44 group flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={deleteAfterMerge}
                      onChange={(e) => setDeleteAfterMerge(e.target.checked)}
                      className="h-6 w-6 shrink-0 cursor-pointer accent-primary"
                    />
                    <span className="text-sm text-muted-foreground transition group-hover:text-foreground">
                      Delete source playlists after merge
                    </span>
                  </label>
                )}
              </div>

              <ActionBar layout="stretch">
                <Button onClick={handleMergeClick} disabled={!canMerge || isProcessing} size="lg">
                  {isProcessing ? (
                    <>
                      <LoadingSpinner size="sm" className="text-white" />
                      {/* The spinner is decoration; this is what says the merge
                          is running, so it has to be in a live region. */}
                      <span role="status">Merging…</span>
                    </>
                  ) : (
                    <>
                      <Combine aria-hidden="true" className="h-5 w-5" />
                      Merge Playlists
                    </>
                  )}
                </Button>
              </ActionBar>
            </Panel>
          }
        />
      </div>

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
    </PageContainer>
  );
}
