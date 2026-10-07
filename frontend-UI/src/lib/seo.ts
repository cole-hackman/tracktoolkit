import type { Metadata } from "next";

export const SITE_ORIGIN = "https://tracktoolkit.com";

export const SHARE_IMAGE = {
  url: "/brand/og-image.png",
  width: 1200,
  height: 630,
  alt: "Track Toolkit - Smarter SoundCloud Playlist Management",
};

/**
 * Metadata for one public, indexable page: its title and description, a
 * canonical, and Open Graph / Twitter tags that describe that page.
 *
 * Next replaces a parent's `openGraph` and `twitter` objects rather than
 * merging them, so each page restates the shared parts (site name, image)
 * here. Without this every page inherited the root layout's share card, so a
 * link to /faq/ unfurled as the homepage with `og:url` pointing at `/`.
 *
 * @param path - the route's canonical path, with its trailing slash ("/faq/")
 */
export function pageMetadata({
  path,
  title,
  description,
}: {
  path: string;
  title: string;
  description: string;
}): Metadata {
  const url = `${SITE_ORIGIN}${path}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName: "Track Toolkit",
      url,
      title,
      description,
      images: [SHARE_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [SHARE_IMAGE.url],
    },
  };
}
