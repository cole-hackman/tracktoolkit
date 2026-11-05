import { PageContainer, PageHeader, Skeleton, Panel } from "@/components/ui";

/**
 * One `role="status"` around the skeleton, everything inside it `aria-hidden`.
 * See the note in `dashboard/loading.tsx`.
 */
export default function LikeManagerLoading() {
  return (
    <PageContainer kind="list">
      <PageHeader
        title="Like Manager"
        description="Browse, search, and manage your liked tracks. Unlike in bulk."
      />

      <div role="status" aria-label="Loading">
        <span className="sr-only">Loading your liked tracks…</span>

        <Panel aria-hidden="true">
          {/* Controls */}
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <Skeleton className="h-10 flex-1 min-w-[200px] rounded-lg" />
            <Skeleton className="h-10 w-32 rounded-lg" />
            <Skeleton className="h-10 w-32 rounded-lg" />
            <Skeleton className="h-10 w-32 rounded-lg" />
            <Skeleton className="h-6 w-20" />
          </div>

          <Skeleton className="h-4 w-32 mb-2" />

          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        </Panel>
      </div>
    </PageContainer>
  );
}
