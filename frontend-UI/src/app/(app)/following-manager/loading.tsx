import { PageContainer, PageHeader, Skeleton, Panel } from "@/components/ui";

/**
 * One `role="status"` around the skeleton, everything inside it `aria-hidden`.
 * See the note in `dashboard/loading.tsx`.
 */
export default function FollowingManagerLoading() {
  return (
    <PageContainer kind="list">
      <PageHeader
        title="Following Manager"
        description="Browse and manage who you follow. Unfollow accounts in bulk."
      />

      <div role="status" aria-label="Loading">
        <span className="sr-only">Loading the accounts you follow…</span>

        <Panel aria-hidden="true">
          {/* Controls */}
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <Skeleton className="h-10 flex-1 min-w-[200px] rounded-lg" />
            <Skeleton className="h-10 w-32 rounded-lg" />
            <div className="flex p-1 rounded-lg">
              <Skeleton className="h-9 w-16" />
              <Skeleton className="h-9 w-32" />
            </div>
            <Skeleton className="h-6 w-20" />
          </div>

          <Skeleton className="h-4 w-32 mb-2" />

          <div className="grid md:grid-cols-2 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-[76px] w-full rounded-xl" />
            ))}
          </div>
        </Panel>
      </div>
    </PageContainer>
  );
}
