/**
 * Shapes returned by server/routes/admin.js. Keep these in step with the
 * route handlers — the console renders exactly these fields and nothing else.
 */

export type Period = "1d" | "7d" | "30d" | "90d" | "month" | "all";

export const PERIODS: ReadonlyArray<{ value: Period; label: string; long: string }> = [
  { value: "1d", label: "24h", long: "last 24 hours" },
  { value: "7d", label: "7d", long: "last 7 days" },
  { value: "30d", label: "30d", long: "last 30 days" },
  { value: "90d", label: "90d", long: "last 90 days" },
  { value: "month", label: "MTD", long: "month to date" },
  { value: "all", label: "All", long: "all time" },
];

export type OpStatus = "success" | "split" | "error" | "partial";
export const OP_STATUSES: ReadonlyArray<OpStatus> = ["success", "split", "error", "partial"];

export interface FeatureUsage {
  key: string;
  name: string;
  count: number;
  avgDurationMs: number;
  errorCount: number;
  errorRate: number;
  color: string;
}

export interface FeatureReach {
  key: string;
  name: string;
  users: number;
  opens: number;
}

export interface ErrorBucket {
  errorCode: string;
  count: number;
}

export interface LatencyRow {
  action: string;
  name: string;
  runs: number;
  p95Ms: number;
  avgMs: number;
  maxMs: number;
  avgScCalls: number | null;
}

export interface AnalyticsWriteHealth {
  failures: number;
  lastWriteAt?: string | null;
  lastFailureAt?: string | null;
  lastFailureMessage?: string | null;
}

export interface AdminStats {
  totalUsers: number;
  newUsers: number;
  tracksProcessed: number;
  operationsCount: number;
  featureUsage: FeatureUsage[];
  featureReach: FeatureReach[];
  errorBreakdown: ErrorBucket[];
  errorRateByAction: FeatureUsage[];
  splitsCount: number;
  avgTracksPerOp: number;
  avgDurationMs: number;
  p95DurationMs: number;
  successRate: number;
  splitRate: number;
  errorRate: number;
  partialRate: number;
  partialCount: number;
  topFeature: FeatureUsage | null;
  readLatency: LatencyRow[];
  activeUsersPeriod: number;
  analyticsWriteHealth: AnalyticsWriteHealth;
}

export interface DailyPoint {
  date: string;
  tracks: number;
  operations: number;
  newUsers: number;
}

export interface OperationUser {
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  soundcloudId: number | null;
}

export interface ClientInfo {
  device?: string;
  browser?: string;
  platform?: string;
  [key: string]: unknown;
}

export interface OperationRow {
  id: string;
  user: OperationUser;
  soundcloudId: number | null;
  action: string;
  actionName: string;
  trackCount: number;
  itemCount: number;
  status: OpStatus | string;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  clientInfo: ClientInfo | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export interface OperationsFilter {
  status: OpStatus | "all";
  action: string;
  search: string;
  limit: 50 | 100;
}

export const DEFAULT_OPS_FILTER: OperationsFilter = {
  status: "all",
  action: "",
  search: "",
  limit: 50,
};

export interface CatalogSummary {
  period: Period;
  totalTracks: number;
  totalArtists: number;
  totalPlaylists: number;
  accessBreakdown: Record<string, number>;
  resolveBreakdown: Record<string, number>;
  genreBreakdown: Array<{ genre: string; count: number }>;
  periodTouchEvents: number;
  periodDistinctTracks: number;
}

export interface CatalogTrack {
  id: number | string;
  title: string | null;
  artistName: string | null;
  artistId: number | string | null;
  genre: string | null;
  genreNormalized: string | null;
  durationMs: number | null;
  access: string | null;
  permalinkUrl: string | null;
  resolveStatus: string;
  resolveAttempts: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  touches: number;
  users: number;
  last_touched: string | null;
}

export interface CatalogTracksResponse {
  tracks: CatalogTrack[];
  total: number;
  page: number;
  pageSize: number;
  sort: string;
  order: "asc" | "desc";
}

export type CatalogSort = "touches" | "users" | "lastTouched" | "title" | "artist" | "firstSeen" | "lastSeen" | "duration";

export interface CatalogFilter {
  genre: string;
  artist: string;
  access: string;
  resolveStatus: string;
  action: string;
  sort: CatalogSort;
  order: "asc" | "desc";
  page: number;
}

export const DEFAULT_CATALOG_FILTER: CatalogFilter = {
  genre: "",
  artist: "",
  access: "",
  resolveStatus: "",
  action: "",
  sort: "touches",
  order: "desc",
  page: 1,
};

export interface CatalogDailyPoint {
  date: string;
  touches: number;
  distinctTracks: number;
  playlistTouches: number;
}

export interface CatalogPlaylist {
  id: number | string;
  title: string | null;
  ownerScId: number | string | null;
  trackCount: number | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  touches: number;
  users: number;
  last_touched: string | null;
}

export interface CatalogPlaylistsResponse {
  playlists: CatalogPlaylist[];
  total: number;
  page: number;
  pageSize: number;
  sort: string;
  order: "asc" | "desc";
}

export type PlaylistSort = "touches" | "users" | "lastTouched" | "title" | "trackCount" | "firstSeen" | "lastSeen";

export interface PlaylistFilter {
  q: string;
  sort: PlaylistSort;
  order: "asc" | "desc";
  page: number;
}

export const DEFAULT_PLAYLIST_FILTER: PlaylistFilter = { q: "", sort: "touches", order: "desc", page: 1 };

export interface CatalogArtist {
  artist_key: string;
  artistName: string | null;
  artistId: number | string | null;
  tracks: number;
  touches: number;
  notPlayable: number;
  unresolved: number;
  notPlayablePct: number;
  last_touched: string | null;
}

export interface CatalogArtistsResponse {
  artists: CatalogArtist[];
  total: number;
  page: number;
  pageSize: number;
  sort: string;
  order: "asc" | "desc";
}

export type ArtistSort = "tracks" | "touches" | "notPlayable" | "unresolved" | "name" | "lastTouched";

export interface ArtistFilter {
  q: string;
  sort: ArtistSort;
  order: "asc" | "desc";
  page: number;
}

export const DEFAULT_ARTIST_FILTER: ArtistFilter = { q: "", sort: "touches", order: "desc", page: 1 };

export interface ReResolveResult {
  requested: number;
  candidates: number;
  fetched: number;
  missing: number;
}

export type CatalogSubView = "tracks" | "playlists" | "artists" | "health";
export const CATALOG_SUBVIEWS: ReadonlyArray<{ id: CatalogSubView; label: string }> = [
  { id: "tracks", label: "Tracks" },
  { id: "playlists", label: "Playlists" },
  { id: "artists", label: "Artists" },
  { id: "health", label: "Health" },
];

export interface TrackOperation {
  id: string;
  action: string;
  actionName: string;
  status: OpStatus | string;
  createdAt: string;
  user: { username: string; displayName: string | null; soundcloudId: number };
}

export interface RebrandSummary {
  period: Period;
  campaignId: string | null;
  total: number;
  nameChoice: Record<string, number>;
  nameIdeaCount: number;
  featureIdeaCount: number;
}

export interface RebrandVote {
  id: string;
  user: { username: string; displayName: string | null; avatarUrl: string | null };
  soundcloudId: number | null;
  campaignId: string;
  nameChoice: string;
  nameIdea: string | null;
  featureIdea: string | null;
  context: string | null;
  createdAt: string;
}

export interface BetaSurveySummary {
  period: Period;
  campaignId: string | null;
  total: number;
  wantsBetaCount: number;
  interest: Record<string, number>;
  rekordboxUse: Record<string, number>;
  platform: Record<string, number>;
}

/* ── Feedback inbox ───────────────────────────────────────────────────────
   The live in-app feedback form (the `Feedback` model), served by
   /api/admin/feedback-items*. NOT the retired SongSwipe beta survey, which
   lives at /api/admin/feedback/* and is read in the Archive view. Two tables,
   two eras; the path spelling is all that keeps them apart. */

/** Mirrors FEEDBACK_TYPES in server/middleware/validation.js. */
export type FeedbackType = "bug" | "feature" | "other";
export const FEEDBACK_TYPES: ReadonlyArray<FeedbackType> = ["bug", "feature", "other"];

/** Mirrors FEEDBACK_STATUSES in server/middleware/validation.js. */
export type FeedbackStatus = "new" | "seen" | "done" | "spam";
export const FEEDBACK_STATUSES: ReadonlyArray<FeedbackStatus> = ["new", "seen", "done", "spam"];

/**
 * Statuses a row can be moved *to*. `new` is where every row starts and is
 * deliberately not offered as a destination — triage only ever moves forward.
 */
export const FEEDBACK_ACTION_STATUSES: ReadonlyArray<FeedbackStatus> = ["seen", "done", "spam"];

export interface FeedbackItem {
  id: string;
  type: FeedbackType | string;
  message: string;
  page: string | null;
  email: string | null;
  status: FeedbackStatus | string;
  adminNote: string | null;
  clientInfo: ClientInfo | null;
  createdAt: string;
  user: { username: string | null; displayName: string | null; avatarUrl: string | null };
  soundcloudId: number | null;
}

export interface FeedbackItemsResponse {
  items: FeedbackItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FeedbackSummary {
  total: number;
  unread: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
}

export interface FeedbackFilter {
  /** "" means every status. */
  status: FeedbackStatus | "";
  /** "" means every type. */
  type: FeedbackType | "";
  page: number;
}

/**
 * The inbox opens on the untriaged rows. That is the one thing an admin comes
 * here to do, and it is what the old console's default tab was too.
 */
export const DEFAULT_FEEDBACK_FILTER: FeedbackFilter = { status: "new", type: "", page: 1 };

export type View = "overview" | "operations" | "performance" | "catalog" | "downloads" | "feedback" | "archive";

export const VIEWS: ReadonlyArray<{ id: View; label: string; hint: string }> = [
  { id: "overview", label: "Overview", hint: "Health, growth and what people use" },
  { id: "operations", label: "Operations", hint: "Every logged operation, searchable" },
  { id: "performance", label: "Performance", hint: "Latency by action, p95 first" },
  { id: "catalog", label: "Catalog", hint: "The harvested track catalog" },
  { id: "downloads", label: "Downloads", hint: "Which tracks are downloaded, by whom, and how" },
  { id: "feedback", label: "Feedback", hint: "The live in-app feedback inbox" },
  { id: "archive", label: "Archive", hint: "Closed votes and retired surveys" },
];

/* ── Downloads usage ─────────────────────────────────────────────────── */

export type DownloadChannel = "direct" | "hypeddit" | "droploud" | "cobrand";

export const DOWNLOAD_CHANNELS: ReadonlyArray<{ id: DownloadChannel; label: string; hint: string }> = [
  { id: "direct", label: "Direct", hint: "SoundCloud's own download, through the site (one click or the queue)" },
  { id: "hypeddit", label: "Hypeddit", hint: "A Hypeddit gate, worked by the extension" },
  { id: "droploud", label: "Droploud", hint: "A Droploud gate, worked by the extension" },
  { id: "cobrand", label: "Cobrand", hint: "A Cobrand gate, worked by the extension" },
];

export interface DownloadChannelStat {
  channel: DownloadChannel;
  downloads: number;
  failures: number;
  tracks: number;
  users: number;
}

export interface DownloadUserRow {
  userId: string;
  username: string;
  displayName: string | null;
  soundcloudId: number | null;
  direct: number;
  hypeddit: number;
  droploud: number;
  cobrand: number;
  failures: number;
  lastAt: string | null;
  usesExtension: boolean;
}

export interface DownloadsSummary {
  period: Period;
  totals: { downloads: number; failures: number; tracks: number; users: number; extensionUsers: number };
  channels: DownloadChannelStat[];
  daily: Array<{ date: string } & Record<DownloadChannel, number>>;
  users: DownloadUserRow[];
}

export type DownloadTrackSort = "downloads" | "users" | "failures" | "lastAt" | "title";

export interface DownloadTrack {
  trackId: string;
  title: string | null;
  artist: string | null;
  permalinkUrl: string | null;
  downloads: number;
  failures: number;
  users: number;
  channels: DownloadChannel[];
  lastAt: string | null;
}

export interface DownloadTracksResponse {
  tracks: DownloadTrack[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DownloadEvent {
  operationId: string;
  at: string;
  ok: boolean;
  trackId: string;
  title: string | null;
  artist: string | null;
  channel: DownloadChannel;
  via: "click" | "queue" | "extension";
  reason: string | null;
  user: { id: string; username: string; displayName: string | null };
}

export interface DownloadEventsResponse {
  events: DownloadEvent[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DownloadsTrackFilter {
  channel: DownloadChannel | "";
  q: string;
  sort: DownloadTrackSort;
  order: "asc" | "desc";
  page: number;
}

export const DEFAULT_DOWNLOADS_TRACK_FILTER: DownloadsTrackFilter = {
  channel: "",
  q: "",
  sort: "downloads",
  order: "desc",
  page: 1,
};

export interface DownloadsEventFilter {
  channel: DownloadChannel | "";
  userId: string;
  page: number;
}

export const DEFAULT_DOWNLOADS_EVENT_FILTER: DownloadsEventFilter = { channel: "", userId: "", page: 1 };
