"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Heart } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui";
import { ExportBackLink } from "@/components/export/ExportBackLink";
import { TrackExportCard } from "@/components/export/TrackExportCard";
import { likesToTracks, normalizeLikesCollection } from "@/lib/export";
import { likesQueryOptions } from "@/lib/queries";

export default function ExportLikesPage() {
  const queryClient = useQueryClient();
  const loadLikes = async () => {
    const data = await queryClient.ensureQueryData(likesQueryOptions());
    return likesToTracks(
      normalizeLikesCollection((data.collection || []) as never),
    );
  };

  return (
    <PageContainer kind="form">
      <ExportBackLink />
      <PageHeader
        title="Export Likes"
        description="Download all liked tracks. Use Title - Artist for Lexicon, rekordbox, or LLM matching."
      />
      <TrackExportCard
        embedded
        icon={<Heart className="h-6 w-6" />}
        title="Export Likes"
        subtitle=""
        description=""
        fetchLabel="Load liked tracks"
        filenamePrefix="soundcloud-likes"
        emptyTitle="No liked tracks to export yet"
        emptyDescription="Like some tracks on SoundCloud, then come back to export them."
        emptyLinkHref="/like-manager"
        emptyLinkLabel="Open Like Manager"
        loadTracks={loadLikes}
      />
    </PageContainer>
  );
}
