"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SupportLink } from "@/components/SupportLink";

export default function AboutPage() {
  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen bg-background text-foreground focus:outline-none">
      <div className="max-w-4xl mx-auto px-6 py-10 md:py-16">
        <article className="rounded-xl border border-border bg-surface p-8 shadow-elevation-1 md:p-12 dark:glass-card">
          <div className="mb-6">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition hover:text-primary-text"
            >
              <ArrowLeft className="h-4 w-4" />
              Home
            </Link>
          </div>

          <h1 className="text-3xl md:text-4xl font-bold mb-6 text-foreground">
            About Track Toolkit
          </h1>

          <div className="space-y-6 text-muted-foreground leading-relaxed">
            <p className="text-lg">
              Track Toolkit is a powerful web application designed to enhance your
              SoundCloud experience with advanced playlist management tools.
              Created by music lovers, for music lovers, we understand the
              frustration of managing large music libraries and the limitations
              of native SoundCloud features.
            </p>
            <p className="text-sm text-muted-foreground">
              Formerly SoundCloud Toolkit — same product, new name. See the{" "}
              <Link
                href="/faq/#rebrand"
                className="font-medium text-foreground underline underline-offset-2 transition hover:text-primary-text"
              >
                rebrand FAQ
              </Link>{" "}
              for why it changed.
            </p>

            <section>
              <h2 className="text-2xl font-bold mb-4 text-foreground">
                Our Mission
              </h2>
              <p>
                Our mission is to empower SoundCloud users with
                professional-grade tools that make organizing, merging, and
                managing playlists effortless. We believe that managing your
                music library shouldn&apos;t be a chore—it should be intuitive,
                powerful, and enjoyable.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-bold mb-4 text-foreground">
                What We Offer
              </h2>

              <h3 className="text-lg font-semibold mb-2 text-foreground">
                Playlist Tools
              </h3>
              <ul className="list-disc list-inside space-y-2 ml-4 mb-4">
                <li>
                  <strong className="text-foreground">Combine Playlists:</strong>{" "}
                  Merge multiple playlists into one unified collection with
                  automatic duplicate detection
                </li>
                <li>
                  <strong className="text-foreground">Playlist Modifier:</strong>{" "}
                  Reorder, remove, and reorganize tracks with advanced sorting.
                  Includes download &amp; buy-link indicators for quick filtering
                </li>
                <li>
                  <strong className="text-foreground">Playlist Health Check:</strong>{" "}
                  Scan your playlists for blocked, geo-restricted, or unavailable
                  tracks and optionally remove them
                </li>
                <li>
                  <strong className="text-foreground">Activity → Playlist:</strong>{" "}
                  Save tracks from your SoundCloud activity feed directly into a
                  new or existing playlist
                </li>
              </ul>

              <h3 className="text-lg font-semibold mb-2 text-foreground">
                Likes &amp; Following
              </h3>
              <ul className="list-disc list-inside space-y-2 ml-4 mb-4">
                <li>
                  <strong className="text-foreground">Likes → Playlist:</strong>{" "}
                  Transform your liked tracks into organized, shareable playlists
                </li>
                <li>
                  <strong className="text-foreground">Like Manager:</strong>{" "}
                  Browse, search, sort, and bulk-unlike your liked tracks
                </li>
                <li>
                  <strong className="text-foreground">Following Manager:</strong>{" "}
                  Browse, search, sort, and bulk-unfollow the users you follow
                </li>
              </ul>

              <h3 className="text-lg font-semibold mb-2 text-foreground">
                Link Tools
              </h3>
              <ul className="list-disc list-inside space-y-2 ml-4">
                <li>
                  <strong className="text-foreground">Link Resolver:</strong>{" "}
                  Extract detailed metadata from any SoundCloud URL, or paste
                  up to 50 at once and see them all in one table
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-bold mb-4 text-foreground">
                Security &amp; Privacy
              </h2>
              <p>
                Your security and privacy are our top priorities. Track Toolkit
                uses official SoundCloud OAuth authentication, which means we
                never see or store your password. All access tokens are
                encrypted at rest using AES-256-GCM encryption. We only request
                the minimum permissions needed to manage your playlists, and you
                can revoke access at any time through your SoundCloud settings.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-bold mb-4 text-foreground">
                Free to Use
              </h2>
              <p>
                Track Toolkit is completely free to use. We&apos;re committed to
                providing powerful tools without charging our users. Our goal is
                to improve the SoundCloud experience for everyone, regardless of
                their subscription status.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-bold mb-4 text-foreground">
                Technical Details
              </h2>
              <p>
                Built with modern web technologies including React, TypeScript,
                and Node.js, Track Toolkit is designed for performance, security,
                and reliability. We use industry best practices for
                authentication and data encryption to keep your information
                safe.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-bold mb-4 text-foreground">
                Limitations
              </h2>
              <p>
                SoundCloud has a limit of 500 tracks per playlist. When merging
                playlists or creating new ones, we automatically cap results at
                this limit and remove duplicates to ensure your playlists are
                valid. This is a SoundCloud platform limitation, not a
                limitation of our tools.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-bold mb-4 text-foreground">
                Contact
              </h2>
              <p>
                Questions, bug reports, or feature requests —{" "}
                <SupportLink subject="Track Toolkit support">
                  email us
                </SupportLink>
                . See the{" "}
                <Link
                  href="/faq"
                  className="font-medium text-foreground underline underline-offset-2 transition hover:text-primary-text"
                >
                  FAQ
                </Link>{" "}
                for quick answers first.
              </p>
            </section>

            <div className="pt-6 border-t border-border">
              <p className="text-sm text-muted-foreground">
                <strong className="text-foreground">Note:</strong> Track Toolkit is
                not affiliated with, endorsed by, or connected to SoundCloud.
                This is an independent tool created to enhance the SoundCloud
                user experience.
              </p>
            </div>
          </div>
        </article>
      </div>
    </main>
  );
}
