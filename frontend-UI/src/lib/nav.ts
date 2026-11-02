/**
 * The sidebar navigation tree — the single source of truth for "what tools
 * exist and what are they called".
 *
 * This list used to live inside `AppShell.tsx`. It moved here because more
 * than the sidebar needs it: the feedback form resolves a `?from=` pathname
 * to a human tool name, and importing the shell component just to read an
 * array would drag the whole sidebar (and its auth/theme context hooks) into
 * any page that asked. `AppShell` imports `NAV` back from here, so there is
 * still exactly one list.
 *
 * Keep it a plain `.ts` module: icons are referenced as components, never
 * rendered here, so nothing in this file needs JSX.
 */

import type { ComponentType } from "react";
import {
  Activity,
  ArrowRightLeft,
  ClipboardCheck,
  Combine,
  Copy,
  Download,
  FileUp,
  Heart,
  LayoutDashboard,
  Link as LinkIcon,
  ListChecks,
  ListMusic,
  ListOrdered,
  ListPlus,
  Music,
  Repeat,
  Search,
  Shuffle,
  Sparkles,
  Stethoscope,
  ThumbsUp,
  Users,
} from "lucide-react";

export interface NavLink {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

export interface NavGroup {
  label: string;
  items: NavLink[];
}

export type NavEntry = NavLink | NavGroup;

export function isGroup(entry: NavEntry): entry is NavGroup {
  return "items" in entry;
}

export const NAV: NavEntry[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/downloads", label: "Downloads", icon: Download },
  { href: "/export", label: "Export", icon: FileUp },
  { href: "/library-audit", label: "Library Audit", icon: ClipboardCheck },
  {
    label: "Playlists",
    items: [
      { href: "/combine", label: "Combine Playlists", icon: Combine },
      { href: "/playlist-modifier", label: "Playlist Modifier", icon: Shuffle },
      { href: "/playlist-cloner", label: "Playlist Cloner", icon: Copy },
      { href: "/playlist-compare", label: "Playlist Compare", icon: ArrowRightLeft },
      { href: "/playlist-health-check", label: "Health Check", icon: Stethoscope },
      { href: "/playlist-keyword-search", label: "Keyword Search", icon: Search },
      { href: "/set-to-playlist", label: "Set → Playlist", icon: ListOrdered },
    ],
  },
  {
    label: "Social & Activity",
    items: [
      { href: "/likes-to-playlist", label: "Likes → Playlist", icon: Heart },
      { href: "/playlist-to-likes", label: "Playlist → Likes", icon: ListPlus },
      { href: "/like-manager", label: "Like Manager", icon: ThumbsUp },
      { href: "/following-manager", label: "Following Manager", icon: Users },
      { href: "/following-library", label: "Following Library", icon: ListMusic },
      { href: "/repost-manager", label: "Repost Manager", icon: Repeat },
      { href: "/activity-to-playlist", label: "Activity → Playlist", icon: Activity },
      { href: "/growth", label: "Grow Your Network", icon: Sparkles },
    ],
  },
  {
    label: "Discovery",
    items: [
      { href: "/genre-search", label: "Genre Search", icon: Music },
    ],
  },
  {
    label: "Links",
    items: [
      { href: "/link-resolver", label: "Link Resolver", icon: LinkIcon },
      { href: "/batch-link-resolver", label: "Batch Resolver", icon: ListChecks },
    ],
  },
];

/**
 * `NAV` flattened to its leaves, in sidebar order. What a picker wants when
 * the grouping is presentation rather than meaning.
 */
export const NAV_LINKS: NavLink[] = NAV.flatMap((entry) =>
  isGroup(entry) ? entry.items : [entry],
);

/**
 * The human name for a pathname, or `null` when it is not one of our tools.
 *
 * Longest match wins, so `/export/likes` resolves to "Export" via its parent
 * rather than being missed, and a nested route can never be claimed by a
 * shorter unrelated prefix (`/like-manager` is not a child of `/like`).
 */
export function toolLabelForPath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;

  // Trailing slash is how the static export addresses every route; the NAV
  // hrefs are written without one.
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  let best: NavLink | null = null;
  for (const link of NAV_LINKS) {
    if (path === link.href || path.startsWith(link.href + "/")) {
      if (!best || link.href.length > best.href.length) best = link;
    }
  }
  return best ? best.label : null;
}
