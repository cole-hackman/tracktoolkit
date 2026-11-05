import { PageContainer, PageHeader, Panel, Skeleton, ToolLayout } from "@/components/ui";

/**
 * One `role="status"` around the skeleton, everything inside it `aria-hidden`.
 * See the note in `dashboard/loading.tsx`. Mirrors the page's ToolLayout so
 * nothing shifts when the list arrives.
 */
export default function CombineLoading() {
  return (
    <PageContainer kind="workbench">
      <PageHeader
        title="Combine Playlists"
        description="Select playlists to merge. Duplicates will be automatically removed."
      />

      <div role="status" aria-label="Loading">
        <span className="sr-only">Loading your playlists…</span>

        <div aria-hidden="true">
          <ToolLayout
            main={
              <Panel>
                <p className="mb-4 text-lg font-semibold text-foreground">Your Playlists</p>
                <div className="space-y-2">
                  <Skeleton className="h-11 w-full rounded-md" />
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 w-full rounded-xl" />
                  ))}
                </div>
              </Panel>
            }
            aside={
              <Panel>
                <p className="mb-4 text-lg font-semibold text-foreground">Merge Settings</p>
                <div className="space-y-4">
                  <Skeleton className="h-12 w-full rounded-lg" />
                  <Skeleton className="h-20 w-full rounded-lg" />
                  <Skeleton className="h-11 w-full rounded-lg" />
                  <Skeleton className="h-11 w-full rounded-lg" />
                </div>
                <Skeleton className="mt-6 h-12 w-full rounded-xl" />
              </Panel>
            }
          />
        </div>
      </div>
    </PageContainer>
  );
}
