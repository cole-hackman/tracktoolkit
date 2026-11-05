import { PageContainer, Skeleton, Card } from "@/components/ui";
import { Search } from "lucide-react";

/**
 * A route skeleton is decoration. Without a `role="status"` around it a screen
 * reader lands on a page of empty boxes with nothing to explain them — and,
 * because `loading.tsx` replaces the route's own tree, no heading either. One
 * status region says "loading" once; everything inside it is `aria-hidden`.
 */
export default function DashboardLoading() {
  return (
    <PageContainer kind="hub">
      <div role="status" aria-label="Loading">
        <span className="sr-only">Loading the dashboard…</span>

        <div aria-hidden="true">
          <div className="flex items-start justify-between gap-4 mb-5">
            <div className="min-w-0">
              <Skeleton className="h-8 w-48 mb-2" />
              <Skeleton className="h-4 w-72" />
            </div>
            <Skeleton className="w-10 h-10 rounded-full" />
          </div>

          <Card className="p-3 sm:p-4 mb-5">
            <div className="flex flex-col sm:flex-row gap-2.5">
              <div className="flex-1 relative">
                <Skeleton className="h-9 w-full rounded-lg" />
              </div>
              <Skeleton className="h-9 w-24 rounded-lg" />
            </div>
          </Card>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {Array.from({ length: 4 }).map((_, index) => (
              <Card key={index} className="p-3 sm:p-4 text-center">
                <Skeleton className="w-8 h-8 rounded-lg mx-auto mb-2" />
                <Skeleton className="h-6 w-16 mx-auto mb-1" />
                <Skeleton className="h-3 w-12 mx-auto" />
              </Card>
            ))}
          </div>

          <div className="mb-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Skeleton className="h-9 w-full rounded-lg" />
            </div>
          </div>

          <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            All Tools
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            {Array.from({ length: 4 }).map((_, index) => (
              <Card key={index} className="p-4 sm:p-5">
                <div className="w-10 h-10 rounded-xl bg-secondary mb-3" />
                <Skeleton className="h-5 w-32 mb-2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5 mt-1" />
              </Card>
            ))}
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
