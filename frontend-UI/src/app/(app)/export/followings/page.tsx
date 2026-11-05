"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui";
import { ExportBackLink } from "@/components/export/ExportBackLink";
import { ListExportCard } from "@/components/export/ListExportCard";
import { FOLLOWING_FORMATS } from "@/lib/export-config";
import type { ExportFollowing } from "@/lib/export";
import { followingsQueryOptions } from "@/lib/queries";
import { asArray } from "@/lib/api-shape";

export default function ExportFollowingsPage() {
  const queryClient = useQueryClient();
  const loadFollowings = async (): Promise<ExportFollowing[]> => {
    const data = await queryClient.ensureQueryData(followingsQueryOptions());
    return asArray<ExportFollowing>(data.collection);
  };

  return (
    <PageContainer kind="form">
      <ExportBackLink />
      <PageHeader
        title="Export Followings"
        description="Export everyone you follow as a simple list or spreadsheet."
      />
      <ListExportCard
        embedded
        icon={<Users className="h-6 w-6" />}
        title="Export Followings"
        subtitle=""
        description=""
        fetchLabel="Load followings"
        filenamePrefix="soundcloud-followings"
        formats={FOLLOWING_FORMATS}
        emptyTitle="You're not following anyone yet"
        emptyDescription="Follow artists on SoundCloud to export your list here."
        emptyLinkHref="/following-manager"
        emptyLinkLabel="Open Following Manager"
        loadItems={loadFollowings}
      />
    </PageContainer>
  );
}
