import type { Metadata } from "next";

// The Chrome extension's post-connect landing page. It has nothing for search
// and inherited the root's `index, follow`; robots.txt no longer disallows
// /extension/, so this tag is what keeps it out of the index.
export const metadata: Metadata = {
  title: "Chrome extension connected · Track Toolkit",
  robots: {
    index: false,
    follow: false,
  },
};

export default function ExtensionConnectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
