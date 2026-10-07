import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

// The landing page is "use client", so its canonical and share card live here. It is a
// route group rather than the root layout because a canonical set at the root
// would be inherited by every segment that does not set its own — the noindex
// app routes and the 404 included — pointing all of them at the homepage.
export const metadata: Metadata = pageMetadata({
  path: "/",
  title: "Track Toolkit – Organize, Merge & Clean SoundCloud Playlists",
  description:
    "Track Toolkit helps SoundCloud power users organize, merge, and clean playlists. Remove duplicates, manage tracks, and build better playlists faster.",
});

export default function HomeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
