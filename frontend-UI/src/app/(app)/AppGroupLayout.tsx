"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { AppLayout } from "@/components/AppLayout";
import { AppShell } from "@/components/AppShell";
import { RebrandAnnouncement } from "@/components/RebrandAnnouncement";
import { apiFetch } from "@/lib/api";
import { markNavigated } from "@/lib/navigation-state";

const TOOL_SLUGS: Record<string, string> = {
  "/dashboard": "dashboard",
  "/combine": "combine",
  "/library-audit": "library-audit",
  "/downloads": "downloads",
  "/rekordbox-gaps": "rekordbox-gaps",
  "/export": "export",
  "/export/likes": "export",
  "/export/playlists": "export",
  "/export/followings": "export",
  "/export/reposts": "export",
  "/likes-to-playlist": "likes",
  "/playlist-modifier": "modifier",
  "/link-resolver": "resolver",
  "/activity-to-playlist": "activity",
  "/like-manager": "like-manager",
  "/following-manager": "following-manager",
  "/following-library": "following-library",
  "/playlist-health-check": "health-check",
  "/playlist-keyword-search": "playlist-keyword-search",
  "/batch-link-resolver": "batch-resolver",
  "/playlist-cloner": "playlist-cloner",
  "/playlist-compare": "playlist-compare",
  "/genre-search": "genre-search",
  "/repost-manager": "repost-manager",
  "/growth": "growth",
  "/recently-played": "recently-played",
};

const LAST_TOOLS_KEY = "sc-toolkit-last-tools";
const MAX_RECENT = 3;

function updateRecentTools(pathname: string) {
  const slug = TOOL_SLUGS[pathname];
  if (!slug) return;
  try {
    const stored = localStorage.getItem(LAST_TOOLS_KEY);
    const prev: string[] = stored ? JSON.parse(stored) : [];
    const next = [slug, ...prev.filter((s) => s !== slug)].slice(0, MAX_RECENT);
    localStorage.setItem(LAST_TOOLS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

function logFeatureOpen(pathname: string) {
  const feature = TOOL_SLUGS[pathname];
  if (!feature) return;

  // This intentionally contains no URL parameters, SoundCloud content, or
  // device data. The server links it only to the signed-in account so the
  // admin can measure distinct feature reach.
  void apiFetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ feature }),
  }).catch(() => undefined);
}

export function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;
    // This layout is the only thing mounted for every route in the group, so
    // it is what notices a navigation that no `PageHeader` sees. Every route
    // — `/dashboard/` included, since Phase 6 — renders one, so the flag is
    // usually set by the header itself; the latch stays because this layout
    // survives the unmount between two routes and a PageHeader does not, and
    // because a future route without a header would silently lose the focus
    // move again.
    markNavigated(pathname);
    updateRecentTools(pathname);
    logFeatureOpen(pathname);
  }, [pathname]);

  return (
    <AppLayout>
      {/* One-time rebrand notice. Mounted here rather than on the dashboard so
          it also greets a returning user who deep-links straight to a tool.
          The dashboard holds "What's new" back until this is acknowledged, so
          the two never stack. */}
      <RebrandAnnouncement />
      <AppShell>{children}</AppShell>
    </AppLayout>
  );
}
