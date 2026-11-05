import { PageContainer, PageHeader, Panel, Skeleton, ToolLayout } from "@/components/ui";

/**
 * One `role="status"` around the skeleton, everything inside it `aria-hidden`.
 * See the note in `dashboard/loading.tsx`. Mirrors the Discover tab's first
 * step — the tab strip, the budget strip, then the seed list beside the scan
 * settings — so nothing shifts when the page arrives.
 *
 * The tab strip and the wide filler bars are sized in fractions rather than
 * fixed widths: `w-40 + w-40 + w-28` plus padding was 452px of tab strip and
 * `w-96` was a 384px bar, both wider than a 360px phone, so the skeleton
 * scrolled sideways before the page it stands in for had even loaded.
 */
export default function GrowthLoading() {
  return (
    <PageContainer kind="workbench">
      <PageHeader
        title="Grow Your Network"
        description="Discover active SoundCloud users likely to follow you back, engage with their tracks, and reverse campaigns anytime."
      />

      <div role="status" aria-label="Loading">
        <span className="sr-only">Loading your growth tools…</span>

        <div aria-hidden="true" className="space-y-6">
          {/* Tabs Selector — mirrors the real strip: equal-width tabs on a phone,
              intrinsic width from `sm` up, so the skeleton never overflows a
              360px viewport the page itself fits in. */}
          <div className="overflow-x-auto">
            <div className="flex w-full gap-1 rounded-lg border border-border/50 bg-secondary/20 p-1 sm:w-fit">
              <Skeleton className="h-11 flex-1 rounded-md sm:w-40 sm:flex-none" />
              <Skeleton className="h-11 flex-1 rounded-md sm:w-40 sm:flex-none" />
              <Skeleton className="h-11 flex-1 rounded-md sm:w-28 sm:flex-none" />
            </div>
          </div>

          <Skeleton className="h-10 w-full rounded-xl" />

          <ToolLayout
            main={
              <Panel>
                {/* `w-96` (384px) is wider than a 360px viewport: the skeleton,
                    not the page, was what made /growth/ scroll sideways at load. */}
                <Skeleton className="mb-2 h-5 w-full max-w-xs" />
                <Skeleton className="mb-4 h-4 w-full max-w-sm" />
                <Skeleton className="mb-3 h-11 w-full rounded-lg" />
                <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-2">
                  {Array.from({ length: 9 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 rounded-xl" />
                  ))}
                </div>
              </Panel>
            }
            aside={
              <Panel>
                <Skeleton className="mb-4 h-5 w-32" />
                <div className="space-y-4">
                  <Skeleton className="h-11 w-full rounded-lg" />
                  <Skeleton className="h-11 w-full rounded-lg" />
                  <Skeleton className="h-11 w-full rounded-lg" />
                </div>
                <Skeleton className="mt-6 h-11 w-full rounded-xl" />
              </Panel>
            }
          />
        </div>
      </div>
    </PageContainer>
  );
}
