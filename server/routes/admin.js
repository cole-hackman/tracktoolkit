import express from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { safeError } from '../lib/safe-error.js';
import { authenticateUser } from '../middleware/auth.js';
import { adminAuth } from '../middleware/adminAuth.js';
import {
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  validateFeedbackPatch,
  validateAdminReResolve,
} from '../middleware/validation.js';
import { getAnalyticsWriteHealth, logOperation } from '../lib/analytics.js';
import { LIFETIME_METRIC_KEY } from '../lib/retention.js';
import { heavyOperationRateLimiter } from '../middleware/rateLimiter.js';
import { enrichTrackIds } from '../lib/enrichment.js';

const router = express.Router();

const ACTION_NAMES = {
  'merge': 'Playlist Merge',
  'from-likes': 'Likes → Playlist',
  'playlist-transfer': 'Playlist track move/duplicate',
  'bulk-unlike': 'Bulk Unlike',
  'bulk-like': 'Bulk Like (Playlist → Likes)',
  'bulk-unfollow': 'Bulk Unfollow',
  'resolve': 'URL Resolve',
  'batch-resolve': 'Batch Resolve',
  'proxy-download': 'Proxy Download',
  'download-links': 'Download Queue',
  'bulk-remove-reposts': 'Remove Reposts',
  'library-audit': 'Library Audit',
  'playlist-compare': 'Playlist Compare',
  'clone': 'Playlist Clone',
  'delete-playlist': 'Delete Playlist',
  'genre-search': 'Genre Search',
  'growth-discover': 'Growth: Discover',
  'growth-engage-start': 'Growth: Engage',
  'growth-reverse': 'Growth: Reverse',
  'growth-check-followbacks': 'Growth: Check follow-backs',
  'auth-login': 'Login',
  'auth-logout': 'Logout',
  'followed-likes-to-playlist': "Followed User's Likes → Playlist",
  'followed-playlist-clone': "Followed User's Playlist Clone",
  'admin-re-resolve': 'Admin: Re-resolve catalog tracks',
};

const ACTION_COLORS = {
  'merge': '#FF5500',
  'from-likes': '#2ECC71',
  'playlist-transfer': '#9B59B6',
  'bulk-unlike': '#00D4AA',
  'bulk-like': '#1ABC9C',
  'bulk-unfollow': '#E066FF',
  'resolve': '#F1C40F',
  'batch-resolve': '#F19A0F',
  'proxy-download': '#4DA6FF',
  'download-links': '#4DA6FF',
  'bulk-remove-reposts': '#E74C3C',
  'library-audit': '#16A34A',
  'playlist-compare': '#7C3AED',
  'clone': '#2563EB',
  'delete-playlist': '#DC2626',
  'genre-search': '#0EA5E9',
  'growth-discover': '#A855F7',
  'growth-engage-start': '#A855F7',
  'growth-reverse': '#A855F7',
  'growth-check-followbacks': '#A855F7',
  'auth-login': '#64748B',
  'auth-logout': '#64748B',
  'followed-likes-to-playlist': '#0D9488',
  'followed-playlist-clone': '#0D9488',
  'admin-re-resolve': '#64748B',
};

const FEATURE_NAMES = {
  dashboard: 'Dashboard',
  downloads: 'Downloads',
  export: 'Export',
  'library-audit': 'Library Audit',
  combine: 'Combine Playlists',
  modifier: 'Playlist Modifier',
  'playlist-cloner': 'Playlist Cloner',
  'playlist-compare': 'Playlist Compare',
  'health-check': 'Playlist Health Check',
  likes: 'Likes to Playlist',
  'like-manager': 'Like Manager',
  'following-manager': 'Following Manager',
  'following-library': 'Following Library',
  'repost-manager': 'Repost Manager',
  activity: 'Activity to Playlist',
  growth: 'Grow Your Network',
  'genre-search': 'Genre Search',
  resolver: 'Link Resolver',
  'batch-resolver': 'Batch Link Resolver',
  'recently-played': 'Recently Played',
};

function periodToCutoff(period) {
  if (period === 'all') {
    return new Date(0);
  }

  if (period === 'month') {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return start;
  }

  const days = period === '1d' ? 1 : period === '7d' ? 7 : period === '90d' ? 90 : 30;
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function validPeriod(p) {
  return ['1d', '7d', '30d', '90d', 'month', 'all'].includes(p) ? p : '30d';
}

/**
 * Number of days a daily series should span for a period. For 'all' the
 * count comes from the earliest row actually returned, capped at a year —
 * otherwise a long-lived account would ask for a multi-decade day-by-day
 * series. The aggregate cards still cover full history; this only bounds
 * chart resolution.
 */
function periodDayCount(period, cutoff, rows) {
  if (period === '1d') return 1;
  if (period === '7d') return 7;
  if (period === '90d') return 90;
  if (period === 'month') return Math.max(Math.ceil((Date.now() - cutoff.getTime()) / 86_400_000), 1);
  if (period === 'all') {
    const earliestDates = rows.map(r => new Date(r.day).getTime());
    const earliest = earliestDates.length > 0 ? Math.min(...earliestDates) : Date.now();
    return Math.min(Math.max(Math.ceil((Date.now() - earliest) / 86_400_000) + 1, 1), 365);
  }
  return 30;
}

/**
 * Zero-fill `days` calendar days ending today. `rowSets` are DATE_TRUNC'd
 * query results (each row has `day`); `build` receives the matching row from
 * each set (or undefined) and returns the numeric fields for that day.
 */
function fillDays(days, rowSets, build) {
  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
  const indexes = rowSets.map(rows => new Map(rows.map(r => [dayKey(r.day), r])));
  const result = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    d.setHours(0, 0, 0, 0);
    const key = d.toISOString().slice(0, 10);
    result.push({
      date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      ...build(...indexes.map(m => m.get(key))),
    });
  }
  return result;
}

const CSV_MAX_ROWS = 10_000;

/** Send rows as a CSV attachment (RFC 4180 quoting, BOM for Excel). */
function sendCsv(res, filename, header, rows) {
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const str = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [header.map(escape).join(',')];
  for (const row of rows) lines.push(header.map(k => escape(row[k])).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`\ufeff${lines.join('\n')}`);
}

function strParam(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Shared paging/sorting parse for the catalog listings. */
function listParams(req, sorts, defaultSort, defaultOrder = 'DESC') {
  const csv = req.query.format === 'csv';
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const pageSize = csv
    ? CSV_MAX_ROWS
    : Math.min(Math.max(parseInt(req.query.pageSize) || 25, 1), 100);
  // Object.hasOwn, not truthiness: '?sort=constructor' must not reach Prisma.raw
  const sortKey = Object.hasOwn(sorts, req.query.sort) ? req.query.sort : defaultSort;
  const order = req.query.order === 'asc' ? 'ASC' : req.query.order === 'desc' ? 'DESC' : defaultOrder;
  return { csv, page: csv ? 1 : page, pageSize, sortKey, order };
}

/**
 * GET /api/admin/stats?period=1d|7d|30d|90d|month|all
 *
 * Returns aggregated stats for the dashboard top cards, feature usage,
 * sidebar quick stats, and health/rate metrics.
 */
router.get('/stats', authenticateUser, adminAuth, async (req, res) => {
  try {
    const period = validPeriod(req.query.period);
    const cutoff = periodToCutoff(period);

    // Page-open signals (`view:*`) and read-latency probes (`read:*`) are both
    // excluded from operation metrics: neither is a user-initiated operation,
    // and counting them would inflate operationsCount and dilute successRate.
    // `view:*` is reported below as feature reach; `read:*` feeds readLatency.
    const operationWhere = {
      createdAt: { gte: cutoff },
      AND: [
        { action: { not: { startsWith: 'view:' } } },
        { action: { not: { startsWith: 'read:' } } },
      ],
    };

    // All-time distinct users, snapshotted by the retention job before it
    // purges operation logs — so the headline figure does not shrink when rows
    // age out of the 12-month window. Null until the job has run once, and
    // soft-failing: a missing metrics table must not 500 the whole dashboard.
    const lifetimeMetricQuery = prisma.metric
      ? prisma.metric.findUnique({ where: { key: LIFETIME_METRIC_KEY } }).catch(() => null)
      : Promise.resolve(null);

    const [
      totalUsers,
      newUsers,
      agg,
      byAction,
      byActionErrors,
      byStatus,
      splitsCount,
      activeUsersPeriodRows,
      featureReachRows,
      topErrors,
      avgLatencyRows,
      perActionLatencyRows,
      lifetimeMetric,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: cutoff } } }),
      prisma.operationLog.aggregate({
        where: operationWhere,
        _sum: { trackCount: true },
        _count: { id: true },
        _avg: { trackCount: true, durationMs: true },
      }),
      prisma.operationLog.groupBy({
        by: ['action'],
        where: operationWhere,
        _count: { id: true },
        _avg: { durationMs: true },
        orderBy: { _count: { id: 'desc' } },
      }),
      prisma.operationLog.groupBy({
        by: ['action'],
        where: { ...operationWhere, status: 'error' },
        _count: { id: true },
      }),
      prisma.operationLog.groupBy({
        by: ['status'],
        where: operationWhere,
        _count: { id: true },
      }),
      prisma.operationLog.count({
        where: { ...operationWhere, status: 'split' },
      }),
      prisma.$queryRaw`
        SELECT COUNT(DISTINCT "userId")::int AS count
        FROM operation_logs
        WHERE "createdAt" >= ${cutoff}
          AND action NOT LIKE 'view:%' AND action NOT LIKE 'read:%'
      `,
      prisma.$queryRaw`
        SELECT
          action,
          COUNT(DISTINCT "userId")::int AS users,
          COUNT(*)::int AS opens
        FROM operation_logs
        WHERE "createdAt" >= ${cutoff} AND action LIKE 'view:%'
        GROUP BY action
        ORDER BY users DESC, opens DESC, action ASC
      `,
      prisma.operationLog.groupBy({
        by: ['errorCode'],
        where: { ...operationWhere, status: 'error' },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      }),
      prisma.$queryRaw`
        SELECT
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "durationMs")::int AS p95,
          AVG("durationMs")::int AS avg
        FROM operation_logs
        WHERE "createdAt" >= ${cutoff}
          AND action NOT LIKE 'view:%' AND action NOT LIKE 'read:%'
          AND "durationMs" IS NOT NULL
      `,
      // Per-action p95, including the `read:*` probes. Average alone hides the
      // tail that users actually complain about, and the existing groupBy at
      // byAction only computes _avg. `scCalls` is the SoundCloud round-trip
      // count recorded by instrumentRead — the number that explains the p95.
      prisma.$queryRaw`
        SELECT
          action,
          COUNT(*)::int AS runs,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "durationMs")::int AS p95,
          AVG("durationMs")::int AS avg,
          MAX("durationMs")::int AS max,
          AVG((metadata->>'scCalls')::numeric)::float AS "avgScCalls"
        FROM operation_logs
        WHERE "createdAt" >= ${cutoff}
          AND action NOT LIKE 'view:%'
          AND "durationMs" IS NOT NULL
        GROUP BY action
        HAVING COUNT(*) >= 3
        ORDER BY p95 DESC
        LIMIT 25
      `,
      lifetimeMetricQuery,
    ]);

    const operationsCount = agg._count.id ?? 0;
    const tracksProcessed = agg._sum.trackCount ?? 0;
    const avgTracksPerOp = agg._avg.trackCount ? Math.round(agg._avg.trackCount) : 0;
    const avgDurationMs = agg._avg.durationMs ? Math.round(agg._avg.durationMs) : 0;
    const p95DurationMs = Number(avgLatencyRows?.[0]?.p95 ?? 0);
    const activeUsersPeriod = Number(activeUsersPeriodRows?.[0]?.count ?? 0);

    const errorCountByAction = {};
    for (const row of byActionErrors) errorCountByAction[row.action] = row._count.id;

    const featureUsage = byAction.map(row => ({
      key: row.action,
      name: ACTION_NAMES[row.action] || row.action,
      count: row._count.id,
      avgDurationMs: row._avg.durationMs ? Math.round(row._avg.durationMs) : 0,
      errorCount: errorCountByAction[row.action] ?? 0,
      errorRate: row._count.id > 0 ? Math.round(((errorCountByAction[row.action] ?? 0) / row._count.id) * 100) : 0,
      color: ACTION_COLORS[row.action] || '#888888',
    }));

    const errorRateByAction = featureUsage
      .filter(f => f.errorCount > 0)
      .sort((a, b) => b.errorRate - a.errorRate || b.errorCount - a.errorCount)
      .slice(0, 8);

    // null errorCode buckets are real errors from paths that predate (or still
    // lack) error capture — label them rather than filtering them out.
    const errorBreakdown = topErrors.map(e => ({
      errorCode: e.errorCode ?? 'UNSPECIFIED',
      count: e._count.id,
    }));

    const topFeature = featureUsage.length > 0 ? featureUsage[0] : null;

    // Slowest actions first — the ranking the audit needs. Named readLatency
    // because the `read:*` probes dominate it, but mutations appear here too.
    const readLatency = (perActionLatencyRows || []).map(row => ({
      action: row.action,
      name: ACTION_NAMES[row.action] || row.action.replace(/^read:/, ''),
      runs: Number(row.runs),
      p95Ms: Number(row.p95 ?? 0),
      avgMs: Number(row.avg ?? 0),
      maxMs: Number(row.max ?? 0),
      avgScCalls: row.avgScCalls == null ? null : Math.round(Number(row.avgScCalls) * 10) / 10,
    }));
    const featureReach = featureReachRows.map(row => {
      const slug = row.action.slice('view:'.length);
      return {
        key: slug,
        name: FEATURE_NAMES[slug] || slug,
        users: Number(row.users),
        opens: Number(row.opens),
      };
    });

    const statusMap = {};
    for (const row of byStatus) statusMap[row.status] = row._count.id;
    const total = operationsCount || 1;
    // Auto-splits are successful outcomes (the output just exceeded SoundCloud's
    // 500-track cap), so they count toward the headline success rate.
    const successRate = Math.round((((statusMap['success'] ?? 0) + (statusMap['split'] ?? 0)) / total) * 100);
    const splitRate = Math.round(((statusMap['split'] ?? 0) / total) * 100);
    const errorRate = Math.round(((statusMap['error'] ?? 0) / total) * 100);
    const partialRate = Math.round(((statusMap['partial'] ?? 0) / total) * 100);

    res.json({
      totalUsers,
      // Null before the retention job's first run; a number afterwards, and
      // never lower than totalUsers' historical peak.
      lifetimeUsers: lifetimeMetric ? Number(lifetimeMetric.value) : null,
      newUsers,
      tracksProcessed,
      operationsCount,
      featureUsage,
      featureReach,
      errorBreakdown,
      errorRateByAction,
      splitsCount,
      avgTracksPerOp,
      avgDurationMs,
      p95DurationMs,
      successRate,
      splitRate,
      errorRate,
      partialRate,
      partialCount: statusMap['partial'] ?? 0,
      topFeature,
      readLatency,
      activeUsersPeriod,
      analyticsWriteHealth: getAnalyticsWriteHealth(),
    });
  } catch (err) {
    logger.error('[admin/stats] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * GET /api/admin/daily?period=1d|7d|30d|90d|month|all
 *
 * Returns daily time-series data for chart rendering.
 * Uses raw SQL DATE_TRUNC since Prisma groupBy doesn't support it.
 * Fills zero for days with no activity.
 */
router.get('/daily', authenticateUser, adminAuth, async (req, res) => {
  try {
    const period = validPeriod(req.query.period);
    const cutoff = periodToCutoff(period);

    const [opsRows, userRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT
          DATE_TRUNC('day', "createdAt") AS day,
          COUNT(*)::int                  AS operations,
          COALESCE(SUM("trackCount"), 0)::int AS tracks
        FROM operation_logs
        WHERE "createdAt" >= ${cutoff} AND action NOT LIKE 'view:%'
        GROUP BY day
        ORDER BY day ASC
      `,
      prisma.$queryRaw`
        SELECT
          DATE_TRUNC('day', "createdAt") AS day,
          COUNT(*)::int AS new_users
        FROM users
        WHERE "createdAt" >= ${cutoff}
        GROUP BY day
        ORDER BY day ASC
      `,
    ]);

    const days = periodDayCount(period, cutoff, [...opsRows, ...userRows]);
    const result = fillDays(days, [opsRows, userRows], (opsRow, userRow) => ({
      tracks: opsRow ? Number(opsRow.tracks) : 0,
      operations: opsRow ? Number(opsRow.operations) : 0,
      newUsers: userRow ? Number(userRow.new_users) : 0,
    }));

    res.json({ daily: result });
  } catch (err) {
    logger.error('[admin/daily] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to fetch daily data' });
  }
});

/**
 * GET /api/admin/operations?period=1d|7d|30d|90d|month|all&limit=20&action=<action>&status=<status>&search=<query>
 *
 * Returns recent operation logs with user info and detailed metadata.
 */
router.get('/operations', authenticateUser, adminAuth, async (req, res) => {
  try {
    const period = validPeriod(req.query.period);
    const cutoff = periodToCutoff(period);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const actionFilter = typeof req.query.action === 'string' && req.query.action.trim() ? req.query.action.trim() : null;
    const statusFilter = typeof req.query.status === 'string' && req.query.status.trim() ? req.query.status.trim() : null;
    const searchFilter = typeof req.query.search === 'string' && req.query.search.trim() ? req.query.search.trim() : null;

    const where = {
      createdAt: { gte: cutoff },
      action: actionFilter ? actionFilter : { not: { startsWith: 'view:' } },
    };
    if (statusFilter && ['success', 'split', 'error', 'partial'].includes(statusFilter)) {
      where.status = statusFilter;
    }
    if (searchFilter) {
      const searchNum = Number(searchFilter);
      const isNum = !isNaN(searchNum) && searchNum > 0;
      where.OR = [
        { user: { username: { contains: searchFilter, mode: 'insensitive' } } },
        { user: { displayName: { contains: searchFilter, mode: 'insensitive' } } },
        { errorCode: { contains: searchFilter, mode: 'insensitive' } },
        { errorMessage: { contains: searchFilter, mode: 'insensitive' } },
      ];
      if (isNum) {
        where.OR.push({ soundcloudId: searchNum });
      }
    }

    const logs = await prisma.operationLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: {
          select: { username: true, displayName: true, avatarUrl: true, soundcloudId: true },
        },
      },
    });

    const operations = logs.map(log => ({
      id: log.id,
      user: {
        username: log.user.username,
        displayName: log.user.displayName,
        avatarUrl: log.user.avatarUrl,
        soundcloudId: log.user.soundcloudId,
      },
      soundcloudId: log.soundcloudId || log.user?.soundcloudId,
      action: log.action,
      actionName: ACTION_NAMES[log.action] || log.action,
      trackCount: log.trackCount,
      itemCount: log.itemCount,
      status: log.status,
      durationMs: log.durationMs,
      errorCode: log.errorCode,
      errorMessage: log.errorMessage,
      clientInfo: log.clientInfo,
      createdAt: log.createdAt.toISOString(),
      metadata: log.metadata,
    }));

    res.json({ operations });
  } catch (err) {
    logger.error('[admin/operations] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to fetch operations' });
  }
});

/**
 * GET /api/admin/catalog/summary?period=...
 *
 * Aggregate view over the music catalog: totals, genre/access/resolve
 * breakdowns (gaps included — unresolved and null-genre are first-class),
 * plus period-scoped touch volume from operation_logs ID arrays.
 */
router.get('/catalog/summary', authenticateUser, adminAuth, async (req, res) => {
  try {
    const period = validPeriod(req.query.period);
    const cutoff = periodToCutoff(period);

    const [totalsRows, playlistsCount, accessRows, resolveRows, genreRows, touchRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS tracks,
               COUNT(DISTINCT COALESCE("artistId"::text, "artistName"))::int AS artists
        FROM "tracks"
      `,
      prisma.playlist.count(),
      prisma.track.groupBy({ by: ['access'], _count: { id: true } }),
      prisma.track.groupBy({ by: ['resolveStatus'], _count: { id: true } }),
      prisma.$queryRaw`
        SELECT COALESCE("genreNormalized", '(none)') AS genre, COUNT(*)::int AS count
        FROM "tracks"
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT 12
      `,
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS touch_events,
               COUNT(DISTINCT track_id)::int AS distinct_tracks
        FROM (
          SELECT (jsonb_array_elements_text(metadata->'trackIds'))::bigint AS track_id
          FROM operation_logs
          WHERE "createdAt" >= ${cutoff} AND metadata ? 'trackIds'
        ) touches
      `,
    ]);

    const toCounts = (rows, field) => rows.reduce((acc, row) => {
      acc[row[field] ?? 'unknown'] = row._count.id;
      return acc;
    }, {});

    res.json({
      period,
      totalTracks: totalsRows[0]?.tracks ?? 0,
      totalArtists: totalsRows[0]?.artists ?? 0,
      totalPlaylists: playlistsCount,
      accessBreakdown: toCounts(accessRows, 'access'),
      resolveBreakdown: toCounts(resolveRows, 'resolveStatus'),
      genreBreakdown: genreRows.map(g => ({ genre: g.genre, count: Number(g.count) })),
      periodTouchEvents: Number(touchRows[0]?.touch_events ?? 0),
      periodDistinctTracks: Number(touchRows[0]?.distinct_tracks ?? 0),
    });
  } catch (err) {
    logger.error('[admin/catalog/summary] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to fetch catalog summary' });
  }
});

const CATALOG_SORTS = {
  touches: 'touches',
  users: 'users',
  lastTouched: 'last_touched',
  title: 't."title"',
  artist: 't."artistName"',
  firstSeen: 't."firstSeenAt"',
  lastSeen: 't."lastSeenAt"',
  duration: 't."durationMs"',
};

/** Per-track touch counts in the window from operation_logs.metadata.trackIds. */
function trackTouchesCte(cutoff, action) {
  return Prisma.sql`
    SELECT (jsonb_array_elements_text(metadata->'trackIds'))::bigint AS track_id,
           COUNT(*) AS touch_count,
           COUNT(DISTINCT "userId") AS user_count,
           MAX("createdAt") AS last_touched
    FROM operation_logs
    WHERE "createdAt" >= ${cutoff} AND metadata ? 'trackIds'
      ${action ? Prisma.sql`AND action = ${action}` : Prisma.empty}
    GROUP BY 1
  `;
}

/** WHERE fragment for the track filters shared by the listing, CSV and health views. */
function trackFilterSql({ genre, artist, access, resolveStatus }) {
  const filters = [];
  if (genre) {
    filters.push(genre === '(none)'
      ? Prisma.sql`t."genreNormalized" IS NULL`
      : Prisma.sql`t."genreNormalized" = ${genre}`);
  }
  if (artist) filters.push(Prisma.sql`t."artistName" ILIKE ${'%' + artist + '%'}`);
  if (access) {
    if (access === 'unknown') filters.push(Prisma.sql`t."access" IS NULL`);
    else if (access === 'not_playable') filters.push(Prisma.sql`t."access" IN ('blocked', 'preview', 'gone')`);
    else filters.push(Prisma.sql`t."access" = ${access}`);
  }
  if (resolveStatus) filters.push(Prisma.sql`t."resolveStatus" = ${resolveStatus}`);
  return filters.length > 0 ? Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}` : Prisma.empty;
}

/**
 * GET /api/admin/catalog/tracks
 *   ?period=&genre=&artist=&access=&resolveStatus=&action=&sort=&order=&page=&pageSize=&format=csv
 *
 * Paginated catalog rows with period-scoped touch counts. Aggregate by
 * default — no user identity in this listing; per-user drill-down is the
 * separate /catalog/tracks/:id/operations endpoint. With an action filter
 * the join tightens to tracks actually touched by that action in-period;
 * otherwise zero-touch rows stay visible so gaps (unresolved, null genre,
 * blocked/preview) can be explored. `access=not_playable` is the union of
 * blocked, preview and gone. `format=csv` returns the same filtered set as
 * a download, capped at CSV_MAX_ROWS.
 */
router.get('/catalog/tracks', authenticateUser, adminAuth, async (req, res) => {
  try {
    const period = validPeriod(req.query.period);
    const cutoff = periodToCutoff(period);
    const { csv, page, pageSize, sortKey, order } = listParams(req, CATALOG_SORTS, 'touches');
    const genre = strParam(req.query.genre);
    const artist = strParam(req.query.artist);
    const access = strParam(req.query.access);
    const resolveStatus = strParam(req.query.resolveStatus);
    const action = strParam(req.query.action);

    const touchesCte = trackTouchesCte(cutoff, action);
    const whereSql = trackFilterSql({ genre, artist, access, resolveStatus });

    // Action filter means "touched by this action" — inner join; otherwise
    // keep zero-touch catalog rows visible.
    const joinSql = action
      ? Prisma.sql`INNER JOIN touches tc ON tc.track_id = t.id`
      : Prisma.sql`LEFT JOIN touches tc ON tc.track_id = t.id`;

    const orderSql = Prisma.raw(`${CATALOG_SORTS[sortKey]} ${order} NULLS LAST, t.id ASC`);

    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw`
        WITH touches AS (${touchesCte})
        SELECT t.id, t.title, t."artistName", t."artistId", t.genre, t."genreNormalized",
               t."durationMs", t.access, t."permalinkUrl", t."resolveStatus",
               t."resolveAttempts", t."firstSeenAt", t."lastSeenAt",
               COALESCE(tc.touch_count, 0)::int AS touches,
               COALESCE(tc.user_count, 0)::int AS users,
               tc.last_touched
        FROM "tracks" t
        ${joinSql}
        ${whereSql}
        ORDER BY ${orderSql}
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `,
      csv ? Promise.resolve([{ total: 0 }]) : prisma.$queryRaw`
        WITH touches AS (${touchesCte})
        SELECT COUNT(*)::int AS total
        FROM "tracks" t
        ${joinSql}
        ${whereSql}
      `,
    ]);

    if (csv) {
      return sendCsv(res, `catalog-tracks-${period}.csv`, [
        'id', 'title', 'artistName', 'artistId', 'genre', 'genreNormalized', 'durationMs', 'access',
        'resolveStatus', 'permalinkUrl', 'touches', 'users', 'last_touched', 'firstSeenAt', 'lastSeenAt',
      ], rows);
    }

    res.json({
      tracks: rows,
      total: Number(countRows[0]?.total ?? 0),
      page,
      pageSize,
      sort: sortKey,
      order: order.toLowerCase(),
    });
  } catch (err) {
    logger.error('[admin/catalog/tracks] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to fetch catalog tracks' });
  }
});

/**
 * GET /api/admin/catalog/daily?period=
 *
 * Per-day catalog activity in the window: track touches (every track id in
 * an operation's metadata counts once per operation), distinct tracks
 * touched, and playlist touches. Zero-filled like /daily.
 */
router.get('/catalog/daily', authenticateUser, adminAuth, async (req, res) => {
  try {
    const period = validPeriod(req.query.period);
    const cutoff = periodToCutoff(period);

    const [trackRows, playlistRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT DATE_TRUNC('day', "createdAt") AS day,
               COUNT(*)::int AS touches,
               COUNT(DISTINCT track_id)::int AS distinct_tracks
        FROM (
          SELECT "createdAt", (jsonb_array_elements_text(metadata->'trackIds'))::bigint AS track_id
          FROM operation_logs
          WHERE "createdAt" >= ${cutoff} AND metadata ? 'trackIds'
        ) t
        GROUP BY day
        ORDER BY day ASC
      `,
      prisma.$queryRaw`
        SELECT DATE_TRUNC('day', "createdAt") AS day,
               COUNT(*)::int AS touches
        FROM (
          SELECT "createdAt", jsonb_array_elements_text(metadata->'playlistIds') AS playlist_id
          FROM operation_logs
          WHERE "createdAt" >= ${cutoff} AND metadata ? 'playlistIds'
        ) p
        GROUP BY day
        ORDER BY day ASC
      `,
    ]);

    const days = periodDayCount(period, cutoff, [...trackRows, ...playlistRows]);
    const daily = fillDays(days, [trackRows, playlistRows], (t, p) => ({
      touches: t ? Number(t.touches) : 0,
      distinctTracks: t ? Number(t.distinct_tracks) : 0,
      playlistTouches: p ? Number(p.touches) : 0,
    }));

    res.json({ daily });
  } catch (err) {
    logger.error('[admin/catalog/daily] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to fetch catalog daily series' });
  }
});

const PLAYLIST_SORTS = {
  touches: 'touches',
  users: 'users',
  lastTouched: 'last_touched',
  title: 'p."title"',
  trackCount: 'p."trackCount"',
  firstSeen: 'p."firstSeenAt"',
  lastSeen: 'p."lastSeenAt"',
};

/**
 * GET /api/admin/catalog/playlists?period=&q=&sort=&order=&page=&pageSize=&format=csv
 *
 * The harvested playlists table with period-scoped touch counts from
 * operation_logs.metadata.playlistIds. Same shape and posture as the track
 * listing: aggregate only, no user identity.
 */
router.get('/catalog/playlists', authenticateUser, adminAuth, async (req, res) => {
  try {
    const period = validPeriod(req.query.period);
    const cutoff = periodToCutoff(period);
    const { csv, page, pageSize, sortKey, order } = listParams(req, PLAYLIST_SORTS, 'touches');
    const q = strParam(req.query.q);
    const owner = strParam(req.query.owner);

    const touchesCte = Prisma.sql`
      SELECT (jsonb_array_elements_text(metadata->'playlistIds'))::bigint AS playlist_id,
             COUNT(*) AS touch_count,
             COUNT(DISTINCT "userId") AS user_count,
             MAX("createdAt") AS last_touched
      FROM operation_logs
      WHERE "createdAt" >= ${cutoff} AND metadata ? 'playlistIds'
      GROUP BY 1
    `;
    const filters = [];
    if (q) filters.push(Prisma.sql`p."title" ILIKE ${'%' + q + '%'}`);
    if (owner && /^\d+$/.test(owner)) filters.push(Prisma.sql`p."ownerScId" = ${BigInt(owner)}`);
    const whereSql = filters.length > 0 ? Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}` : Prisma.empty;
    const orderSql = Prisma.raw(`${PLAYLIST_SORTS[sortKey]} ${order} NULLS LAST, p.id ASC`);

    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw`
        WITH touches AS (${touchesCte})
        SELECT p.id, p.title, p."ownerScId", p."trackCount", p."firstSeenAt", p."lastSeenAt",
               COALESCE(tc.touch_count, 0)::int AS touches,
               COALESCE(tc.user_count, 0)::int AS users,
               tc.last_touched
        FROM "playlists" p
        LEFT JOIN touches tc ON tc.playlist_id = p.id
        ${whereSql}
        ORDER BY ${orderSql}
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `,
      csv ? Promise.resolve([{ total: 0 }]) : prisma.$queryRaw`
        SELECT COUNT(*)::int AS total FROM "playlists" p ${whereSql}
      `,
    ]);

    if (csv) {
      return sendCsv(res, `catalog-playlists-${period}.csv`, [
        'id', 'title', 'ownerScId', 'trackCount', 'touches', 'users', 'last_touched', 'firstSeenAt', 'lastSeenAt',
      ], rows);
    }

    res.json({
      playlists: rows,
      total: Number(countRows[0]?.total ?? 0),
      page,
      pageSize,
      sort: sortKey,
      order: order.toLowerCase(),
    });
  } catch (err) {
    logger.error('[admin/catalog/playlists] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to fetch catalog playlists' });
  }
});

const ARTIST_SORTS = {
  tracks: 'tracks',
  touches: 'touches',
  notPlayable: 'not_playable_share',
  unresolved: 'unresolved',
  name: 'artist_name',
  lastTouched: 'last_touched',
};

/**
 * GET /api/admin/catalog/artists?period=&q=&sort=&order=&page=&pageSize=&format=csv
 *
 * Catalog rolled up by artist: track count, period touches, and how much of
 * the artist's catalog is not playable (blocked/preview/gone) or unresolved.
 * Keyed by SoundCloud user id when known, else by name; rows with neither
 * are excluded because they cannot be attributed.
 */
router.get('/catalog/artists', authenticateUser, adminAuth, async (req, res) => {
  try {
    const period = validPeriod(req.query.period);
    const cutoff = periodToCutoff(period);
    const { csv, page, pageSize, sortKey, order } = listParams(req, ARTIST_SORTS, 'touches');
    const q = strParam(req.query.q);

    const touchesCte = trackTouchesCte(cutoff, null);
    const whereSql = q
      ? Prisma.sql`WHERE (t."artistId" IS NOT NULL OR t."artistName" IS NOT NULL) AND t."artistName" ILIKE ${'%' + q + '%'}`
      : Prisma.sql`WHERE t."artistId" IS NOT NULL OR t."artistName" IS NOT NULL`;
    const orderSql = Prisma.raw(`${ARTIST_SORTS[sortKey]} ${order} NULLS LAST, artist_key ASC`);

    const groupedCte = Prisma.sql`
      SELECT COALESCE(t."artistId"::text, t."artistName") AS artist_key,
             MAX(t."artistName") AS artist_name,
             MIN(t."artistId") AS artist_id,
             COUNT(*)::int AS tracks,
             COALESCE(SUM(tc.touch_count), 0)::int AS touches,
             COUNT(*) FILTER (WHERE t."access" IN ('blocked', 'preview', 'gone'))::int AS not_playable,
             COUNT(*) FILTER (WHERE t."resolveStatus" <> 'resolved')::int AS unresolved,
             (COUNT(*) FILTER (WHERE t."access" IN ('blocked', 'preview', 'gone')))::float / COUNT(*) AS not_playable_share,
             MAX(tc.last_touched) AS last_touched
      FROM "tracks" t
      LEFT JOIN touches tc ON tc.track_id = t.id
      ${whereSql}
      GROUP BY 1
    `;

    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw`
        WITH touches AS (${touchesCte}), grouped AS (${groupedCte})
        SELECT artist_key, artist_name AS "artistName", artist_id AS "artistId",
               tracks, touches, not_playable AS "notPlayable", unresolved,
               ROUND((not_playable_share * 100)::numeric, 1)::float AS "notPlayablePct",
               last_touched
        FROM grouped
        ORDER BY ${orderSql}
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `,
      csv ? Promise.resolve([{ total: 0 }]) : prisma.$queryRaw`
        SELECT COUNT(DISTINCT COALESCE(t."artistId"::text, t."artistName"))::int AS total
        FROM "tracks" t
        ${whereSql}
      `,
    ]);

    if (csv) {
      return sendCsv(res, `catalog-artists-${period}.csv`, [
        'artistName', 'artistId', 'tracks', 'touches', 'notPlayable', 'notPlayablePct', 'unresolved', 'last_touched',
      ], rows);
    }

    res.json({
      artists: rows,
      total: Number(countRows[0]?.total ?? 0),
      page,
      pageSize,
      sort: sortKey,
      order: order.toLowerCase(),
    });
  } catch (err) {
    logger.error('[admin/catalog/artists] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to fetch catalog artists' });
  }
});

/**
 * POST /api/admin/catalog/re-resolve   { trackIds: number[] }  (1-200)
 *
 * The console's one write: refetch the given tracks from SoundCloud through
 * the enrichment path, forced, using the admin's own token. Rows that come
 * back are upserted (a blocked track that is playable again flips to
 * playable); rows SoundCloud no longer returns are marked gone. Guarded by
 * the heavy-operation limiter and the global Origin check on /api; the
 * body is JSON-only like every other mutation.
 */
router.post('/catalog/re-resolve', authenticateUser, adminAuth, heavyOperationRateLimiter, validateAdminReResolve, async (req, res) => {
  const trackIds = [...new Set(req.body.trackIds.map(Number))];
  const startedAt = Date.now();
  try {
    const result = await enrichTrackIds(trackIds, req.accessToken, req.refreshToken, { force: true });
    void logOperation({
      req,
      action: 'admin-re-resolve',
      trackIds,
      status: result.candidates === 0 ? 'partial' : 'success',
      durationMs: Date.now() - startedAt,
      metadata: { requested: trackIds.length, candidates: result.candidates, fetched: result.fetched, missing: result.missing },
    });
    res.json({ requested: trackIds.length, ...result });
  } catch (err) {
    logger.error('[admin/catalog/re-resolve] Error:', safeError(err));
    void logOperation({
      req,
      action: 'admin-re-resolve',
      trackIds,
      status: 'error',
      durationMs: Date.now() - startedAt,
      errorCode: 'RE_RESOLVE_FAILED',
      errorMessage: err?.message,
    });
    res.status(502).json({ error: 'Re-resolve failed while talking to SoundCloud' });
  }
});

/**
 * GET /api/admin/catalog/tracks/:id/operations
 *
 * Deliberate per-user drill-down for one track: the operations that touched
 * it, with user identity. Served separately from the aggregate listing.
 */
router.get('/catalog/tracks/:id/operations', authenticateUser, adminAuth, async (req, res) => {
  try {
    const trackId = Number(req.params.id);
    if (!Number.isInteger(trackId) || trackId <= 0) {
      return res.status(400).json({ error: 'Invalid track id' });
    }
    const rows = await prisma.$queryRaw`
      SELECT ol.id, ol.action, ol.status, ol."createdAt",
             u.username, u."displayName", u."soundcloudId"
      FROM operation_logs ol
      JOIN users u ON u.id = ol."userId"
      WHERE ol.metadata @> jsonb_build_object('trackIds', jsonb_build_array(${trackId}::bigint))
      ORDER BY ol."createdAt" DESC
      LIMIT 50
    `;
    res.json({
      operations: rows.map(r => ({
        id: r.id,
        action: r.action,
        actionName: ACTION_NAMES[r.action] || r.action,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        user: { username: r.username, displayName: r.displayName, soundcloudId: Number(r.soundcloudId) },
      })),
    });
  } catch (err) {
    logger.error('[admin/catalog/track-operations] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to fetch track operations' });
  }
});

/**
 * GET /api/admin/rebrand/summary?period=30d&campaignId=<id>
 *
 * Live survey: vote tally for the rename shortlist, plus how many people
 * left a name of their own or a feature request.
 */
router.get('/rebrand/summary', authenticateUser, adminAuth, async (req, res) => {
  try {
    const period = validPeriod(req.query.period);
    const cutoff = periodToCutoff(period);
    const campaignId = typeof req.query.campaignId === 'string' && req.query.campaignId.trim()
      ? req.query.campaignId.trim()
      : null;

    const where = { createdAt: { gte: cutoff } };
    if (campaignId) where.campaignId = campaignId;

    const [total, byChoice, withNameIdea, withFeatureIdea] = await Promise.all([
      prisma.rebrandVote.count({ where }),
      prisma.rebrandVote.groupBy({ by: ['nameChoice'], where, _count: { id: true } }),
      prisma.rebrandVote.count({ where: { ...where, nameIdea: { not: null } } }),
      prisma.rebrandVote.count({ where: { ...where, featureIdea: { not: null } } }),
    ]);

    const nameChoice = byChoice.reduce((acc, row) => {
      acc[row.nameChoice ?? 'unanswered'] = row._count.id;
      return acc;
    }, {});

    res.json({
      period,
      campaignId,
      total,
      nameChoice,
      nameIdeaCount: withNameIdea,
      featureIdeaCount: withFeatureIdea,
    });
  } catch (err) {
    logger.error('[admin/rebrand/summary] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to fetch rebrand summary' });
  }
});

/**
 * GET /api/admin/rebrand?period=30d&limit=50&campaignId=<id>
 * Individual votes, newest first — this is where the write-in names and
 * feature requests are read.
 */
router.get('/rebrand', authenticateUser, adminAuth, async (req, res) => {
  try {
    const period = validPeriod(req.query.period);
    const cutoff = periodToCutoff(period);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const campaignId = typeof req.query.campaignId === 'string' && req.query.campaignId.trim()
      ? req.query.campaignId.trim()
      : null;

    const where = { createdAt: { gte: cutoff } };
    if (campaignId) where.campaignId = campaignId;

    const rows = await prisma.rebrandVote.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: { select: { username: true, displayName: true, avatarUrl: true } },
      },
    });

    res.json({
      responses: rows.map(r => ({
        id: r.id,
        user: {
          username: r.user.username,
          displayName: r.user.displayName,
          avatarUrl: r.user.avatarUrl,
        },
        soundcloudId: r.soundcloudId,
        campaignId: r.campaignId,
        nameChoice: r.nameChoice,
        nameIdea: r.nameIdea,
        featureIdea: r.featureIdea,
        context: r.context,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    logger.error('[admin/rebrand] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to fetch rebrand votes' });
  }
});

/**
 * GET /api/admin/feedback/summary?period=30d&campaignId=<id>
 *
 * RETIRED survey — kept read-only for history. Aggregate counts for the
 * SongSwipe beta survey: interest, Rekordbox use, platform, beta opt-in count.
 */
router.get('/feedback/summary', authenticateUser, adminAuth, async (req, res) => {
  try {
    const period = validPeriod(req.query.period);
    const cutoff = periodToCutoff(period);
    const campaignId = typeof req.query.campaignId === 'string' && req.query.campaignId.trim()
      ? req.query.campaignId.trim()
      : null;

    const where = { createdAt: { gte: cutoff } };
    if (campaignId) where.campaignId = campaignId;

    const [total, byInterest, byRekordbox, byPlatform, wantsBeta] = await Promise.all([
      prisma.betaSignup.count({ where }),
      prisma.betaSignup.groupBy({ by: ['interest'], where, _count: { id: true } }),
      prisma.betaSignup.groupBy({ by: ['rekordboxUse'], where, _count: { id: true } }),
      prisma.betaSignup.groupBy({ by: ['platform'], where, _count: { id: true } }),
      prisma.betaSignup.count({ where: { ...where, wantsBeta: true } }),
    ]);

    const toCounts = (rows, field) => rows.reduce((acc, row) => {
      acc[row[field] ?? 'unanswered'] = row._count.id;
      return acc;
    }, {});

    res.json({
      period,
      campaignId,
      total,
      wantsBetaCount: wantsBeta,
      interest: toCounts(byInterest, 'interest'),
      rekordboxUse: toCounts(byRekordbox, 'rekordboxUse'),
      platform: toCounts(byPlatform, 'platform'),
    });
  } catch (err) {
    logger.error('[admin/feedback/summary] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to fetch feedback summary' });
  }
});

/**
 * GET /api/admin/feedback?period=30d&limit=50&campaignId=<id>
 */
router.get('/feedback', authenticateUser, adminAuth, async (req, res) => {
  try {
    const period = validPeriod(req.query.period);
    const cutoff = periodToCutoff(period);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const campaignId = typeof req.query.campaignId === 'string' && req.query.campaignId.trim()
      ? req.query.campaignId.trim()
      : null;

    const where = { createdAt: { gte: cutoff } };
    if (campaignId) where.campaignId = campaignId;

    const rows = await prisma.betaSignup.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: { select: { username: true, displayName: true, avatarUrl: true } },
      },
    });

    const responses = rows.map(r => ({
      id: r.id,
      user: {
        username: r.user.username,
        displayName: r.user.displayName,
        avatarUrl: r.user.avatarUrl,
      },
      soundcloudId: r.soundcloudId,
      campaignId: r.campaignId,
      email: r.email,
      rekordboxUse: r.rekordboxUse,
      platform: r.platform,
      cullMethod: r.cullMethod,
      featuresWanted: r.featuresWanted,
      editHesitations: r.editHesitations,
      trustDirectWrite: r.trustDirectWrite,
      interest: r.interest,
      wantsBeta: r.wantsBeta,
      wantsCall: r.wantsCall,
      suggestions: r.suggestions,
      nameIdea: r.nameIdea,
      context: r.context,
      createdAt: r.createdAt.toISOString(),
    }));

    res.json({ responses });
  } catch (err) {
    logger.error('[admin/feedback] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to fetch feedback responses' });
  }
});

/**
 * GET /api/admin/feedback/beta-emails?period=30d&campaignId=<id>
 * CSV export of beta opt-ins — the invite list.
 */
router.get('/feedback/beta-emails', authenticateUser, adminAuth, async (req, res) => {
  try {
    const period = validPeriod(req.query.period);
    const cutoff = periodToCutoff(period);
    const campaignId = typeof req.query.campaignId === 'string' && req.query.campaignId.trim()
      ? req.query.campaignId.trim()
      : null;

    const where = { wantsBeta: true, email: { not: null }, createdAt: { gte: cutoff } };
    if (campaignId) where.campaignId = campaignId;

    const rows = await prisma.betaSignup.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        email: true,
        platform: true,
        interest: true,
        wantsCall: true,
        rekordboxUse: true,
        createdAt: true,
      },
    });

    const escape = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['email', 'platform', 'interest', 'wantsCall', 'rekordboxUse', 'createdAt'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.email, r.platform, r.interest, r.wantsCall, r.rekordboxUse, r.createdAt.toISOString(),
      ].map(escape).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="beta-emails.csv"');
    res.send(`﻿${lines.join('\n')}`);
  } catch (err) {
    logger.error('[admin/feedback/beta-emails] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to export beta emails' });
  }
});

/* ------------------------------------------------------------------------ *
 * Feedback inbox — the LIVE in-app feedback form (Feedback model).
 *
 * Named /feedback-items rather than /feedback because /feedback above is
 * already taken by the retired SongSwipe beta survey (BetaSignup), which is
 * kept read-only for history. Two different tables, two different eras; the
 * path spelling is what keeps them from colliding.
 * ------------------------------------------------------------------------ */

/** Page size ceiling, so one query cannot pull the whole table. */
const FEEDBACK_PAGE_SIZE_MAX = 200;
const FEEDBACK_PAGE_SIZE_DEFAULT = 50;

/**
 * Build the Prisma `where` from the query string. Only the two enumerated
 * columns are filterable — an unrecognised value is dropped rather than passed
 * through, so a typo returns everything instead of nothing and no arbitrary
 * string reaches the query.
 */
function feedbackWhere(query) {
  const where = {};
  if (typeof query.status === 'string' && FEEDBACK_STATUSES.includes(query.status)) {
    where.status = query.status;
  }
  if (typeof query.type === 'string' && FEEDBACK_TYPES.includes(query.type)) {
    where.type = query.type;
  }
  return where;
}

/**
 * GET /api/admin/feedback-items?status=&type=&page=1&pageSize=50
 * The inbox itself — newest first, with the sender attached.
 */
router.get('/feedback-items', authenticateUser, adminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const pageSize = Math.min(
      Math.max(parseInt(req.query.pageSize) || FEEDBACK_PAGE_SIZE_DEFAULT, 1),
      FEEDBACK_PAGE_SIZE_MAX
    );
    const where = feedbackWhere(req.query);

    const [rows, total] = await Promise.all([
      prisma.feedback.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { username: true, displayName: true, avatarUrl: true } },
        },
      }),
      prisma.feedback.count({ where }),
    ]);

    res.json({
      items: rows.map(r => ({
        id: r.id,
        type: r.type,
        message: r.message,
        page: r.page,
        email: r.email,
        status: r.status,
        adminNote: r.adminNote,
        clientInfo: r.clientInfo,
        createdAt: r.createdAt.toISOString(),
        user: {
          username: r.user?.username ?? null,
          displayName: r.user?.displayName ?? null,
          avatarUrl: r.user?.avatarUrl ?? null,
        },
        soundcloudId: r.soundcloudId,
      })),
      total,
      page,
      pageSize,
    });
  } catch (err) {
    logger.error('[admin/feedback-items] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

/**
 * GET /api/admin/feedback-items/summary
 * Counts for the inbox header. `unread` is the one that matters day to day.
 */
router.get('/feedback-items/summary', authenticateUser, adminAuth, async (req, res) => {
  try {
    const [total, unread, byStatusRows, byTypeRows] = await Promise.all([
      prisma.feedback.count(),
      prisma.feedback.count({ where: { status: 'new' } }),
      prisma.feedback.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.feedback.groupBy({ by: ['type'], _count: { id: true } }),
    ]);

    // Seed every known key at zero so the client can render a stable set of
    // buckets instead of hiding the ones that happen to be empty today.
    const byStatus = Object.fromEntries(FEEDBACK_STATUSES.map(s => [s, 0]));
    for (const row of byStatusRows) byStatus[row.status] = row._count.id;

    const byType = Object.fromEntries(FEEDBACK_TYPES.map(t => [t, 0]));
    for (const row of byTypeRows) byType[row.type] = row._count.id;

    res.json({ total, unread, byStatus, byType });
  } catch (err) {
    logger.error('[admin/feedback-items/summary] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to fetch feedback summary' });
  }
});

/**
 * PATCH /api/admin/feedback-items/:id
 * Triage only: status and adminNote are the sole writable columns. Nothing the
 * user wrote is editable from here, and an empty patch is refused rather than
 * issued as a no-op write — `updatedAt` is `@updatedAt`, so a write with no
 * changes would still move it and make the row look freshly triaged.
 */
router.patch(
  '/feedback-items/:id',
  authenticateUser,
  adminAuth,
  validateFeedbackPatch,
  async (req, res) => {
    try {
      const data = {};
      if (req.body.status !== undefined) data.status = req.body.status;
      // hasOwn, not truthiness: `adminNote: null` is how a note gets cleared.
      if (Object.hasOwn(req.body, 'adminNote')) data.adminNote = req.body.adminNote ?? null;

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: 'Provide status or adminNote' });
      }

      const updated = await prisma.feedback.update({
        where: { id: req.params.id },
        data,
        select: {
          id: true, type: true, page: true, status: true,
          adminNote: true, createdAt: true, updatedAt: true,
        },
      });

      res.json(updated);
    } catch (err) {
      // Prisma "record not found" — a stale row in an open inbox tab.
      if (err && err.code === 'P2025') {
        return res.status(404).json({ error: 'Feedback not found' });
      }
      logger.error('[admin/feedback-items/:id] Error:', safeError(err));
      res.status(500).json({ error: 'Failed to update feedback' });
    }
  }
);

/**
 * GET /api/admin/feedback-items.csv?status=
 * The whole filtered set as a CSV attachment, for reading somewhere other than
 * the dashboard. Leading BOM so Excel opens the UTF-8 as UTF-8.
 */
router.get('/feedback-items.csv', authenticateUser, adminAuth, async (req, res) => {
  try {
    const where = feedbackWhere(req.query);

    const rows = await prisma.feedback.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { username: true } },
      },
    });

    // Same shape as the beta-emails export, plus a formula guard: `message`
    // and `adminNote` are free text, and Excel / Sheets / LibreOffice execute
    // a cell that opens with =, +, -, @, tab or CR. Prefixing an apostrophe
    // makes the cell literal text; the apostrophe is not shown by the
    // spreadsheet and the raw CSV still reads plainly.
    const escape = (v) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      // \r joins the class: a lone CR is a row break to some parsers, so a
      // message containing one must stay inside its quoted field.
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      'id', 'createdAt', 'type', 'status', 'username', 'soundcloudId',
      'page', 'email', 'message', 'adminNote',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.id, r.createdAt.toISOString(), r.type, r.status, r.user?.username ?? '',
        r.soundcloudId, r.page, r.email, r.message, r.adminNote,
      ].map(escape).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="feedback.csv"');
    res.send(`﻿${lines.join('\n')}`);
  } catch (err) {
    logger.error('[admin/feedback-items.csv] Error:', safeError(err));
    res.status(500).json({ error: 'Failed to export feedback' });
  }
});

export default router;
