"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type {
  AdminStats,
  ArtistFilter,
  BetaSurveySummary,
  CatalogArtistsResponse,
  CatalogDailyPoint,
  CatalogFilter,
  CatalogPlaylistsResponse,
  CatalogSummary,
  CatalogTracksResponse,
  DownloadEventsResponse,
  DownloadsEventFilter,
  DownloadsSummary,
  DownloadsTrackFilter,
  DownloadTracksResponse,
  FeedbackFilter,
  FeedbackItem,
  FeedbackItemsResponse,
  FeedbackSummary,
  PlaylistFilter,
  ReResolveResult,
  DailyPoint,
  OperationRow,
  OperationsFilter,
  Period,
  RebrandSummary,
  RebrandVote,
  TrackOperation,
} from "./types";

/** How often a live view re-polls. Polling pauses while the tab is hidden. */
export const POLL_MS = 30_000;

export class AdminHttpError extends Error {
  status: number;
  constructor(status: number, message?: string) {
    super(message ?? `Request failed (${status})`);
    this.name = "AdminHttpError";
    this.status = status;
  }
}

async function adminGet<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) {
    let message: string | undefined;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") message = body.error;
    } catch {
      /* body was not JSON */
    }
    throw new AdminHttpError(res.status, message);
  }
  return res.json() as Promise<T>;
}

const live = {
  refetchInterval: POLL_MS,
  refetchIntervalInBackground: false,
  placeholderData: keepPreviousData,
  staleTime: 10_000,
} as const;

export const adminKeys = {
  stats: (period: Period) => ["admin", "stats", period] as const,
  daily: (period: Period) => ["admin", "daily", period] as const,
  operations: (period: Period, filter: OperationsFilter) =>
    ["admin", "operations", period, filter] as const,
  catalogSummary: (period: Period) => ["admin", "catalog", "summary", period] as const,
  catalogTracks: (period: Period, filter: CatalogFilter) =>
    ["admin", "catalog", "tracks", period, filter] as const,
  trackOperations: (trackId: string) => ["admin", "catalog", "track-ops", trackId] as const,
  catalogDaily: (period: Period) => ["admin", "catalog", "daily", period] as const,
  catalogPlaylists: (period: Period, filter: PlaylistFilter) =>
    ["admin", "catalog", "playlists", period, filter] as const,
  catalogArtists: (period: Period, filter: ArtistFilter) =>
    ["admin", "catalog", "artists", period, filter] as const,
  rebrandSummary: () => ["admin", "rebrand", "summary"] as const,
  rebrandVotes: () => ["admin", "rebrand", "votes"] as const,
  downloadsSummary: (period: Period) => ["admin", "downloads", "summary", period] as const,
  downloadsTracks: (period: Period, filter: DownloadsTrackFilter) =>
    ["admin", "downloads", "tracks", period, filter] as const,
  downloadsEvents: (period: Period, filter: DownloadsEventFilter) =>
    ["admin", "downloads", "events", period, filter] as const,
  betaSurvey: () => ["admin", "feedback", "summary"] as const,
  // "feedback-items", not "feedback": `betaSurvey` above already owns the
  // ["admin","feedback",…] prefix, and invalidating one must not sweep the
  // other — they are different tables.
  feedbackItems: (filter: FeedbackFilter) => ["admin", "feedback-items", "list", filter] as const,
  feedbackSummary: () => ["admin", "feedback-items", "summary"] as const,
};

export function useAdminStats(period: Period, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.stats(period),
    queryFn: () => adminGet<AdminStats>(`/api/admin/stats?period=${period}`),
    enabled,
    ...live,
  });
}

export function useAdminDaily(period: Period, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.daily(period),
    queryFn: async () => {
      const data = await adminGet<{ daily: DailyPoint[] }>(`/api/admin/daily?period=${period}`);
      return data.daily ?? [];
    },
    enabled,
    ...live,
  });
}

export function useAdminOperations(period: Period, filter: OperationsFilter, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.operations(period, filter),
    queryFn: async () => {
      const params = new URLSearchParams({ period, limit: String(filter.limit) });
      if (filter.status !== "all") params.set("status", filter.status);
      if (filter.action) params.set("action", filter.action);
      if (filter.search.trim()) params.set("search", filter.search.trim());
      const data = await adminGet<{ operations: OperationRow[] }>(
        `/api/admin/operations?${params.toString()}`,
      );
      return data.operations ?? [];
    },
    enabled,
    ...live,
  });
}

export function useCatalogSummary(period: Period, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.catalogSummary(period),
    queryFn: () => adminGet<CatalogSummary>(`/api/admin/catalog/summary?period=${period}`),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export const CATALOG_PAGE_SIZE = 25;

export function useCatalogTracks(period: Period, filter: CatalogFilter, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.catalogTracks(period, filter),
    queryFn: () => {
      const params = catalogTracksParams(period, filter);
      params.set("page", String(filter.page));
      params.set("pageSize", String(CATALOG_PAGE_SIZE));
      return adminGet<CatalogTracksResponse>(`/api/admin/catalog/tracks?${params.toString()}`);
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

/** Query string for the track listing; shared by the table and its CSV link. */
export function catalogTracksParams(period: Period, filter: CatalogFilter): URLSearchParams {
  const params = new URLSearchParams({ period, sort: filter.sort, order: filter.order });
  if (filter.genre) params.set("genre", filter.genre);
  if (filter.artist) params.set("artist", filter.artist);
  if (filter.access) params.set("access", filter.access);
  if (filter.resolveStatus) params.set("resolveStatus", filter.resolveStatus);
  if (filter.action) params.set("action", filter.action);
  return params;
}

export function catalogCsvUrl(kind: "tracks" | "playlists" | "artists", params: URLSearchParams): string {
  const p = new URLSearchParams(params);
  p.set("format", "csv");
  return `${API_BASE}/api/admin/catalog/${kind}?${p.toString()}`;
}

export function useCatalogDaily(period: Period, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.catalogDaily(period),
    queryFn: async () => {
      const data = await adminGet<{ daily: CatalogDailyPoint[] }>(`/api/admin/catalog/daily?period=${period}`);
      return data.daily ?? [];
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function catalogPlaylistsParams(period: Period, filter: PlaylistFilter): URLSearchParams {
  const params = new URLSearchParams({ period, sort: filter.sort, order: filter.order });
  if (filter.q) params.set("q", filter.q);
  return params;
}

export function useCatalogPlaylists(period: Period, filter: PlaylistFilter, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.catalogPlaylists(period, filter),
    queryFn: () => {
      const params = catalogPlaylistsParams(period, filter);
      params.set("page", String(filter.page));
      params.set("pageSize", String(CATALOG_PAGE_SIZE));
      return adminGet<CatalogPlaylistsResponse>(`/api/admin/catalog/playlists?${params.toString()}`);
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function catalogArtistsParams(period: Period, filter: ArtistFilter): URLSearchParams {
  const params = new URLSearchParams({ period, sort: filter.sort, order: filter.order });
  if (filter.q) params.set("q", filter.q);
  return params;
}

export function useCatalogArtists(period: Period, filter: ArtistFilter, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.catalogArtists(period, filter),
    queryFn: () => {
      const params = catalogArtistsParams(period, filter);
      params.set("page", String(filter.page));
      params.set("pageSize", String(CATALOG_PAGE_SIZE));
      return adminGet<CatalogArtistsResponse>(`/api/admin/catalog/artists?${params.toString()}`);
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/**
 * The console's one write. On success every catalog query is invalidated so
 * the health list, summary and tables reflect the refreshed rows.
 */
export function useReResolve() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (trackIds: Array<number | string>) => {
      const res = await apiFetch("/api/admin/catalog/re-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackIds: trackIds.map(Number) }),
      });
      if (!res.ok) {
        let message: string | undefined;
        try {
          const body = await res.json();
          if (typeof body?.error === "string") message = body.error;
        } catch {
          /* not JSON */
        }
        throw new AdminHttpError(res.status, message ?? (res.status === 429 ? "Rate limited — try again later." : undefined));
      }
      return (await res.json()) as ReResolveResult;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "catalog"] });
    },
  });
}

export function useTrackOperations(trackId: string | null) {
  return useQuery({
    queryKey: adminKeys.trackOperations(trackId ?? ""),
    queryFn: async () => {
      const data = await adminGet<{ operations: TrackOperation[] }>(
        `/api/admin/catalog/tracks/${encodeURIComponent(trackId ?? "")}/operations`,
      );
      return data.operations ?? [];
    },
    enabled: trackId != null,
    staleTime: 5 * 60_000,
  });
}

// The vote is closed, so these are read once and never polled. They are
// always all-time: a period filter on a finished vote only produces an empty,
// misleading "no votes in this window".
export function useRebrandSummary(enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.rebrandSummary(),
    queryFn: () => adminGet<RebrandSummary>("/api/admin/rebrand/summary?period=all"),
    enabled,
    staleTime: Infinity,
  });
}

export function useRebrandVotes(enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.rebrandVotes(),
    queryFn: async () => {
      const data = await adminGet<{ responses: RebrandVote[] }>(
        "/api/admin/rebrand?period=all&limit=200",
      );
      return data.responses ?? [];
    },
    enabled,
    staleTime: Infinity,
  });
}

export function useBetaSurveySummary(enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.betaSurvey(),
    queryFn: () => adminGet<BetaSurveySummary>("/api/admin/feedback/summary?period=all"),
    enabled,
    staleTime: Infinity,
  });
}

/* ── Feedback inbox ───────────────────────────────────────────────────────
   The live in-app form. It is an inbox, not a time series, so nothing here
   takes a `period`: an untriaged report from six weeks ago is still
   untriaged, and a window filter would hide exactly the rows that matter. */

export const FEEDBACK_PAGE_SIZE = 25;

/** Query string shared by the list and its CSV link, so both filter alike. */
export function feedbackParams(filter: Pick<FeedbackFilter, "status" | "type">): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.type) params.set("type", filter.type);
  return params;
}

export function feedbackCsvUrl(filter: Pick<FeedbackFilter, "status" | "type">): string {
  const params = feedbackParams(filter);
  const qs = params.toString();
  return `${API_BASE}/api/admin/feedback-items.csv${qs ? `?${qs}` : ""}`;
}

export function useFeedbackItems(filter: FeedbackFilter, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.feedbackItems(filter),
    queryFn: () => {
      const params = feedbackParams(filter);
      params.set("page", String(filter.page));
      params.set("pageSize", String(FEEDBACK_PAGE_SIZE));
      return adminGet<FeedbackItemsResponse>(`/api/admin/feedback-items?${params.toString()}`);
    },
    enabled,
    ...live,
  });
}

export function useFeedbackSummary(enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.feedbackSummary(),
    queryFn: () => adminGet<FeedbackSummary>("/api/admin/feedback-items/summary"),
    enabled,
    ...live,
  });
}

/**
 * Triage one row. `status` and `adminNote` are the only writable columns —
 * nothing a user wrote can be edited from the console.
 *
 * On success both the list and the header counts are invalidated: a status
 * change moves the row between tabs, so the tallies are stale the moment the
 * write lands.
 */
export function useFeedbackPatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string; status?: string; adminNote?: string | null }) => {
      const res = await apiFetch(`/api/admin/feedback-items/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let message: string | undefined;
        try {
          const payload = await res.json();
          if (typeof payload?.error === "string") message = payload.error;
        } catch {
          /* not JSON */
        }
        throw new AdminHttpError(res.status, message ?? (res.status === 404 ? "That report is no longer there." : undefined));
      }
      return (await res.json()) as Pick<FeedbackItem, "id" | "status" | "adminNote">;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "feedback-items"] });
    },
  });
}

/* ── Downloads usage ─────────────────────────────────────────────────── */

export const DOWNLOADS_PAGE_SIZE = 25;

export function useDownloadsSummary(period: Period, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.downloadsSummary(period),
    queryFn: () => adminGet<DownloadsSummary>(`/api/admin/downloads/summary?period=${period}`),
    enabled,
    ...live,
  });
}

/** Query string for the track listing; shared by the table and its CSV link. */
export function downloadsTracksParams(period: Period, filter: DownloadsTrackFilter): URLSearchParams {
  const params = new URLSearchParams({ period, sort: filter.sort, order: filter.order });
  if (filter.channel) params.set("channel", filter.channel);
  if (filter.q.trim()) params.set("q", filter.q.trim());
  return params;
}

export function downloadsTracksCsvUrl(period: Period, filter: DownloadsTrackFilter): string {
  const params = downloadsTracksParams(period, filter);
  params.set("format", "csv");
  return `${API_BASE}/api/admin/downloads/tracks?${params.toString()}`;
}

export function useDownloadsTracks(period: Period, filter: DownloadsTrackFilter, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.downloadsTracks(period, filter),
    queryFn: () => {
      const params = downloadsTracksParams(period, filter);
      params.set("page", String(filter.page));
      params.set("pageSize", String(DOWNLOADS_PAGE_SIZE));
      return adminGet<DownloadTracksResponse>(`/api/admin/downloads/tracks?${params.toString()}`);
    },
    enabled,
    ...live,
  });
}

export function useDownloadsEvents(period: Period, filter: DownloadsEventFilter, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.downloadsEvents(period, filter),
    queryFn: () => {
      const params = new URLSearchParams({ period, page: String(filter.page), pageSize: String(DOWNLOADS_PAGE_SIZE) });
      if (filter.channel) params.set("channel", filter.channel);
      if (filter.userId) params.set("userId", filter.userId);
      return adminGet<DownloadEventsResponse>(`/api/admin/downloads/events?${params.toString()}`);
    },
    enabled,
    ...live,
  });
}
