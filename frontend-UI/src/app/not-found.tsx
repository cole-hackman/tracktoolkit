import type { Metadata } from "next";
import Link from "next/link";
import { SupportLink } from "@/components/SupportLink";

// Next adds its own `noindex` to the 404, but the root layout's
// `index, follow` was emitted beside it — two contradictory robots tags.
// Stating it here replaces the inherited value, leaving one.
export const metadata: Metadata = {
  title: "Page not found · Track Toolkit",
  robots: {
    index: false,
    follow: false,
  },
};

export default function NotFound() {
  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen bg-background text-foreground focus:outline-none">
      <div className="max-w-4xl mx-auto px-6 py-10 md:py-16">
        <article className="rounded-xl border border-border bg-surface p-8 shadow-elevation-1 md:p-12 dark:glass-card">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            404
          </p>

          <h1 className="mt-3 text-3xl md:text-4xl font-bold text-foreground">
            That page isn&apos;t here
          </h1>

          <p className="mt-4 max-w-2xl text-muted-foreground leading-relaxed">
            If you followed a link from soundcloudtoolkit.com, the site moved
            to tracktoolkit.com and a few pages changed address.
          </p>

          <ul className="mt-8 flex flex-wrap gap-3">
            <li>
              <Link
                href="/dashboard"
                className="inline-flex items-center justify-center rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background shadow-elevation-1 transition-all hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                Go to the dashboard
              </Link>
            </li>
            <li>
              <Link
                href="/faq"
                className="inline-flex items-center justify-center rounded-lg border border-border/70 bg-secondary px-4 py-2 text-sm font-semibold text-secondary-foreground shadow-sm transition hover:border-primary/40 hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                Read the FAQ
              </Link>
            </li>
            <li>
              <Link
                href="/"
                className="inline-flex items-center justify-center rounded-lg border border-border/70 bg-secondary px-4 py-2 text-sm font-semibold text-secondary-foreground shadow-sm transition hover:border-primary/40 hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                Home
              </Link>
            </li>
          </ul>

          <p className="mt-8 text-sm text-muted-foreground">
            Still lost?{" "}
            <SupportLink subject="Broken link on tracktoolkit.com">
              Email us
            </SupportLink>
            .
          </p>
        </article>
      </div>
    </main>
  );
}
