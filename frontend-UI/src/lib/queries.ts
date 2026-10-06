"use client";

import { useQuery, type QueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api";
import { progressiveKeys } from "@/lib/progressive";

type QueryOverrides<T> = Omit<
  UseQueryOptions<T, Error, T, readonly unknown[]>,
  "queryKey" | "queryFn"
>;

type CollectionResponse<T> = {
  collection: T[];
  total?: number;
  total_results?: number;
  next_href?: string | null;
};

export interface PlaylistSummary {
  id: number;
  title: string;
  track_count: number;
  artwork_url?: string;
  coverUrl?: string;
}

export interface PlaylistDetail {
  id: number;
  title: string;
  tracks: Array<{ id: number } & Record<string, unknown>>;
  /** SoundCloud's own count. Can exceed `tracks.length` (deleted/private entries). */
  track_count?: number;
}

export interface DashboardSummary {
  followers_count: number;
  followings_count: number;
  likes_count: number;
  playlist_count: number;
}

/**
 * `allAccess` also returns blocked tracks (`?access=all`). Pages that write a
 * playlist's list back use it so what the user sees is what the server will
 * compare their write against. It is a separate cache entry; the key still
 * starts with ["playlist-detail", id], so invalidatePlaylistCaches reaches it.
 */
export interface PlaylistDetailOptions {
  allAccess?: boolean;
}

export const queryKeys = {
  me: () => ["me"] as const,
  dashboardSummary: () => ["dashboard-summary"] as const,
  playlists: () => ["playlists"] as const,
  playlistDetail: (playlistId: number, options?: PlaylistDetailOptions) =>
    options?.allAccess
      ? (["playlist-detail", playlistId, "all"] as const)
      : (["playlist-detail", playlistId] as const),
  likes: () => ["likes"] as const,
  likesPaged: (cursor: string | null, limit = 50) => ["likes-paged", { cursor, limit }] as const,
  followings: () => ["followings"] as const,
  followers: () => ["followers"] as const,
  reposts: () => ["reposts"] as const,
  recentlyPlayed: () => ["recently-played"] as const,
  activities: (limit = 200) => ["activities", limit] as const,
  growthHistory: () => ["growth", "history"] as const,
  growthStats: () => ["growth", "stats"] as const,
  growthLimits: () => ["growth", "limits"] as const,
  growthAnalytics: () => ["growth", "analytics"] as const,
};

const timings = {
  me: { staleTime: 2 * 60 * 1000, gcTime: 10 * 60 * 1000 },
  dashboardSummary: { staleTime: 60 * 1000, gcTime: 5 * 60 * 1000 },
  playlists: { staleTime: 5 * 60 * 1000, gcTime: 15 * 60 * 1000 },
  playlistDetail: { staleTime: 2 * 60 * 1000, gcTime: 10 * 60 * 1000 },
  likes: { staleTime: 60 * 1000, gcTime: 10 * 60 * 1000 },
  followings: { staleTime: 5 * 60 * 1000, gcTime: 15 * 60 * 1000 },
  followers: { staleTime: 5 * 60 * 1000, gcTime: 15 * 60 * 1000 },
  reposts: { staleTime: 60 * 1000, gcTime: 10 * 60 * 1000 },
  recentlyPlayed: { staleTime: 60 * 1000, gcTime: 10 * 60 * 1000 },
  activities: { staleTime: 60 * 1000, gcTime: 10 * 60 * 1000 },
  // Growth data changes as the user runs discovery/engagement actions, but
  // not on every render — short staleTimes keep tab-switches snappy without
  // going stale for long.
  growthHistory: { staleTime: 30 * 1000, gcTime: 5 * 60 * 1000 },
  growthStats: { staleTime: 30 * 1000, gcTime: 5 * 60 * 1000 },
  growthLimits: { staleTime: 15 * 1000, gcTime: 5 * 60 * 1000 },
  growthAnalytics: { staleTime: 60 * 1000, gcTime: 10 * 60 * 1000 },
};

export function meQueryOptions() {
  return {
    queryKey: queryKeys.me(),
    queryFn: () => apiFetchJson<Record<string, unknown>>("/api/me"),
    ...timings.me,
  };
}

export function dashboardSummaryQueryOptions() {
  return {
    queryKey: queryKeys.dashboardSummary(),
    queryFn: () => apiFetchJson<DashboardSummary>("/api/dashboard/summary"),
    ...timings.dashboardSummary,
  };
}

export function playlistsQueryOptions() {
  return {
    queryKey: queryKeys.playlists(),
    queryFn: () => apiFetchJson<CollectionResponse<PlaylistSummary>>("/api/playlists"),
    ...timings.playlists,
  };
}

export function playlistDetailQueryOptions(playlistId: number, detail?: PlaylistDetailOptions) {
  const suffix = detail?.allAccess ? "?access=all" : "";
  return {
    queryKey: queryKeys.playlistDetail(playlistId, detail),
    queryFn: () => apiFetchJson<PlaylistDetail>(`/api/playlists/${playlistId}${suffix}`),
    enabled: playlistId > 0,
    ...timings.playlistDetail,
  };
}

export function likesQueryOptions() {
  return {
    queryKey: queryKeys.likes(),
    queryFn: () => apiFetchJson<CollectionResponse<Record<string, unknown>>>("/api/likes"),
    ...timings.likes,
  };
}

export function likesPagedQueryOptions(cursor: string | null, limit = 50) {
  const search = cursor
    ? `/api/likes/paged?next=${encodeURIComponent(cursor)}`
    : `/api/likes/paged?limit=${limit}`;

  return {
    queryKey: queryKeys.likesPaged(cursor, limit),
    queryFn: () => apiFetchJson<CollectionResponse<Record<string, unknown>>>(search),
    ...timings.likes,
  };
}

export function followingsQueryOptions() {
  return {
    queryKey: queryKeys.followings(),
    queryFn: () => apiFetchJson<CollectionResponse<Record<string, unknown>>>("/api/followings"),
    ...timings.followings,
  };
}

export function followersQueryOptions() {
  return {
    queryKey: queryKeys.followers(),
    queryFn: () => apiFetchJson<CollectionResponse<Record<string, unknown>>>("/api/followers"),
    ...timings.followers,
  };
}

export function repostsQueryOptions() {
  return {
    queryKey: queryKeys.reposts(),
    queryFn: () => apiFetchJson<CollectionResponse<Record<string, unknown>>>("/api/reposts"),
    ...timings.reposts,
  };
}

export function activitiesQueryOptions(limit = 200) {
  return {
    queryKey: queryKeys.activities(limit),
    queryFn: () => apiFetchJson<CollectionResponse<Record<string, unknown>>>(`/api/activities?limit=${limit}`),
    ...timings.activities,
  };
}

export function recentlyPlayedQueryOptions() {
  return {
    queryKey: queryKeys.recentlyPlayed(),
    queryFn: () => apiFetchJson<CollectionResponse<Record<string, unknown>>>("/api/recently-played"),
    ...timings.recentlyPlayed,
  };
}

export interface GrowthHistoryResponse {
  actions: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
}

export function growthHistoryQueryOptions() {
  return {
    queryKey: queryKeys.growthHistory(),
    queryFn: () => apiFetchJson<GrowthHistoryResponse>("/api/growth/history"),
    ...timings.growthHistory,
  };
}

export interface GrowthStatsResponse {
  totalFollowed: number;
  totalLiked: number;
  followedBackRate: number;
  activeFollows: number;
  reversedFollows: number;
  uncheckedFollows: number;
}

export function growthStatsQueryOptions() {
  return {
    queryKey: queryKeys.growthStats(),
    queryFn: () => apiFetchJson<GrowthStatsResponse>("/api/growth/stats"),
    ...timings.growthStats,
  };
}

export interface GrowthLimitsResponse {
  dailyCap: number;
  used24h: number;
  remaining: number;
  cooldownRemainingMs: number;
}

export function growthLimitsQueryOptions() {
  return {
    queryKey: queryKeys.growthLimits(),
    queryFn: () => apiFetchJson<GrowthLimitsResponse>("/api/growth/limits"),
    ...timings.growthLimits,
  };
}

export interface GrowthAnalyticsResponse {
  perSeed: Array<Record<string, unknown>>;
  followBackCurve: Array<Record<string, unknown>>;
  totalFollows: number;
}

export function growthAnalyticsQueryOptions() {
  return {
    queryKey: queryKeys.growthAnalytics(),
    queryFn: () => apiFetchJson<GrowthAnalyticsResponse>("/api/growth/analytics"),
    ...timings.growthAnalytics,
  };
}

export function useMeQuery(options?: QueryOverrides<Record<string, unknown>>) {
  return useQuery({ ...meQueryOptions(), ...options });
}

export function useDashboardSummaryQuery(options?: QueryOverrides<DashboardSummary>) {
  return useQuery({ ...dashboardSummaryQueryOptions(), ...options });
}

export function usePlaylistsQuery(options?: QueryOverrides<CollectionResponse<PlaylistSummary>>) {
  return useQuery({ ...playlistsQueryOptions(), ...options });
}

export function usePlaylistDetailQuery(
  playlistId: number,
  options?: QueryOverrides<PlaylistDetail> & PlaylistDetailOptions,
) {
  const { allAccess, ...overrides } = options ?? {};
  return useQuery({ ...playlistDetailQueryOptions(playlistId, { allAccess }), ...overrides });
}

export function useLikesQuery(options?: QueryOverrides<CollectionResponse<Record<string, unknown>>>) {
  return useQuery({ ...likesQueryOptions(), ...options });
}

export function useFollowingsQuery(options?: QueryOverrides<CollectionResponse<Record<string, unknown>>>) {
  return useQuery({ ...followingsQueryOptions(), ...options });
}

export function useFollowersQuery(options?: QueryOverrides<CollectionResponse<Record<string, unknown>>>) {
  return useQuery({ ...followersQueryOptions(), ...options });
}

export function useRepostsQuery(options?: QueryOverrides<CollectionResponse<Record<string, unknown>>>) {
  return useQuery({ ...repostsQueryOptions(), ...options });
}

export function useActivitiesQuery(
  limit = 200,
  options?: QueryOverrides<CollectionResponse<Record<string, unknown>>>,
) {
  return useQuery({ ...activitiesQueryOptions(limit), ...options });
}

export function useRecentlyPlayedQuery(options?: QueryOverrides<CollectionResponse<Record<string, unknown>>>) {
  return useQuery({ ...recentlyPlayedQueryOptions(), ...options });
}

export function useGrowthHistoryQuery(options?: QueryOverrides<GrowthHistoryResponse>) {
  return useQuery({ ...growthHistoryQueryOptions(), ...options });
}

export function useGrowthStatsQuery(options?: QueryOverrides<GrowthStatsResponse>) {
  return useQuery({ ...growthStatsQueryOptions(), ...options });
}

export function useGrowthLimitsQuery(options?: QueryOverrides<GrowthLimitsResponse>) {
  return useQuery({ ...growthLimitsQueryOptions(), ...options });
}

export function useGrowthAnalyticsQuery(options?: QueryOverrides<GrowthAnalyticsResponse>) {
  return useQuery({ ...growthAnalyticsQueryOptions(), ...options });
}

function getTrackId(item: Record<string, unknown>) {
  const nestedTrack = item.track as { id?: number } | undefined;
  const directId = typeof item.id === "number" ? item.id : undefined;
  return nestedTrack?.id ?? directId;
}

/**
 * Progressive (useInfiniteQuery) caches store `{ pages: Page[], pageParams }`
 * instead of a single collection. Patch every already-fetched page in place
 * so a mutation's removed rows disappear immediately without invalidating the
 * query — invalidating would refetch the whole paginated crawl from page one
 * and flicker rows back in while it revalidates, which defeats the point of
 * loading progressively. Pages the hook hasn't fetched yet are unaffected and
 * will simply reflect the mutation naturally once they do load, since the
 * mutation already happened server-side.
 */
type ProgressivePage = { collection?: Array<Record<string, unknown>>; total?: number };
type ProgressiveCache = { pages: ProgressivePage[]; pageParams: unknown[] };

function patchProgressiveCollection(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  isRemoved: (item: Record<string, unknown>) => boolean,
  removedCount: number,
) {
  queryClient.setQueryData<ProgressiveCache>(queryKey, (old) => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map((page) => ({
        ...page,
        collection: (page.collection || []).filter((item) => !isRemoved(item)),
        total: typeof page.total === "number" ? Math.max(0, page.total - removedCount) : page.total,
      })),
    };
  });
}

export function removeTracksFromLikesCache(queryClient: QueryClient, removedIds: Set<number>) {
  queryClient.setQueryData<CollectionResponse<Record<string, unknown>>>(queryKeys.likes(), (current) => {
    if (!current) return current;
    const collection = (current.collection || []).filter((item) => {
      const trackId = getTrackId(item);
      return trackId == null || !removedIds.has(trackId);
    });
    return {
      ...current,
      collection,
      total_results:
        typeof current.total_results === "number" ? Math.max(0, current.total_results - removedIds.size) : current.total_results,
      total:
        typeof current.total === "number" ? Math.max(0, current.total - removedIds.size) : current.total,
    };
  });

  const pagedEntries = queryClient.getQueriesData<CollectionResponse<Record<string, unknown>>>({
    queryKey: ["likes-paged"],
  });

  pagedEntries.forEach(([key, value]) => {
    if (!value) return;
    queryClient.setQueryData<CollectionResponse<Record<string, unknown>>>(key, {
      ...value,
      collection: (value.collection || []).filter((item) => {
        const trackId = getTrackId(item);
        return trackId == null || !removedIds.has(trackId);
      }),
    });
  });

  patchProgressiveCollection(
    queryClient,
    progressiveKeys.likes(),
    (item) => {
      const trackId = getTrackId(item);
      return trackId != null && removedIds.has(trackId);
    },
    removedIds.size,
  );
}

export function removeUsersFromFollowingsCache(queryClient: QueryClient, removedIds: Set<number>) {
  queryClient.setQueryData<CollectionResponse<Record<string, unknown>>>(queryKeys.followings(), (current) => {
    if (!current) return current;
    const collection = (current.collection || []).filter((item) => !removedIds.has(Number(item.id)));
    return {
      ...current,
      collection,
      total:
        typeof current.total === "number" ? Math.max(0, current.total - removedIds.size) : current.total,
    };
  });

  patchProgressiveCollection(
    queryClient,
    progressiveKeys.followings(),
    (item) => removedIds.has(Number(item.id)),
    removedIds.size,
  );
}

export function removeItemsFromRepostsCache(queryClient: QueryClient, removedIds: Set<number>) {
  queryClient.setQueryData<CollectionResponse<Record<string, unknown>>>(queryKeys.reposts(), (current) => {
    if (!current) return current;
    const collection = (current.collection || []).filter((item) => !removedIds.has(Number(item.id)));
    return {
      ...current,
      collection,
      total_results:
        typeof current.total_results === "number" ? Math.max(0, current.total_results - removedIds.size) : current.total_results,
    };
  });

  patchProgressiveCollection(
    queryClient,
    progressiveKeys.reposts(),
    (item) => removedIds.has(Number(item.id)),
    removedIds.size,
  );
}

export async function invalidatePlaylistCaches(queryClient: QueryClient, playlistId?: number | null) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.playlists() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboardSummary() }),
    playlistId
      ? queryClient.invalidateQueries({ queryKey: queryKeys.playlistDetail(playlistId) })
      : queryClient.invalidateQueries({ queryKey: ["playlist-detail"] }),
  ]);
}

export async function invalidateDashboardSummary(queryClient: QueryClient) {
  await queryClient.invalidateQueries({ queryKey: queryKeys.dashboardSummary() });
}
