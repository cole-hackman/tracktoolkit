import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  path: "/about/",
  title: "About Track Toolkit",
  description:
    "Track Toolkit is an independent web app that helps SoundCloud users merge, organize, and clean up playlists beyond what the official platform offers.",
});

export default function AboutLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
