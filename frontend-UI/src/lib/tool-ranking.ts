/**
 * Dashboard order, by how many people use each tool.
 *
 * THE ONE PLACE TO EDIT. The dashboard sorts its four category groups and
 * the tools inside each group from this list; nothing else reads it (the
 * sidebar and the mobile tab bar keep the `nav.ts` order on purpose).
 *
 * Source: docs/internal/ANALYSIS.md §3 — unique users per `operation_logs`
 * action, 2026-03-19 → 2026-08-08, 1,855 users. Ranked by unique users, not
 * rows: the bulk tools log one row per 100-item chunk, so rows overstate them
 * (bulk-unlike is 1,554 rows but 135 people).
 *
 * `users: null` means there is no figure: the tool logs no operation, or it
 * shipped after the export. Those sort after every ranked tool, in the order
 * written here (which is the dashboard's previous order). When new figures
 * arrive, change the numbers and re-sort this array — that is the whole job.
 *
 * Ids are the dashboard's card ids (`FEATURES` in dashboard/page.tsx).
 */
export interface ToolRank {
  id: string;
  /** Unique users in the source window, or null when there is no data. */
  users: number | null;
  /** The `operation_logs.action` the figure comes from. */
  action?: string;
}

export const TOOL_RANKING: readonly ToolRank[] = [
  { id: "combine", users: 820, action: "merge" },
  { id: "likes", users: 717, action: "from-likes" },
  { id: "library-audit", users: 204, action: "library-audit" },
  // Includes what was the Batch Link Resolver (23 users, batch-resolve), now
  // the same page.
  { id: "resolver", users: 202, action: "resolve" },
  { id: "like-manager", users: 135, action: "bulk-unlike" },
  { id: "playlist-cloner", users: 127, action: "clone" },
  { id: "genre-search", users: 108, action: "genre-search" },
  { id: "following-manager", users: 108, action: "bulk-unfollow" },
  { id: "playlist-compare", users: 105, action: "playlist-compare" },
  { id: "modifier", users: 29, action: "playlist-transfer" },
  { id: "playlist-to-likes", users: 26, action: "bulk-like" },
  // followed-likes-to-playlist (24) and followed-playlist-clone (11); the
  // overlap is unknown, so the larger figure is a floor for the tool.
  { id: "following-library", users: 24, action: "followed-likes-to-playlist" },
  { id: "repost-manager", users: 14, action: "bulk-remove-reposts" },
  // No figure yet.
  { id: "downloads", users: null },
  { id: "export", users: null },
  { id: "recently-played", users: null },
  { id: "health-check", users: null },
  { id: "playlist-keyword-search", users: null },
  { id: "set-to-playlist", users: null },
  { id: "activity-to-playlist", users: null },
];

const POSITION = new Map(TOOL_RANKING.map((rank, index) => [rank.id, index]));

/** Position in the ranking; unknown ids sort last, keeping their own order. */
export function toolRankPosition(id: string): number {
  return POSITION.get(id) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Items sorted by rank, then categories sorted by their best-ranked item —
 * the group a person is most likely to want first is the one holding the
 * most-used tool. (Summing a group's users would count one person once per
 * tool they used.)
 */
export function rankByUsage<T extends { id: string; category: string }>(
  items: readonly T[],
  categories: readonly string[],
): { category: string; items: T[] }[] {
  const sorted = [...items].sort((a, b) => toolRankPosition(a.id) - toolRankPosition(b.id));
  return categories
    .map((category) => ({ category, items: sorted.filter((item) => item.category === category) }))
    .sort((a, b) => {
      const best = (group: { items: T[] }) =>
        group.items.length ? toolRankPosition(group.items[0].id) : Number.MAX_SAFE_INTEGER;
      return best(a) - best(b);
    });
}
