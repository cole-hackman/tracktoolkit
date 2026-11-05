"use client";

import { Suspense } from "react";
import { PageContainer, PageHeader } from "@/components/ui";
import { FeedbackForm } from "./FeedbackForm";

/**
 * `FeedbackForm` reads `?type=` and `?from=` with `useSearchParams`, which
 * Next requires to sit under a `Suspense` boundary — in a static export the
 * query string is only known in the browser, so the prerender has to be able
 * to bail out to a fallback.
 */
export default function FeedbackPage() {
  return (
    <PageContainer kind="form">
      <PageHeader
        title="Send feedback"
        description="Bug reports and feature requests go straight to the person who builds Track Toolkit."
      />
      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading the feedback form…</p>
        }
      >
        <FeedbackForm />
      </Suspense>
    </PageContainer>
  );
}
