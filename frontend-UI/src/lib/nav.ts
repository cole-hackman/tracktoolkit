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
  Accessibility,
  Activity,
  ArrowRightLeft,
  ClipboardCheck,
  Combine,
  Copy,
  Download,
  Ellipsis,
  FileText,
  FileUp,
  Gauge,
  Heart,
  HelpCircle,
  LayoutDashboard,
  Link as LinkIcon,
  ListChecks,
  ListMusic,
  ListOrdered,
  ListPlus,
  MessageSquare,
  Music,
  Repeat,
  ScrollText,
  Search,
  Shield,
  Shuffle,
  Sparkles,
  Stethoscope,
  ThumbsUp,
  UserCog,
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

/** The rail's "Info" list, and the last section of the mobile More sheet. */
export const INFO_LINKS: NavLink[] = [
  { href: "/about", label: "About", icon: FileText },
  { href: "/faq", label: "FAQ", icon: HelpCircle },
  { href: "/feedback", label: "Send feedback", icon: MessageSquare },
  { href: "/account", label: "Account", icon: UserCog },
  { href: "/privacy", label: "Privacy", icon: Shield },
  { href: "/terms", label: "Terms", icon: ScrollText },
  { href: "/accessibility", label: "Accessibility", icon: Accessibility },
];

/**
 * The admin console link. Only rendered for accounts on ADMIN_IDS (the server
 * reports `isAdmin` on /api/auth/me). The page itself gates again and
 * `adminAuth` is the real boundary, so this is a shortcut, not a guard.
 */
export const ADMIN_LINK: NavLink = { href: "/admin", label: "Admin console", icon: Gauge };

/** `INFO_LINKS` plus the admin console for an admin. */
export function infoLinks(isAdmin: boolean | undefined): NavLink[] {
  return isAdmin ? [...INFO_LINKS, ADMIN_LINK] : INFO_LINKS;
}

/**
 * `/dashboard/` is how the static export addresses the route and `NAV` writes
 * it `/dashboard`, so an exact match is not enough on its own.
 */
export function isActivePath(pathname: string | null, href: string): boolean {
  return pathname === href || !!pathname?.startsWith(href + "/");
}

/* ── Mobile tab bar ──
   Five slots over the same tree: two direct links, two groups that open as a
   sheet, and More for everything else. Everything is looked up in `NAV`, so a
   renamed tool cannot drift, and `MORE_GROUPS` is what is left over, so a new
   tool lands in More without anyone having to remember this list. */

function navLink(href: string): NavLink {
  const link = NAV_LINKS.find((candidate) => candidate.href === href);
  if (!link) throw new Error(`No NAV link for ${href}`);
  return link;
}

function navGroup(label: string): NavGroup {
  const group = NAV.filter(isGroup).find((candidate) => candidate.label === label);
  if (!group) throw new Error(`No NAV group called ${label}`);
  return group;
}

export interface MobileTab {
  id: string;
  /** One word: the bar gives each slot about 72px at 360 wide. */
  label: string;
  icon: NavLink["icon"];
  /** A tab that goes somewhere. Without one, the tab opens a sheet. */
  href?: string;
  /** The sheet this tab opens, and the routes that light the tab up. */
  group?: NavGroup;
}

const dashboard = navLink("/dashboard");
const downloads = navLink("/downloads");
const playlists = navGroup("Playlists");
const social = navGroup("Social & Activity");

export const MOBILE_TABS: MobileTab[] = [
  { id: "dashboard", label: dashboard.label, icon: dashboard.icon, href: dashboard.href },
  { id: "playlists", label: "Playlists", icon: ListMusic, group: playlists },
  { id: "social", label: "Social", icon: Users, group: social },
  { id: "downloads", label: downloads.label, icon: downloads.icon, href: downloads.href },
  { id: "more", label: "More", icon: Ellipsis },
];

/** Tools with no tab of their own, in `NAV` order. */
export const MORE_GROUPS: NavGroup[] = [
  {
    label: "Library",
    items: NAV.filter(
      (entry): entry is NavLink =>
        !isGroup(entry) && entry !== dashboard && entry !== downloads,
    ),
  },
  ...NAV.filter(isGroup).filter((group) => group !== playlists && group !== social),
];

/**
 * Tools and Info links whose name matches every word typed, across the whole
 * tree. A tool's group counts as part of its name, so "social" finds that
 * group, and arrows are ignored, so "likes playlist" finds "Likes → Playlist".
 */
export function filterNavLinks(query: string, isAdmin?: boolean): NavLink[] {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return [];

  const candidates = [
    ...NAV.flatMap((entry) =>
      isGroup(entry)
        ? entry.items.map((link) => ({ link, name: `${link.label} ${entry.label}` }))
        : [{ link: entry, name: entry.label }],
    ),
    ...infoLinks(isAdmin).map((link) => ({ link, name: link.label })),
  ];

  return candidates
    .filter(({ name }) => {
      const lower = name.toLowerCase();
      return terms.every((term) => lower.includes(term));
    })
    .map(({ link }) => link);
}

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
