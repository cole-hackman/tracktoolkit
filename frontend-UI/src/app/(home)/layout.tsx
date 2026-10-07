import type { Metadata } from "next";

// The landing page is "use client", so its canonical lives here. It is a
// route group rather than the root layout because a canonical set at the root
// would be inherited by every segment that does not set its own — the noindex
// app routes and the 404 included — pointing all of them at the homepage.
export const metadata: Metadata = {
  alternates: {
    canonical: "https://tracktoolkit.com/",
  },
};

export default function HomeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
