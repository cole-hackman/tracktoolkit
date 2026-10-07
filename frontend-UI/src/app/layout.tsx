import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { RebrandBanner } from "@/components/RebrandBanner";

const display = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
});

const sans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export const metadata: Metadata = {
  title: "Track Toolkit – Organize, Merge & Clean SoundCloud Playlists",
  description:
    "Track Toolkit helps SoundCloud power users organize, merge, and clean playlists. Remove duplicates, manage tracks, and build better playlists faster.",
  keywords: [
    "Track Toolkit",
    "SoundCloud",
    "playlist",
    "merge playlists",
    "organize playlists",
    "SoundCloud playlist tool",
    "merge SoundCloud playlists",
    "organize SoundCloud playlists",
    "playlist manager",
    "duplicate remover",
    "music organization",
  ],
  authors: [{ name: "Track Toolkit" }],
  creator: "Track Toolkit",
  publisher: "Track Toolkit",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    // No `url` here: inherited, it told every page without its own share card
    // that it was the homepage. Public pages set theirs via pageMetadata().
    siteName: "Track Toolkit",
    title: "Track Toolkit – Organize, Merge & Clean SoundCloud Playlists",
    description:
      "Track Toolkit helps SoundCloud power users organize, merge, and clean playlists. Remove duplicates, manage tracks, and build better playlists faster.",
    images: [
      {
        url: "/brand/og-image.png",
        width: 1200,
        height: 630,
        alt: "Track Toolkit - Smarter SoundCloud Playlist Management",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Track Toolkit – Organize, Merge & Clean SoundCloud Playlists",
    description:
      "Track Toolkit helps SoundCloud power users organize, merge, and clean playlists. Remove duplicates, manage tracks, and build better playlists faster.",
    images: ["/brand/og-image.png"],
  },
  // Brand assets live under /brand and are generated from
  // docs/brand/tools/mark-spec.cjs. The legacy "SC Toolkit Icon.png" and
  // "sc toolkit transparent .png" files still exist, now carrying the same
  // artwork, only because the Chrome extension and cached pages point at them.
  icons: {
    icon: [
      { url: "/brand/mark.svg", type: "image/svg+xml" },
      { url: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    // Opaque on the paper background: iOS composites a transparent touch icon
    // over black, which matches nothing else in the identity.
    apple: "/brand/apple-touch-icon.png",
  },
  manifest: "/manifest.json",
  metadataBase: new URL("https://tracktoolkit.com"),
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable}`}>
      <head>
        <meta name="theme-color" content="#FF5500" />
      </head>
      <body className="antialiased font-sans">
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <Providers>
          <RebrandBanner />
          {children}
        </Providers>
      </body>
    </html>
  );
}
