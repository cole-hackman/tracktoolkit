"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Download, ListPlus } from "lucide-react";
import { apiFetch, errorMessageFromBody } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import {
  Button,
  Card,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  PageContainer,
  PageHeader,
  SectionHeading,
  Select,
  useAnnounce,
} from "@/components/ui";
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
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const playlistsQuery = usePlaylistsQuery();
  const playlists = asArray<Playlist>(playlistsQuery.data?.collection);
  const loading = playlistsQuery.isLoading;

  useEffect(() => {
    if (playlistsQuery.isError) {
      setNotice({ type: "error", text: "Could not load playlists. Try refreshing." });
    }
  }, [playlistsQuery.isError]);

  const compare = async () => {
    if (!playlistAId || !playlistBId || playlistAId === playlistBId) return;
    setComparing(true);
    setNotice(null);
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
        setNotice({ type: "error", text: errorMessageFromBody(data, "Could not compare playlists.") });
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
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Could not compare playlists." });
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
    <PageContainer maxWidth="wide">
      <PageHeader
        title="Playlist Compare"
        description="Compare two playlists to find overlap and tracks missing from either side."
      />

      {notice && (
        <InlineAlert variant={notice.type} className="mb-6" onDismiss={() => setNotice(null)}>
          {notice.text}
        </InlineAlert>
      )}

      <Card className="mb-6 p-4">
        {loading ? (
          <p role="status" className="flex items-center gap-3 text-sm text-muted-foreground">
            <LoadingSpinner size="sm" />
            Loading your playlists…
          </p>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
              <PlaylistSelect label="Playlist A" value={playlistAId} playlists={playlists} onChange={setPlaylistAId} />
              <PlaylistSelect label="Playlist B" value={playlistBId} playlists={playlists} onChange={setPlaylistBId} />
              <div className="flex items-end">
                <Button onClick={compare} disabled={!canCompare}>
                  {comparing ? (
                    <LoadingSpinner size="sm" className="text-white" />
                  ) : (
                    <ArrowRightLeft aria-hidden="true" className="h-4 w-4" />
                  )}
                  Compare
                </Button>
              </div>
            </div>
            {/* Why the button is off, in text. A disabled control with no
                stated reason is a dead end. */}
            {!canCompare && !comparing && (
              <p className="mt-2 text-sm text-muted-foreground">
                {playlistAId && playlistBId && playlistAId === playlistBId
                  ? "Pick two different playlists."
                  : "Pick two different playlists to compare."}
              </p>
            )}
          </>
        )}
      </Card>

      {!result ? (
        <Card className="p-8">
          <EmptyState
            icon={<ArrowRightLeft className="h-12 w-12" />}
            title="Choose two playlists"
            description="The comparison will show shared tracks and tracks unique to each playlist."
          />
        </Card>
      ) : (
        <div className="space-y-6">
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
        </div>
      )}
    </PageContainer>
  );
}

function PlaylistSelect({
  label,
  value,
  playlists,
  onChange,
}: {
  label: string;
  value: number | "";
  playlists: Playlist[];
  onChange: (value: number | "") => void;
}) {
  return (
    <Select
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value ? Number(event.target.value) : "")}
    >
      <option value="">Choose a playlist...</option>
      {playlists.map((playlist) => (
        <option key={playlist.id} value={playlist.id}>
          {playlist.title} ({playlist.track_count} tracks)
        </option>
      ))}
    </Select>
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
    <Card>
      <SectionHeading className="border-b border-border px-4 py-3">
        {title} ({tracks.length})
      </SectionHeading>
      <div className="max-h-[60dvh] divide-y divide-border overflow-y-auto">
        {tracks.length === 0 ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">No tracks in this group.</div>
        ) : (
          tracks.map((track) => (
            <div key={track.id} className="px-4 py-3">
              <div className="font-medium text-foreground">{track.title || `Track ${track.id}`}</div>
              {track.user?.username && <div className="text-sm text-muted-foreground">{track.user.username}</div>}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
