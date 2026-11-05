"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Download, ListPlus } from "lucide-react";
import { apiFetch, errorMessageFromBody } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import {
  ActionBar,
  Button,
  Card,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  Panel,
  ResultPanel,
  useAnnounce,
} from "@/components/ui";
import { PlaylistChooser } from "@/components/playlists/PlaylistChooser";
import { invalidatePlaylistCaches, usePlaylistsQuery } from "@/lib/queries";
import { asArray } from "@/lib/api-shape";

interface Playlist {
  id: number;
  title: string;
  track_count: number;
}

interface Track {
  id: number;
  title?: string;
  user?: { username?: string };
}

interface CompareResult {
  summary: {
    playlistA: { id: number; title: string; trackCount: number };
    playlistB: { id: number; title: string; trackCount: number };
    overlapCount: number;
    uniqueToACount: number;
    uniqueToBCount: number;
    overlapPercent: number;
  };
  overlap: Track[];
  uniqueToA: Track[];
  uniqueToB: Track[];
}

export default function PlaylistComparePage() {
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const [playlistAId, setPlaylistAId] = useState<number | "">("");
  const [playlistBId, setPlaylistBId] = useState<number | "">("");
  const [comparing, setComparing] = useState(false);
  const [result, setResult] = useState<CompareResult | null>(null);
  // A failed compare is the run's outcome; `id` remounts the panel per run.
  const [failure, setFailure] = useState<{ id: number; text: string } | null>(null);
  const playlistsQuery = usePlaylistsQuery();
  const playlists = asArray<Playlist>(playlistsQuery.data?.collection);
  const loading = playlistsQuery.isLoading;
  const playlistA = playlists.find((p) => Number(p.id) === Number(playlistAId)) ?? null;
  const playlistB = playlists.find((p) => Number(p.id) === Number(playlistBId)) ?? null;

  const compare = async () => {
    if (!playlistAId || !playlistBId || playlistAId === playlistBId) return;
    setComparing(true);
    setFailure(null);
    setResult(null);
    try {
      const response = await apiFetch("/api/playlists/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playlistAId, playlistBId }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        // Show the reason first: it must not wait on a cold list refetch.
        setFailure({ id: Date.now(), text: errorMessageFromBody(data, "Could not compare playlists.") });
        if (response.status === 404 && data?.code === "PLAYLIST_NOT_FOUND") {
          // One of the two selections is gone from SoundCloud. Clear it and
          // refetch the list so it stops being offered.
          const missingId = Number(data.playlistId);
          // Updaters, so a pick made since the request is not wiped.
          setPlaylistAId((prev) => (Number(prev) === missingId ? "" : prev));
          setPlaylistBId((prev) => (Number(prev) === missingId ? "" : prev));
          void invalidatePlaylistCaches(queryClient);
        }
        return;
      }
      if (!data) throw new Error("Could not compare playlists.");
      setResult(data);
      announce(
        `${data.summary.overlapCount} shared, ${data.summary.uniqueToACount} only in A, ${data.summary.uniqueToBCount} only in B.`,
      );
    } catch (error) {
      setFailure({
        id: Date.now(),
        text: error instanceof Error ? error.message : "Could not compare playlists.",
      });
    } finally {
      setComparing(false);
    }
  };

  const canCompare =
    !comparing && !!playlistAId && !!playlistBId && playlistAId !== playlistBId;

  const exportCsv = () => {
    if (!result) return;
    const rows = [
      ["section", "track_id", "title", "artist"],
      ...result.overlap.map((track) => ["overlap", track.id, track.title || "", track.user?.username || ""]),
      ...result.uniqueToA.map((track) => ["unique_to_a", track.id, track.title || "", track.user?.username || ""]),
      ...result.uniqueToB.map((track) => ["unique_to_b", track.id, track.title || "", track.user?.username || ""]),
    ];
    downloadCsv("playlist-comparison.csv", rows);
  };

  return (
    <PageContainer kind="list">
      <PageHeader
        title="Playlist Compare"
        description="Compare two playlists to find overlap and tracks missing from either side."
      />

      <div className="space-y-6">
        {failure ? (
          <ResultPanel
            key={failure.id}
            status="error"
            title="Couldn’t compare the playlists"
            description={failure.text}
            announcement={failure.text}
            onDismiss={() => setFailure(null)}
          />
        ) : null}

        <Panel>
          {playlistsQuery.isError ? (
            <InlineAlert variant="error" className="mb-4">
              Could not load playlists. Try refreshing.
            </InlineAlert>
          ) : null}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <PlaylistChooser
              label="Playlist A"
              dialogTitle="Choose Playlist A"
              playlists={playlists}
              value={playlistA}
              onChange={(playlist) => setPlaylistAId(Number(playlist.id))}
              loading={loading}
              loadError={playlistsQuery.isError}
              onRetry={() => playlistsQuery.refetch()}
              placeholder="Choose a playlist..."
            />
            <PlaylistChooser
              label="Playlist B"
              dialogTitle="Choose Playlist B"
              playlists={playlists}
              value={playlistB}
              onChange={(playlist) => setPlaylistBId(Number(playlist.id))}
              loading={loading}
              loadError={playlistsQuery.isError}
              onRetry={() => playlistsQuery.refetch()}
              placeholder="Choose a playlist..."
            />
          </div>
          <ActionBar>
            <Button onClick={compare} disabled={!canCompare}>
              {comparing ? (
                <LoadingSpinner size="sm" className="text-white" />
              ) : (
                <ArrowRightLeft aria-hidden="true" className="h-4 w-4" />
              )}
              Compare
            </Button>
            {/* Why the button is off, in text. A disabled control with no
                stated reason is a dead end. */}
            {!loading && !canCompare && !comparing && (
              <p className="text-sm text-muted-foreground">
                {playlistAId && playlistBId && playlistAId === playlistBId
                  ? "Pick two different playlists."
                  : "Pick two different playlists to compare."}
              </p>
            )}
          </ActionBar>
        </Panel>

        {!result ? (
          <Panel>
            <EmptyState
              icon={<ArrowRightLeft className="h-12 w-12" />}
              title="Choose two playlists"
              description="The comparison will show shared tracks and tracks unique to each playlist."
            />
          </Panel>
        ) : (
          <>
            <div className="flex justify-end">
              <Button nowrap variant="outline" onClick={exportCsv}>
                <Download aria-hidden="true" className="h-4 w-4" />
                Export CSV
              </Button>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <Metric label="Overlap" value={`${result.summary.overlapCount}`} detail={`${result.summary.overlapPercent}% of combined tracks`} />
              <Metric label="Only in A" value={`${result.summary.uniqueToACount}`} detail={result.summary.playlistA.title} />
              <Metric label="Only in B" value={`${result.summary.uniqueToBCount}`} detail={result.summary.playlistB.title} />
            </div>

            <TrackSection title={`Only in ${result.summary.playlistA.title}`} tracks={result.uniqueToA} />
            <TrackSection title={`Only in ${result.summary.playlistB.title}`} tracks={result.uniqueToB} />
            <TrackSection title="In both playlists" tracks={result.overlap} />

            <Card className="p-4 text-sm text-muted-foreground">
              <ListPlus aria-hidden="true" className="mr-2 inline h-4 w-4 text-primary" />
              Next step: use Combine Playlists or Playlist Modifier to add missing tracks after reviewing the export.
            </Card>
          </>
        )}
      </div>
    </PageContainer>
  );
}

/**
 * The label comes first in the DOM and the number is lifted above it visually
 * with `flex-col-reverse`. Reading order was "482 / Overlap / 61% of combined
 * tracks" — a number with no idea what it counts until after it has been read.
 */
function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Card className="flex flex-col p-4">
      <div className="flex flex-col-reverse">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-2xl font-bold text-foreground">{value}</div>
      </div>
      <div className="text-xs text-muted-foreground">{detail}</div>
    </Card>
  );
}

function TrackSection({ title, tracks }: { title: string; tracks: Track[] }) {
  return (
    <Panel title={<span className="break-words">{`${title} (${tracks.length})`}</span>}>
      <div className="max-h-[60dvh] divide-y divide-border overflow-y-auto">
        {tracks.length === 0 ? (
          <div className="py-3 text-sm text-muted-foreground">No tracks in this group.</div>
        ) : (
          tracks.map((track) => (
            <div key={track.id} className="min-w-0 py-3">
              <div className="break-words font-medium text-foreground">{track.title || `Track ${track.id}`}</div>
              {track.user?.username && (
                <div className="break-words text-sm text-muted-foreground">{track.user.username}</div>
              )}
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
