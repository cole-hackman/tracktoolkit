"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ListMusic } from "lucide-react";
import { PageContainer, PageHeader, Panel } from "@/components/ui";
import { ExportBackLink } from "@/components/export/ExportBackLink";
import { TrackExportCard } from "@/components/export/TrackExportCard";
import { PlaylistPicker } from "@/components/playlists/PlaylistPicker";
import type { ExportTrack } from "@/lib/export";
import {
  playlistDetailQueryOptions,
  usePlaylistsQuery,
} from "@/lib/queries";
import { asArray } from "@/lib/api-shape";

interface PlaylistSummary {
  id: number;
  title: string;
  track_count: number;
  artwork_url?: string | null;
  coverUrl?: string | null;
}

export default function ExportPlaylistsPage() {
  const queryClient = useQueryClient();
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistSummary | null>(null);
  const playlistsQuery = usePlaylistsQuery();
  const playlists = asArray<PlaylistSummary>(playlistsQuery.data?.collection);
  const loading = playlistsQuery.isLoading;
  const loadError = playlistsQuery.isError;

  const loadPlaylistTracks = async (): Promise<ExportTrack[]> => {
    if (!selectedPlaylist) throw new Error("Select a playlist first");
    const data = await queryClient.ensureQueryData(playlistDetailQueryOptions(selectedPlaylist.id));
    return asArray<ExportTrack>(data.tracks);
  };

  return (
    <PageContainer kind="form">
      <ExportBackLink />
      <PageHeader
        title="Export Playlist"
        description="Select a playlist, then download its tracks in your preferred format."
      />

      <div className="space-y-6">
        <Panel title="Select a playlist to export">
          <PlaylistPicker
            playlists={playlists}
            mode="single"
            selectedIds={selectedPlaylist ? [selectedPlaylist.id] : []}
            onChange={(next) => setSelectedPlaylist(next[0] ?? null)}
            loading={loading}
            loadError={loadError}
            onRetry={() => playlistsQuery.refetch()}
            emptyDescription="Create some playlists on SoundCloud first."
          />
        </Panel>

        {selectedPlaylist ? (
          <TrackExportCard
            // Another playlist starts from a clean card, as picking again did.
            key={selectedPlaylist.id}
            embedded
            icon={<ListMusic className="h-6 w-6" />}
            title="Export Playlist"
            subtitle=""
            description=""
            fetchLabel="Load playlist tracks"
            filenamePrefix="soundcloud-playlist"
            emptyTitle="This playlist has no tracks"
            emptyDescription="Choose another playlist or add tracks on SoundCloud."
            loadTracks={loadPlaylistTracks}
          />
        ) : null}
      </div>
    </PageContainer>
  );
}
