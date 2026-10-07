import express from 'express';
import { soundcloudClient, fetchWithTimeout } from '../lib/soundcloud-client.js';
import prisma from '../lib/prisma.js';
import { heavyOperationRateLimiter, libraryReadRateLimiter } from '../middleware/rateLimiter.js';
import { authenticateUser } from '../middleware/auth.js';
import { logOperation, startOperationTimer, extractClientInfo, instrumentRead } from '../lib/analytics.js';
import { harvestTracks, harvestPlaylists } from '../lib/catalog.js';
import { piggybackEnrichment } from '../lib/enrichment.js';
import logger from '../lib/logger.js';
import {
  sleep,
  SC_WRITE_PACING_MS,
  SC_PLAYLIST_PACING_MS,
  SC_BULK_PACING_MS,
  SC_READ_CONCURRENCY,
  mapWithConcurrency,
} from '../lib/pacing.js';
import { extractNumericId, normalizeResource, normalizeResourceV2, normalizeTrackForLibraryBrowser, normalizePlaylistForLibraryBrowser } from '../lib/normalize.js';
import { getCachedResolve, setCachedResolve } from '../lib/resolve-cache.js';
import {
  CACHE_TTL,
  getCachedUserPayload,
  loadCachedFollowings,
  loadCachedFollowers,
  loadCachedPlaylists,
  loadCachedMe,
  loadUserCollection,
  invalidateUserCollections,
  invalidatePlaylistState,
} from '../lib/social-cache.js';
import { safeError } from '../lib/safe-error.js';
import { isAllowedDownloadRedirectTarget, isAllowedDownloadUrl } from '../lib/download-utils.js';
import { buildDashboardSummary } from '../lib/dashboard-summary.js';
import { summarizeLibraryAudit } from '../lib/library-audit.js';
import { pagePlaylistsWithTracks } from '../lib/playlist-pages.js';
import { comparePlaylists } from '../lib/playlist-compare.js';
import {
  duplicateTrackBetweenPlaylists,
  moveTrackBetweenPlaylists,
  readPlaylistForRewrite,
  writeGrowingPrefix,
  assertAppendable,
  PlaylistReadIncompleteError,
  PlaylistTooLargeError,
  MAX_PLAYLIST_TRACKS,
} from '../lib/playlist-transfer.js';
import {
  parseKeywords,
  searchTracksInPlaylists,
  removeTrackIds,
  appendTrackIds,
} from '../lib/playlist-search.js';
import { requestCache } from '../lib/request-cache.js';
import { mergeIntoExisting, splitIntoChunks } from '../lib/merge-utils.js';
import {
  validatePlaylistId,
  validateResolve,
  validateMergePlaylists,
  validateUpdatePlaylist,
  validateGetPlaylist,
  validatePlaylistTrackTransfer,
  validateCreateFromLikes,
  validateLikesPagination,
  validateOffsetPagination,
  validateBatchResolve,
  validateActivities,
  validateBulkUnlike,
  validateBulkLike,
  validateBulkUnfollow,
  validateBulkUnrepost,
  validateClonePlaylist,
  validateCloneFollowedPlaylists,
  validateCreateFromFollowedLikes,
  validateFollowedUserLibraryPagination,
  validateFollowingUserId,
  validateTrackSearch,
  validateDeletePlaylist,
  validateEvent,
  validateLibraryAudit,
  validatePlaylistTrackSearch,
  validateBulkRemovePlaylistTracks,
  validateBulkAddPlaylistTracks,
} from '../middleware/validation.js';
const router = express.Router();

// The domain moves with the Azure cutover (docs/internal/MIGRATION.md work item 4): the
// apex is canonical, and every soundcloudtoolkit.com host 301s to it via
// server/middleware/legacy-redirect.js.
const TRACK_TOOLKIT_PLAYLIST_SITE = 'tracktoolkit.com';

/**
 * Ceiling on the matches one keyword search returns.
 *
 * A one-letter term against fifty full playlists can match tens of thousands
 * of tracks; serialising and rendering that is a slow response and a slower
 * page, for a result nobody can act on — the bulk endpoints cap out at 200
 * tracks anyway. Over the cap the client is told to narrow the search rather
 * than handed a truncated list it thinks is complete.
 */
const MAX_SEARCH_MATCHES = 2000;
const TRACK_TOOLKIT_PLAYLIST_FOOTER = `Created using Track Toolkit. Try it for free ${TRACK_TOOLKIT_PLAYLIST_SITE}`;

/** Operation summary only; standard toolkit footer is appended for SoundCloud playlist descriptions. */
function playlistDescriptionWithToolkit(operationDescription) {
  const body = String(operationDescription ?? '').trim();
  return `${body}\n\n${TRACK_TOOLKIT_PLAYLIST_FOOTER}`;
}

/**
 * Whether a failed authenticated resolve is worth retrying against the public
 * endpoint. Rate limiting and timeouts are properties of the connection, not
 * of our credentials, so retrying them publicly just spends the budget twice
 * on the request that was already struggling.
 */
const OEMBED_TIMEOUT_MS = 4000;

function shouldRetryPublicly(error) {
  const message = String(error?.message || '');
  if (error?.name === 'AbortError' || /abort/i.test(message)) return false;
  if (/\b429\b/.test(message)) return false;
  if (/\b5\d\d\b/.test(message)) return false;
  return true;
}

function sanitizeUrl(input = '') {
  let url = String(input).trim();
  if (!url) return '';
  // Add scheme if missing
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const u = new URL(url);
    // Only allow soundcloud domains
    const host = u.hostname.toLowerCase();
    if (!/(^|\.)soundcloud\.com$/.test(host) && host !== 'on.soundcloud.com') return '';
    // Strip tracking params
    const toRemove = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'si'];
    toRemove.forEach((k) => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return '';
  }
}

function nowIso() {
  return new Date().toISOString();
}

function isResolveV2(req) {
  const queryVersion = String(req.query?.v || '').trim();
  const headerVersion = String(req.get('x-resolve-version') || '').trim();
  return queryVersion === '2' || headerVersion === '2';
}

function getPlayableTrackIds(tracks = []) {
  const seen = new Set();
  const ids = [];
  for (const track of tracks) {
    const id = extractNumericId(track?.id || track?.urn);
    if (!id || track?.blocked_at || track?.streamable === false || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function assertFollowedUser(req, targetUserId) {
  // Must go through the cache, not the raw client: this authorization check
  // runs before EVERY followed-library page fetch, and a raw call re-crawls
  // the whole followings list each time — 10+ SoundCloud round trips to
  // authorize a request that returns 50 items.
  const payload = await loadCachedFollowings(req);
  const followings = Array.isArray(payload?.collection) ? payload.collection : [];
  const followed = followings.find((user) => Number(user?.id) === Number(targetUserId));
  if (!followed) {
    const error = new Error('Followed user not found');
    error.status = 403;
    throw error;
  }
  return followed;
}


/**
 * GET /api/me
 * Get current user information
 */
router.get('/me', authenticateUser, instrumentRead('me'), async (req, res) => {
  try {
    const userInfo = await loadCachedMe(req);
    res.json(userInfo);
  } catch (error) {
    logger.error('Get me error:', safeError(error));
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

router.get('/dashboard/summary', authenticateUser, instrumentRead('dashboard-summary'), async (req, res) => {
  try {
    // Shares the cache entry with GET /api/me — the dashboard load previously
    // fetched this profile twice.
    const me = await loadCachedMe(req);
    const userId = req.user.id;
    const likesCount = me?.public_favorites_count ?? me?.likes_count;

    const needsFollowers = !(typeof me?.followers_count === 'number' && me.followers_count > 0);
    const needsFollowings = !(typeof me?.followings_count === 'number' && me.followings_count > 0);
    const needsLikes = !(typeof likesCount === 'number' && likesCount > 0);
    const needsPlaylists = !(typeof me?.playlist_count === 'number' && me.playlist_count > 0);

    const [followers, followings, likes, playlists] = await Promise.all([
      needsFollowers
        ? getCachedUserPayload(
            'followers',
            userId,
            'default',
            async () => {
              const collection = await soundcloudClient.getFollowers(req.accessToken, req.refreshToken);
              return { collection, total: collection.length };
            },
            CACHE_TTL.followers,
          )
        : Promise.resolve(undefined),
      needsFollowings
        ? getCachedUserPayload(
            'followings',
            userId,
            'default',
            async () => {
              const collection = await soundcloudClient.getFollowings(req.accessToken, req.refreshToken);
              return { collection, total: collection.length };
            },
            CACHE_TTL.followings,
          )
        : Promise.resolve(undefined),
      needsLikes
        ? getCachedUserPayload(
            'likes',
            userId,
            'default',
            async () => {
              const collection = await soundcloudClient.paginate(
                '/me/likes/tracks',
                req.accessToken,
                req.refreshToken,
                200,
              ).catch(() => soundcloudClient.paginate(
                '/me/favorites',
                req.accessToken,
                req.refreshToken,
                200,
              ));
              return { collection, total_results: collection.length };
            },
            CACHE_TTL.likes,
          )
        : Promise.resolve(undefined),
      needsPlaylists
        ? getCachedUserPayload(
            'playlists',
            userId,
            // Same key as GET /api/playlists so a dashboard load warms the
            // playlists page and vice versa. These were 'default' and
            // 'limit=50&offset=0', which meant two entries for overlapping
            // data and no sharing between them.
            'default',
            async () => {
              const playlists = await soundcloudClient.getAllPlaylists(req.accessToken, req.refreshToken);
              const collection = playlists.map((p) => {
                const idNum = typeof p.id === 'string' ? parseInt(p.id, 10) : p.id;
                return { ...p, id: idNum, coverUrl: p.artwork_url || p.user?.avatar_url || '' };
              });
              return { collection, total: collection.length };
            },
            CACHE_TTL.playlists,
          )
        : Promise.resolve(undefined),
    ]);

    res.json(buildDashboardSummary({ me, followers, followings, likes, playlists }));
  } catch (error) {
    logger.error('Dashboard summary error:', safeError(error));
    res.status(500).json({ error: 'Failed to fetch dashboard summary' });
  }
});

router.get('/library/audit', authenticateUser, instrumentRead('library-audit'), libraryReadRateLimiter, validateLibraryAudit, async (req, res) => {
  try {
    const limit = req.query.limit ?? 20;
    const offset = req.query.offset ?? 0;
    // Auditing pulls every playlist's full track list, so it works a page at a
    // time. offset is what lets a user walk a library bigger than one page —
    // playlists 20-40, then 40-60, and so on. The page is a slice of the cached
    // full playlist list, not a SoundCloud offset query; see playlist-pages.js.
    const { playlists: fullPlaylists, failed, page } = await pagePlaylistsWithTracks(req, { limit, offset });

    harvestTracks(fullPlaylists.flatMap(p => (Array.isArray(p.tracks) ? p.tracks : [])));
    harvestPlaylists(fullPlaylists);
    const audit = summarizeLibraryAudit(fullPlaylists);
    audit.page = page;
    // Playlists whose read failed are named rather than dropped: an audit that
    // silently skipped three playlists reads as a clean bill of health.
    audit.failed = failed;
    logOperation({
      req,
      action: 'library-audit',
      itemCount: audit.summary.playlists,
      trackCount: audit.summary.tracks,
      status: 'success',
      playlistIds: audit.playlists.map(p => p.id).filter(id => id != null),
      // Flagged tracks only — the full library would blow the row cap
      trackIds: audit.playlists.flatMap(p => p.issues.map(i => i.trackId)).filter(id => id != null),
      metadata: {
        duplicates: audit.summary.duplicates,
        unavailable: audit.summary.unavailable,
      },
    });
    res.json(audit);
  } catch (error) {
    logger.error('Library audit error:', safeError(error));
    res.status(500).json({ error: 'Failed to audit library' });
  }
});

/**
 * GET /api/playlists/search-tracks?q=&playlistId=&limit=&offset=
 *
 * Find tracks by keyword across playlist track lists. Comma-separated terms
 * are OR'd. Without playlistId it walks the library a page at a time (same
 * shape as the audit); with one it searches just that playlist.
 */
router.get('/playlists/search-tracks', authenticateUser, instrumentRead('playlist-keyword-search'), libraryReadRateLimiter, validatePlaylistTrackSearch, async (req, res) => {
  try {
    const keywords = parseKeywords(req.query.q);
    if (keywords.length === 0) {
      return res.status(400).json({ error: 'Enter at least one keyword' });
    }

    // `??` would keep an empty string here: validatePlaylistTrackSearch uses
    // checkFalsy, so `?playlistId=` skips validation entirely and arrives as
    // ''. `||` collapses that to "not scoped" instead of scoping the search to
    // a playlist id of ''.
    const singlePlaylistId = req.query.playlistId || null;
    const limit = req.query.limit ?? 20;
    const offset = req.query.offset ?? 0;

    let fullPlaylists;
    let failed = [];
    let page = null;

    if (singlePlaylistId !== null) {
      // Scoped to one playlist: no library listing, and no page — the client
      // has nothing to walk.
      try {
        fullPlaylists = [
          await soundcloudClient.getPlaylistWithTracks(req.accessToken, req.refreshToken, singlePlaylistId),
        ];
      } catch (error) {
        logger.warn('Keyword search playlist fetch failed:', { playlistId: singlePlaylistId, error: safeError(error) });
        fullPlaylists = [];
        failed = [{ id: singlePlaylistId, title: null }];
      }
    } else {
      // A slice of the cached full playlist list, with each playlist's tracks
      // fetched concurrently. See playlist-pages.js for why not an offset query.
      const paged = await pagePlaylistsWithTracks(req, { limit, offset });
      fullPlaylists = paged.playlists;
      failed = paged.failed;
      page = paged.page;
    }

    const { matches: allMatches, stats } = searchTracksInPlaylists(fullPlaylists, keywords);
    // stats keeps the true count; `matches` is what the client can act on.
    const capped = allMatches.length > MAX_SEARCH_MATCHES;
    const matches = capped ? allMatches.slice(0, MAX_SEARCH_MATCHES) : allMatches;
    // A search that could not read three playlists is not the same answer as
    // one that read them and found nothing; the client says so either way.
    stats.playlistsFailed = failed.length;

    logOperation({
      req,
      action: 'playlist-keyword-search',
      itemCount: stats.playlistsSearched,
      trackCount: stats.matchCount,
      status: 'success',
      playlistIds: fullPlaylists.map(p => p.id).filter(id => id != null),
      metadata: { keywords: keywords.length, scoped: singlePlaylistId !== null },
    });

    res.json({ keywords, matches, stats, failed, capped, page });
  } catch (error) {
    logger.error('Playlist keyword search error:', safeError(error));
    res.status(500).json({ error: 'Failed to search playlists' });
  }
});

/**
 * POST /api/playlists/tracks/bulk-remove
 * Body: { items: [{ playlistId, trackIds: [] }] }
 *
 * Removes tracks from playlists by PUTting each playlist's surviving track
 * list. Per-playlist status is returned so a partial failure is visible rather
 * than silent.
 */
router.post('/playlists/tracks/bulk-remove', authenticateUser, heavyOperationRateLimiter, validateBulkRemovePlaylistTracks, async (req, res) => {
  const elapsed = startOperationTimer();
  try {
    const { items } = req.body;

    // Phase 1 — read every playlist, concurrently. The reads are independent
    // of each other and of the writes, so the old read/write/sleep cycle paid
    // twenty round trips end to end before the second write even started, all
    // inside one held-open response.
    const prepared = await mapWithConcurrency(items, SC_READ_CONCURRENCY, async (item) => {
      const { playlistId, trackIds } = item;
      try {
        // Refuses rather than PUTting a list we only partly have — see
        // readPlaylistForRewrite. Removing one track from a short read would
        // silently delete every entry the read dropped.
        const { playlist, ids: currentIds } = await readPlaylistForRewrite(
          soundcloudClient, req.accessToken, req.refreshToken, playlistId,
        );
        const nextIds = removeTrackIds(currentIds, trackIds);
        return {
          playlistId,
          title: playlist.title ?? null,
          nextIds,
          removed: currentIds.length - nextIds.length,
        };
      } catch (error) {
        // A short read is already logged by readPlaylistForRewrite.
        if (!(error instanceof PlaylistReadIncompleteError)) {
          logger.warn('Bulk remove read failed for playlist:', { playlistId, error: safeError(error) });
        }
        return {
          playlistId,
          error: error instanceof PlaylistReadIncompleteError
            ? error.message
            : 'Could not update this playlist',
        };
      }
    });

    // Phase 2 — the writes, still sequential and still paced. Pacing exists so
    // a burst of playlist PUTs does not draw a 429, which means it belongs
    // BETWEEN writes: never after a row that was skipped or failed its read (no
    // request was made, so there is nothing to pace away from) and never after
    // the last one, where it only delays the response by 300ms per batch.
    const results = [];
    let removedTotal = 0;
    let wroteAny = false;

    for (const entry of prepared) {
      if (entry.error) {
        results.push({ playlistId: entry.playlistId, status: 'error', removed: 0, error: entry.error });
        continue;
      }

      if (entry.removed === 0) {
        results.push({
          playlistId: entry.playlistId,
          status: 'skipped',
          removed: 0,
          title: entry.title,
          message: 'None of those tracks are in this playlist any more',
        });
        continue;
      }

      if (wroteAny) await sleep(SC_WRITE_PACING_MS);
      // Set before the attempt, not after it: a PUT that failed still cost
      // SoundCloud a request, and a 429 is precisely when the next one should
      // wait.
      wroteAny = true;

      try {
        await soundcloudClient.addTracksToPlaylist(
          req.accessToken,
          req.refreshToken,
          entry.playlistId,
          entry.nextIds
        );

        removedTotal += entry.removed;
        results.push({
          playlistId: entry.playlistId,
          status: 'success',
          removed: entry.removed,
          remaining: entry.nextIds.length,
          title: entry.title,
        });
      } catch (error) {
        logger.warn('Bulk remove write failed for playlist:', { playlistId: entry.playlistId, error: safeError(error) });
        results.push({
          playlistId: entry.playlistId,
          status: 'error',
          removed: 0,
          error: 'Could not update this playlist',
        });
      }
    }

    invalidatePlaylistState(req.user.id);

    logOperation({
      req,
      action: 'playlist-bulk-remove-tracks',
      itemCount: items.length,
      trackCount: removedTotal,
      status: results.some(r => r.status === 'error') ? 'partial' : 'success',
      durationMs: elapsed(),
      playlistIds: items.map(i => i.playlistId),
      trackIds: items.flatMap(i => i.trackIds),
    });

    res.json({ results, removedTotal });
  } catch (error) {
    logger.error('Bulk remove playlist tracks error:', safeError(error));
    res.status(500).json({ error: 'Failed to remove tracks' });
  }
});

/**
 * POST /api/playlists/tracks/bulk-add
 * Body: { targetPlaylistId, trackIds: [] }
 *
 * Appends tracks to one existing playlist, skipping ones already there and
 * stopping at SoundCloud's 500-track ceiling.
 */
router.post('/playlists/tracks/bulk-add', authenticateUser, heavyOperationRateLimiter, validateBulkAddPlaylistTracks, async (req, res) => {
  const elapsed = startOperationTimer();
  try {
    const { targetPlaylistId, trackIds } = req.body;

    // Appending to a short read would drop whatever the read missed, so a
    // playlist we cannot fully see is refused outright.
    let target;
    let existingIds;
    try {
      ({ playlist: target, ids: existingIds } = await readPlaylistForRewrite(
        soundcloudClient, req.accessToken, req.refreshToken, targetPlaylistId,
      ));
    } catch (error) {
      if (error instanceof PlaylistReadIncompleteError) {
        return res.status(409).json({ error: error.message });
      }
      throw error;
    }
    const { nextIds, added, alreadyPresent, noRoom } = appendTrackIds(
      existingIds,
      trackIds,
      MAX_PLAYLIST_TRACKS
    );

    if (added.length === 0) {
      return res.json({
        targetPlaylistId,
        targetTitle: target.title ?? null,
        added: 0,
        alreadyPresent: alreadyPresent.length,
        noRoom: noRoom.length,
        total: existingIds.length,
        message: noRoom.length
          ? `Playlist is full (${MAX_PLAYLIST_TRACKS} tracks max)`
          : 'Every one of those tracks is already in this playlist',
      });
    }

    await soundcloudClient.addTracksToPlaylist(
      req.accessToken,
      req.refreshToken,
      targetPlaylistId,
      nextIds
    );

    invalidatePlaylistState(req.user.id);

    logOperation({
      req,
      action: 'playlist-bulk-add-tracks',
      itemCount: 1,
      trackCount: added.length,
      status: 'success',
      durationMs: elapsed(),
      playlistIds: [targetPlaylistId],
      trackIds: added,
    });

    res.json({
      targetPlaylistId,
      targetTitle: target.title ?? null,
      added: added.length,
      alreadyPresent: alreadyPresent.length,
      noRoom: noRoom.length,
      total: nextIds.length,
    });
  } catch (error) {
    logger.error('Bulk add playlist tracks error:', safeError(error));
    res.status(500).json({ error: 'Failed to add tracks' });
  }
});

router.post('/playlists/compare', authenticateUser, heavyOperationRateLimiter, async (req, res) => {
  try {
    const playlistAId = Number(req.body?.playlistAId);
    const playlistBId = Number(req.body?.playlistBId);
    if (!Number.isInteger(playlistAId) || playlistAId < 1 || !Number.isInteger(playlistBId) || playlistBId < 1) {
      return res.status(400).json({ error: 'playlistAId and playlistBId are required positive integers' });
    }
    if (playlistAId === playlistBId) {
      return res.status(400).json({ error: 'Choose two different playlists to compare' });
    }

    const [playlistA, playlistB] = await Promise.all([
      soundcloudClient.getPlaylistWithTracks(req.accessToken, req.refreshToken, playlistAId),
      soundcloudClient.getPlaylistWithTracks(req.accessToken, req.refreshToken, playlistBId),
    ]);

    harvestTracks([
      ...(Array.isArray(playlistA.tracks) ? playlistA.tracks : []),
      ...(Array.isArray(playlistB.tracks) ? playlistB.tracks : []),
    ]);
    harvestPlaylists([playlistA, playlistB]);
    const comparison = comparePlaylists(playlistA, playlistB);
    logOperation({
      req,
      action: 'playlist-compare',
      playlistIds: [playlistAId, playlistBId],
      itemCount: 2,
      trackCount: comparison.summary.playlistA.trackCount + comparison.summary.playlistB.trackCount,
      status: 'success',
      metadata: {
        commonTrackCount: comparison.summary.overlapCount,
        uniqueA: comparison.summary.uniqueToACount,
        uniqueB: comparison.summary.uniqueToBCount,
      },
    });
    res.json(comparison);
  } catch (error) {
    logger.error('Playlist compare error:', safeError(error));
    res.status(500).json({ error: 'Failed to compare playlists' });
  }
});

/**
 * GET /api/playlists
 * Get all of the user's playlists (fully paginated — see getAllPlaylists)
 */
router.get('/playlists', authenticateUser, instrumentRead('playlists'), async (req, res) => {
  try {
    // One definition, in social-cache.js: the paged tools slice this same
    // cached list rather than running their own query.
    const withCovers = await loadCachedPlaylists(req);
    res.json(withCovers);
  } catch (error) {
    logger.error('Get playlists error:', safeError(error));
    res.status(500).json({ error: 'Failed to get playlists' });
  }
});

/**
 * POST /api/playlists/clone
 * Clones another user's playlist to the current user's account
 */
router.post('/playlists/clone', authenticateUser, heavyOperationRateLimiter, validateClonePlaylist, async (req, res) => {
  try {
    const { url, title } = req.body;
    const cleaned = sanitizeUrl(url);

    // 1. Resolve URL
    let resource;
    try {
      resource = await soundcloudClient.resolveAny(req.accessToken, req.refreshToken, cleaned);
    } catch (e) {
      if (String(e?.message).includes('401')) {
        resource = await soundcloudClient.resolvePublic(cleaned);
      } else {
        throw e;
      }
    }

    if (resource.kind !== 'playlist') {
      return res.status(400).json({ error: 'URL must point to a playlist.' });
    }

    const sourceId = extractNumericId(resource.id || resource.urn);

    // 2. Fetch full playlist containing all tracks
    const playlist = await soundcloudClient.getPlaylistWithTracks(
      req.accessToken,
      req.refreshToken,
      sourceId
    );

    const all = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    const filtered = all.filter(t => t && !t.blocked_at && t.streamable !== false);
    harvestTracks(all);
    harvestPlaylists([playlist]);
    const trackIdsArray = filtered.map(t => t.id).filter(id => id != null);

    if (trackIdsArray.length === 0) {
      return res.status(400).json({ error: 'Playlist has no streamable tracks to clone.' });
    }

    // Helper to slow down between API calls
    const baseTitle = title || `Clone of ${playlist.title}`;

    if (trackIdsArray.length > 500) {
      const numPlaylists = Math.ceil(trackIdsArray.length / 500);
      const createdPlaylists = [];

      for (let i = 0; i < numPlaylists; i++) {
        const startIdx = i * 500;
        const endIdx = Math.min(startIdx + 500, trackIdsArray.length);
        const batch = trackIdsArray.slice(startIdx, endIdx);
        
        const playlistTitle = numPlaylists > 1 
          ? `${baseTitle} (${i + 1}/${numPlaylists})`
          : baseTitle;

        const mergeBatchSize = 100;
        const initialBatch = batch.slice(0, mergeBatchSize);
        const newPlaylist = await soundcloudClient.createPlaylist(
          req.accessToken,
          req.refreshToken,
          playlistTitle,
          playlistDescriptionWithToolkit(`Cloned from ${cleaned}`),
          initialBatch
        );

        await sleep(SC_PLAYLIST_PACING_MS);

        let addIndex = mergeBatchSize;
        while (addIndex < batch.length) {
          await sleep(SC_WRITE_PACING_MS);
          const addBatch = batch.slice(0, addIndex + mergeBatchSize);
          await soundcloudClient.addTracksToPlaylist(
            req.accessToken,
            req.refreshToken,
            newPlaylist.id,
            addBatch
          );
          addIndex += mergeBatchSize;
        }

        createdPlaylists.push({
          playlist: newPlaylist,
          partNumber: i + 1
        });

        if (i < numPlaylists - 1) {
          await sleep(SC_PLAYLIST_PACING_MS);
        }
      }

      logOperation({
        req,
        action: 'clone',
        playlistIds: [sourceId, ...createdPlaylists.map((p) => p.playlist.id)],
        trackIds: trackIdsArray,
        trackCount: trackIdsArray.length,
        status: 'split',
        metadata: { sourcePlaylistId: sourceId, numPlaylistsCreated: numPlaylists },
      });
      invalidatePlaylistState(req.user.id);
      res.json({
        playlists: createdPlaylists.map(p => p.playlist),
        stats: {
          totalTracks: trackIdsArray.length,
          numPlaylistsCreated: numPlaylists,
        }
      });
    } else {
      const mergeBatchSize = 100;
      const initialBatch = trackIdsArray.slice(0, mergeBatchSize);
      const newPlaylist = await soundcloudClient.createPlaylist(
        req.accessToken,
        req.refreshToken,
        baseTitle,
        playlistDescriptionWithToolkit(`Cloned from ${cleaned}`),
        initialBatch
      );

      await sleep(SC_PLAYLIST_PACING_MS);

      let addIndex = mergeBatchSize;
      while (addIndex < trackIdsArray.length) {
        await sleep(SC_WRITE_PACING_MS);
        const addBatch = trackIdsArray.slice(0, addIndex + mergeBatchSize);
        await soundcloudClient.addTracksToPlaylist(
          req.accessToken,
          req.refreshToken,
          newPlaylist.id,
          addBatch
        );
        addIndex += mergeBatchSize;
      }

      logOperation({
        req,
        action: 'clone',
        playlistIds: [sourceId, newPlaylist.id],
        trackIds: trackIdsArray,
        trackCount: trackIdsArray.length,
        status: 'success',
        metadata: { sourcePlaylistId: sourceId, createdPlaylistId: newPlaylist.id },
      });
      invalidatePlaylistState(req.user.id);
      res.json({
        playlist: newPlaylist,
        stats: {
          totalTracks: trackIdsArray.length,
        }
      });
    }
  } catch (error) {
    logger.error('Clone playlist error:', safeError(error));
    if (String(error?.message).includes('404')) {
      return res.status(404).json({ error: 'Source playlist not found or private.' });
    }
    res.status(500).json({ error: 'Failed to clone playlist' });
  }
});

/**
 * POST /api/playlists/transfer-track
 * Move or duplicate a single track to another playlist (user's own playlists only).
 * Body: { action: 'move' | 'duplicate', trackId, sourcePlaylistId, targetPlaylistId }
 */
router.post(
  '/playlists/transfer-track',
  authenticateUser,
  heavyOperationRateLimiter,
  validatePlaylistTrackTransfer,
  async (req, res) => {
    const { action, trackId, sourcePlaylistId, targetPlaylistId } = req.body;
    const client = soundcloudClient;

    try {
      if (action === 'duplicate') {
        const result = await duplicateTrackBetweenPlaylists({
          accessToken: req.accessToken,
          refreshToken: req.refreshToken,
          client,
          trackId,
          targetPlaylistId,
        });

        if (result.ok) {
          logOperation({
            userId: req.user.id,
            action: 'playlist-transfer',
            trackCount: result.noop ? 0 : 1,
            status: 'success',
            trackIds: [trackId],
            playlistIds: [targetPlaylistId],
            metadata: { kind: 'duplicate', noop: !!result.noop },
          });
          invalidatePlaylistState(req.user.id);
          return res.json(result);
        }

        return res.status(400).json(result);
      }

      if (action === 'move') {
        const result = await moveTrackBetweenPlaylists({
          accessToken: req.accessToken,
          refreshToken: req.refreshToken,
          client,
          trackId,
          sourcePlaylistId,
          targetPlaylistId,
        });

        if (result.ok) {
          logOperation({
            userId: req.user.id,
            action: 'playlist-transfer',
            trackCount: 1,
            status: 'success',
            trackIds: [trackId],
            playlistIds: [sourcePlaylistId, targetPlaylistId],
            metadata: { kind: 'move' },
          });
          invalidatePlaylistState(req.user.id);
          return res.json(result);
        }

        if (result.partial) {
          logOperation({
            userId: req.user.id,
            action: 'playlist-transfer',
            trackCount: 1,
            status: 'error',
            trackIds: [trackId],
            playlistIds: [sourcePlaylistId, targetPlaylistId],
            metadata: { kind: 'move', partial: true, stage: result.stage },
          });
          return res.json(result);
        }

        const status = result.error && result.error.includes('not in the source') ? 404 : 400;
        return res.status(status).json(result);
      }

      return res.status(400).json({ ok: false, error: 'Invalid action' });
    } catch (error) {
      // A short read is a refusal with a reason, not a failure: the same 409
      // bulk-add and PUT /playlists/:id return, so the client can show it.
      if (error instanceof PlaylistReadIncompleteError) {
        return res.status(409).json({ ok: false, error: error.message });
      }
      logger.error('Playlist transfer error:', safeError(error));
      res.status(500).json({ ok: false, error: 'Playlist transfer failed' });
    }
  }
);

/**
 * GET /api/playlists/:id
 * Return single playlist with tracks included
 */
router.get('/playlists/:id', authenticateUser, validateGetPlaylist, async (req, res) => {
  try {
    const id = req.params.id; // Already validated and converted to int by middleware
    // `?access=all` includes blocked tracks. Pages that write the list back
    // opt in so what they show matches what the server will compare against.
    const allAccess = req.query.access === 'all';
    const playlist = await soundcloudClient.getPlaylistWithTracks(
      req.accessToken,
      req.refreshToken,
      id,
      allAccess ? { allAccess: true } : undefined
    );
    harvestTracks(Array.isArray(playlist.tracks) ? playlist.tracks : []);
    harvestPlaylists([playlist]);
    res.json(playlist);
  } catch (error) {
    logger.error('Get playlist with tracks error:', safeError(error));
    res.status(500).json({ error: 'Failed to get playlist' });
  }
});

/**
 * PUT /api/playlists/:id
 * Update playlist order/title by sending full track list
 * Body: { tracks: number[]; remove?: number[]; title?: string }
 *
 * `remove` is the ids the client is deliberately taking out. A track may leave
 * the playlist only if the client named it, so after the guarded all-access
 * read the write is refused with 409 when:
 *   - the read is short of track_count:
 *     { code: 'PLAYLIST_READ_INCOMPLETE', error, seen, expected }
 *   - the server read more copies of an id than `tracks` carries and the id is
 *     not in `remove` (counts matter, so a dropped duplicate copy is refused):
 *     { code: 'PLAYLIST_OUT_OF_SYNC', error, undeclared }
 * Ids in `tracks` the server did not read are appends; ids in `remove` it did
 * not read are ignored. An id in both lists is a 400.
 */
router.put('/playlists/:id', authenticateUser, validateUpdatePlaylist, async (req, res) => {
  try {
    const id = req.params.id; // Already validated and converted to int by middleware
    const { title } = req.body || {};
    const toId = (v) => (typeof v === 'string' ? parseInt(v, 10) : v);
    const tracks = (req.body?.tracks || []).map(toId);
    const remove = (req.body?.remove || []).map(toId);

    // The client sends a full replacement list it derived from its own read of
    // this playlist. If OUR read comes back short of the playlist's own
    // track_count, the client's almost certainly did too — and PUTting that
    // list would permanently delete whatever both reads dropped. Refuse
    // instead; the read costs one round trip and the write is irreversible.
    let serverIds;
    try {
      ({ ids: serverIds } = await readPlaylistForRewrite(
        soundcloudClient, req.accessToken, req.refreshToken, id,
      ));
    } catch (error) {
      if (error instanceof PlaylistReadIncompleteError) {
        return res.status(409).json({
          code: 'PLAYLIST_READ_INCOMPLETE',
          error: error.message,
          seen: error.seen,
          expected: error.expected,
        });
      }
      throw error;
    }

    // A track may only leave the playlist if the client named it. Anything the
    // server read that is in neither list is something this client never saw
    // (it changed on SoundCloud, or the page's read was narrower than ours),
    // and writing the list back would delete it. Ids in `tracks` the server
    // did not read are appends; ids in `remove` it did not read are ignored.
    // Count-aware: a playlist can hold the same track twice, and writing back
    // one copy would delete the other.
    const removeSet = new Set(remove);
    const clientCounts = new Map();
    for (const trackId of tracks) clientCounts.set(trackId, (clientCounts.get(trackId) || 0) + 1);
    const serverCounts = new Map();
    for (const trackId of serverIds) serverCounts.set(trackId, (serverCounts.get(trackId) || 0) + 1);
    let undeclared = 0;
    for (const [trackId, serverCount] of serverCounts) {
      if (removeSet.has(trackId)) continue;
      undeclared += Math.max(0, serverCount - (clientCounts.get(trackId) || 0));
    }
    if (undeclared > 0) {
      return res.status(409).json({
        code: 'PLAYLIST_OUT_OF_SYNC',
        error: `This playlist has ${undeclared} track${undeclared === 1 ? '' : 's'} this page didn't load (it may have changed on SoundCloud). Reload and try again. Nothing was changed.`,
        undeclared,
      });
    }

    // Reuse addTracksToPlaylist to overwrite order by sending full list
    const updated = await soundcloudClient.addTracksToPlaylist(
      req.accessToken,
      req.refreshToken,
      id,
      tracks
    );

    // Optionally update title if provided and different
    if (title && title !== updated.title) {
      try {
        await soundcloudClient.addTracksToPlaylist(
          req.accessToken,
          req.refreshToken,
          id,
          tracks
        );
      } catch {}
    }

    invalidatePlaylistState(req.user.id);
    res.json(updated);
  } catch (error) {
    logger.error('Update playlist error:', safeError(error));
    res.status(500).json({ error: 'Failed to update playlist' });
  }
});

/**
 * GET /api/likes
 * Get user's liked tracks
 */
router.get('/likes', authenticateUser, instrumentRead('likes'), async (req, res) => {
  try {
    const payload = await loadUserCollection(
      req,
      'likes',
      async () => {
        const items = await soundcloudClient.paginate(
          '/me/likes/tracks',
          req.accessToken,
          req.refreshToken,
          200
        ).catch(() => soundcloudClient.paginate(
          '/me/favorites',
          req.accessToken,
          req.refreshToken,
          200
        ));
        harvestTracks(items);
        return items;
      },
      // `truncated` rides along from paginate() when the crawl hit its page or
      // time budget; loadUserCollection surfaces it so the client can say
      // "showing N of more" rather than presenting a partial library as whole.
      (items) => ({ collection: items, total_results: items.length }),
    );
    res.json(payload);
  } catch (error) {
    logger.error('Get likes error:', safeError(error));
    res.status(500).json({ error: 'Failed to get likes' });
  }
});

/**
 * GET /api/likes/paged
 * Returns one page of likes with cursor-based pagination
 * Query: limit (default 50), next (optional next_href from previous page)
 */
/**
 * Cursor-paged reads of the authenticated user's own collections.
 *
 * These exist so a browse tool can paint its first rows after ONE round trip
 * instead of waiting out a full crawl. `next` is the opaque next_href from the
 * previous page; only its path and query are used, so a caller cannot redirect
 * the request at another host.
 */
const PAGED_COLLECTIONS = {
  likes: { endpoint: '/me/likes/tracks', harvest: true },
  followings: { endpoint: '/me/followings', harvest: false },
  followers: { endpoint: '/me/followers', harvest: false },
};

function pagedCollectionHandler(name) {
  const { endpoint: baseEndpoint, harvest } = PAGED_COLLECTIONS[name];
  return async (req, res) => {
    try {
      const { limit = 50, next } = req.query;
      let endpoint;
      if (next) {
        try {
          const u = new URL(String(next));
          // Path + query only: never follow the cursor's host.
          endpoint = `${u.pathname}${u.search}`;
        } catch {
          return res.status(400).json({ error: 'Invalid next cursor' });
        }
      } else {
        const params = new URLSearchParams({
          limit: String(parseInt(limit)),
          linked_partitioning: '1',
        });
        endpoint = `${baseEndpoint}?${params.toString()}`;
      }

      const page = await soundcloudClient.scRequest(endpoint, req.accessToken, req.refreshToken);
      const collection = Array.isArray(page.collection) ? page.collection : [];
      if (harvest) harvestTracks(collection);
      res.json({
        collection,
        next_href: page.next_href || null,
        total: page.total_results || undefined,
      });
    } catch (error) {
      logger.error(`Get ${name} paged error:`, safeError(error));
      res.status(500).json({ error: `Failed to get ${name} page` });
    }
  };
}

router.get('/likes/paged', authenticateUser, instrumentRead('likes-paged'), validateLikesPagination, pagedCollectionHandler('likes'));
router.get('/followings/paged', authenticateUser, instrumentRead('followings-paged'), validateLikesPagination, pagedCollectionHandler('followings'));
router.get('/followers/paged', authenticateUser, instrumentRead('followers-paged'), validateLikesPagination, pagedCollectionHandler('followers'));

/**
 * GET /api/reposts/paged
 * Offset-paged, not cursor-paged: reposts are assembled from two separate
 * SoundCloud crawls (tracks + playlists) merged and sorted, so there is no
 * upstream cursor to hand back. The first request pays the crawl once and the
 * snapshot tier serves every page after it.
 * Query: limit (default 50), offset (default 0)
 */
router.get('/reposts/paged', authenticateUser, instrumentRead('reposts-paged'), validateOffsetPagination, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? 50, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset ?? 0, 10) || 0, 0);

    const payload = await loadUserCollection(
      req,
      'reposts',
      () => soundcloudClient.getReposts(req.accessToken, req.refreshToken),
      (reposts) => ({ collection: reposts, total_results: reposts.length }),
    );

    const all = Array.isArray(payload.collection) ? payload.collection : [];
    const slice = all.slice(offset, offset + limit);
    res.json({
      collection: slice,
      total: all.length,
      offset,
      limit,
      has_more: offset + slice.length < all.length,
      stale: payload.stale === true,
      truncated: payload.truncated === true,
    });
  } catch (error) {
    logger.error('Get reposts paged error:', safeError(error));
    res.status(500).json({ error: 'Failed to get reposts page' });
  }
});

/**
 * POST /api/resolve
 * Resolve a SoundCloud URL
 */
async function handleResolve(req, res) {
  try {
    const useV2 = isResolveV2(req);
    const rawUrl = req.method === 'GET' ? req.query?.url : req.body?.url;
    // Validation middleware already checked the URL format
    const cleaned = sanitizeUrl(rawUrl);
    if (!cleaned) return res.status(400).json({ error: 'Invalid SoundCloud URL' });

    const cached = getCachedResolve(cleaned);
    if (cached) {
      logOperation({
        userId: req.user.id,
        action: 'resolve',
        status: 'success',
        trackIds: cached?.type === 'track' && cached.id != null ? [cached.id] : undefined,
        playlistIds: cached?.type === 'playlist' && cached.id != null ? [cached.id] : undefined,
        metadata: { resolvedType: cached?.type ?? 'unknown', cached: true },
      });
      if (!useV2) return res.json(cached);
      return res.json({
        data: normalizeResourceV2(cached) || cached,
        meta: {
          version: '2',
          source_url: cleaned,
          resolved_at: nowIso(),
          cached: true,
          resolver_path: 'cache'
        }
      });
    }

    let resource;
    let resolverPath = 'oauth';
    try {
      resource = await soundcloudClient.resolveAny(req.accessToken, req.refreshToken, cleaned);
    } catch (e) {
      const msg = String(e?.message || '').toLowerCase();
      // If token is invalid/expired, try public resolve for public resources
      if (msg.includes('invalid_grant') || msg.includes('401')) {
        try {
          resource = await soundcloudClient.resolvePublic(cleaned);
          resolverPath = 'public_fallback';
        } catch (e2) {
          // bubble up original auth error context
          throw e;
        }
      } else {
        throw e;
      }
    }
    const normalized = normalizeResource(resource);
    if (!normalized) return res.status(422).json({ error: 'Unsupported or unknown resource' });
    if (normalized.type === 'track') harvestTracks([resource]);
    else if (normalized.type === 'playlist') {
      harvestPlaylists([resource]);
      harvestTracks(Array.isArray(resource.tracks) ? resource.tracks : []);
    }

    // Optional oEmbed supplement (best effort)
    try {
      // fetchWithTimeout, not bare fetch: this is a third-party call in the hot
      // path of /resolve, and the surrounding try/catch handles rejection but
      // not hanging — without an AbortController a stuck oEmbed holds the
      // whole response open. Short deadline; the supplement is best-effort.
      const oembedRes = await fetchWithTimeout(
        `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(cleaned)}`,
        {},
        OEMBED_TIMEOUT_MS,
      );
      if (oembedRes.ok) {
        const oem = await oembedRes.json();
        if (normalized.type === 'track' || normalized.type === 'playlist') {
          normalized.artwork_url = normalized.artwork_url || oem.thumbnail_url;
        } else if (normalized.type === 'user') {
          normalized.avatar_url = normalized.avatar_url || oem.thumbnail_url;
        }
      }
    } catch {}

    setCachedResolve(cleaned, normalized);
    if (!useV2) {
      res.json(normalized);
    } else {
      res.json({
        data: normalizeResourceV2(resource),
        meta: {
          version: '2',
          source_url: cleaned,
          resolved_at: nowIso(),
          cached: false,
          resolver_path: resolverPath
        }
      });
    }
    logOperation({
      userId: req.user.id,
      action: 'resolve',
      status: 'success',
      trackIds: normalized.type === 'track' && normalized.id != null ? [normalized.id] : undefined,
      playlistIds: normalized.type === 'playlist' && normalized.id != null ? [normalized.id] : undefined,
      metadata: { resolvedType: normalized.type ?? 'unknown', cached: false },
    });
  } catch (error) {
    logger.error('Resolve error:', safeError(error));
    const msg = String(error?.message || '').toLowerCase();
    if (msg.includes('invalid_grant')) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    if (msg.includes('401')) return res.status(401).json({ error: 'Unauthorized to resolve this URL. Sign in and try again.' });
    if (msg.includes('404')) return res.status(404).json({ error: 'Resource not found or private.' });
    res.status(500).json({ error: 'Failed to resolve URL' });
  }
}

router.post('/resolve', authenticateUser, heavyOperationRateLimiter, validateResolve, handleResolve);
router.get('/resolve', authenticateUser, heavyOperationRateLimiter, validateResolve, handleResolve);

/**
 * GET /api/proxy-download
 * Proxy a download request to SoundCloud to verify auth and get the final link
 */
router.get('/proxy-download', authenticateUser, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }
    if (!isAllowedDownloadUrl(url)) {
      return res.status(400).json({ error: 'Invalid download URL' });
    }

    // The URL already passed isAllowedDownloadUrl, so the track ID is extractable
    const downloadTrackId = Number(url.match(/\/tracks\/(\d+)\/download/)?.[1]) || null;
    const result = await soundcloudClient.getDownloadLink(req.accessToken, req.refreshToken, url);

    if (result && result.redirect) {
      const loc = result.redirect;
      if (isAllowedDownloadRedirectTarget(loc)) {
        logOperation({
          userId: req.user.id,
          action: 'proxy-download',
          status: 'success',
          trackIds: downloadTrackId ? [downloadTrackId] : undefined,
        });
        if (req.query.format === 'json') {
          return res.json({ url: loc });
        }
        return res.redirect(loc);
      }
      logOperation({
        userId: req.user.id,
        action: 'proxy-download',
        status: 'error',
        trackIds: downloadTrackId ? [downloadTrackId] : undefined,
        metadata: { reason: 'invalid_redirect_target' },
      });
      return res.status(502).json({ error: 'Invalid download redirect target' });
    }
    
    res.status(404).json({ error: 'Could not resolve download link' });
  } catch (error) {
    logger.error('Proxy download error:', safeError(error));
    res.status(500).json({ error: 'Failed to proxy download' });
  }
});

/**
 * POST /api/playlists/merge
 * Merge multiple playlists (into new or existing playlist)
 */
router.post('/playlists/merge', authenticateUser, heavyOperationRateLimiter, validateMergePlaylists, async (req, res) => {
  const elapsed = startOperationTimer();
  try {
    const { sourcePlaylistIds, title, targetPlaylistId, deleteAfterMerge } = req.body;
    // Validation middleware already checked the input

    // Read phase. These fetches are independent, so they run concurrently —
    // the loop this replaces was serial AND paced itself with the *write*
    // constant, costing ~700ms per source playlist before a single write.
    // Dedup order still follows sourcePlaylistIds because mapWithConcurrency
    // preserves input order.
    const sourcePlaylists = await mapWithConcurrency(
      sourcePlaylistIds,
      SC_READ_CONCURRENCY,
      (playlistId) => soundcloudClient.getPlaylistWithTracks(
        req.accessToken,
        req.refreshToken,
        playlistId
      ),
    );

    const perPlaylistCounts = [];
    let fetchedTotal = 0;
    let acceptedTotal = 0;
    const trackIdSet = new Set();
    for (let i = 0; i < sourcePlaylists.length; i += 1) {
      const playlist = sourcePlaylists[i];
      const playlistId = sourcePlaylistIds[i];
      const all = Array.isArray(playlist.tracks) ? playlist.tracks : [];
      const filtered = all.filter(t => t && !t.blocked_at && t.streamable !== false);
      harvestTracks(all); // blocked/preview tracks are catalog signal too
      harvestPlaylists([playlist]);
      fetchedTotal += all.length;
      acceptedTotal += filtered.length;
      perPlaylistCounts.push({ id: playlistId, fetched: all.length, accepted: filtered.length });
      for (const t of filtered) {
        if (t.id != null) trackIdSet.add(t.id);
      }
    }

    // ── MERGE INTO EXISTING PLAYLIST ──────────────────────────────────────────
    if (targetPlaylistId) {
      // Fetch existing target playlist tracks. The target is rewritten in
      // full, so it is read the guarded way (all access levels, short read
      // refused). The SOURCE reads above stay default access on purpose:
      // blocked tracks are filtered out of what gets merged in.
      const { playlist: targetPlaylist, ids: existingIds } = await readPlaylistForRewrite(
        soundcloudClient, req.accessToken, req.refreshToken, targetPlaylistId,
      );
      assertAppendable(existingIds);
      const existingTrackCount = existingIds.length;

      // Merge: preserve existing order, append new unique source tracks
      const { mergedIds, addedCount } = mergeIntoExisting(existingIds, Array.from(trackIdSet));

      // Split into 500-track chunks (target gets first chunk, overflow gets new playlists)
      const chunks = splitIntoChunks(mergedIds, 500);
      const targetChunk = chunks[0] || [];
      const overflowChunks = chunks.slice(1);

      // Grow the target from its existing length, never from zero: each PUT
      // replaces the whole list, so a failed later write must not leave the
      // target shorter than it was.
      await writeGrowingPrefix({
        ids: targetChunk,
        floor: existingIds.length,
        batchSize: 100,
        write: (prefix) => soundcloudClient.addTracksToPlaylist(
          req.accessToken,
          req.refreshToken,
          targetPlaylistId,
          prefix
        ),
      });

      // Create new playlists for overflow chunks (>500 tracks)
      const baseTitle = (title && title.trim()) || targetPlaylist.title || 'Merged Playlist';
      const overflowPlaylists = [];
      for (let i = 0; i < overflowChunks.length; i++) {
        await sleep(SC_WRITE_PACING_MS);
        const chunk = overflowChunks[i];
        const partNumber = i + 2; // Part 1 is targetPlaylist
        const partTitle = `${baseTitle} (Part ${partNumber})`;
        const newPl = await soundcloudClient.createPlaylist(
          req.accessToken,
          req.refreshToken,
          partTitle,
          playlistDescriptionWithToolkit(`Merged overflow part ${partNumber}`),
          chunk.slice(0, 100)
        );

        if (chunk.length > 100) await sleep(SC_WRITE_PACING_MS);
        await writeGrowingPrefix({
          ids: chunk,
          floor: Math.min(100, chunk.length),
          batchSize: 100,
          write: (prefix) => soundcloudClient.addTracksToPlaylist(
            req.accessToken,
            req.refreshToken,
            newPl.id,
            prefix
          ),
        });

        overflowPlaylists.push({
          id: newPl.id,
          title: partTitle,
          trackCount: chunk.length,
          partNumber,
        });
      }

      // Optionally delete source playlists (never delete the target)
      let deletedPlaylistIds = [];
      let deleteErrors = [];
      if (deleteAfterMerge) {
        const toDelete = sourcePlaylistIds.filter(id => id !== targetPlaylistId);
        for (const id of toDelete) {
          await sleep(SC_WRITE_PACING_MS);
          try {
            await soundcloudClient.deletePlaylist(req.accessToken, req.refreshToken, id);
            deletedPlaylistIds.push(id);
          } catch (err) {
            deleteErrors.push({ id, error: safeError(err).message || 'Delete failed' });
          }
        }
      }

      const finalCount = mergedIds.length;
      logger.info('[merge] merged into existing playlist', {
        targetPlaylistId,
        existingTrackCount,
        addedCount,
        finalCount,
        overflowPlaylists: overflowPlaylists.length,
        deletedCount: deletedPlaylistIds.length,
      });

      logOperation({
        userId: req.user.id,
        action: 'merge',
        trackCount: addedCount,
        status: 'success',
        durationMs: elapsed(),
        clientInfo: extractClientInfo(req),
        playlistIds: [...sourcePlaylistIds, targetPlaylistId, ...overflowPlaylists.map(p => p.id)],
        trackIds: Array.from(trackIdSet),
        metadata: {
          mode: 'into-existing',
          sourceCount: sourcePlaylistIds.length,
          totalTracks: finalCount,
          playlistsCreated: overflowPlaylists.length,
          finalCount,
          targetPlaylistId,
          existingTrackCount,
          addedCount,
          deletedCount: deletedPlaylistIds.length,
        },
      });
      invalidatePlaylistState(req.user.id);

      return res.json({
        playlist: { id: targetPlaylistId, title: targetPlaylist.title },
        overflowPlaylists: overflowPlaylists.length > 0 ? overflowPlaylists : undefined,
        deletedPlaylistIds: deletedPlaylistIds.length > 0 ? deletedPlaylistIds : undefined,
        deleteErrors: deleteErrors.length > 0 ? deleteErrors : undefined,
        stats: {
          sourcePlaylists: sourcePlaylistIds.length,
          perPlaylistCounts,
          fetchedTotal,
          acceptedTotal,
          existingTrackCount,
          addedCount,
          totalTracks: finalCount,
          overflowCount: overflowPlaylists.length,
        },
      });
    }
    // ── END MERGE INTO EXISTING ───────────────────────────────────────────────

    const trackIdsArray = Array.from(trackIdSet);
    const uniqueBeforeCap = trackIdsArray.length;
    const baseTitle = (title && title.trim()) || 'Merged Playlist';

    // If tracks exceed 500, split into multiple playlists
    if (trackIdsArray.length > 500) {
      const chunks = [];
      for (let i = 0; i < trackIdsArray.length; i += 500) {
        chunks.push(trackIdsArray.slice(i, i + 500));
      }

      const numPlaylists = chunks.length;
      const createdPlaylists = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const partTitle = `${baseTitle} (${i + 1}/${numPlaylists})`;
        const mergeBatchSize = 100;
        const initialBatch = chunk.slice(0, mergeBatchSize);

        const newPlaylist = await soundcloudClient.createPlaylist(
          req.accessToken,
          req.refreshToken,
          partTitle,
          playlistDescriptionWithToolkit(`Part ${i + 1} of ${numPlaylists} merged from ${sourcePlaylistIds.length} playlists`),
          initialBatch
        );

        await sleep(SC_PLAYLIST_PACING_MS);

        let finalCount = initialBatch.length;
        let addIndex = mergeBatchSize;
        while (addIndex < chunk.length) {
          await sleep(SC_WRITE_PACING_MS);
          const addBatch = chunk.slice(0, addIndex + mergeBatchSize);
          await soundcloudClient.addTracksToPlaylist(
            req.accessToken,
            req.refreshToken,
            newPlaylist.id,
            addBatch
          );
          finalCount += addBatch.length;
          addIndex += mergeBatchSize;
        }

        createdPlaylists.push({
          playlist: newPlaylist,
          trackCount: chunk.length,
          partNumber: i + 1
        });

        if (i < chunks.length - 1) {
          await sleep(SC_WRITE_PACING_MS);
        }
      }

      logger.info('[merge] split completed', {
        sourceCount: sourcePlaylistIds.length,
        fetchedTotal,
        acceptedTotal,
        uniqueBeforeCap,
        totalTracks: trackIdsArray.length,
        numPlaylistsCreated: numPlaylists
      });

      res.json({
        playlists: createdPlaylists.map(p => ({
          ...p.playlist,
          track_count: p.trackCount,
          part_number: p.partNumber,
          total_parts: numPlaylists
        })),
        stats: {
          sourcePlaylists: sourcePlaylistIds.length,
          perPlaylistCounts,
          fetchedTotal,
          acceptedTotal,
          uniqueBeforeCap,
          totalTracks: trackIdsArray.length,
          numPlaylistsCreated: numPlaylists,
          playlistsCreated: createdPlaylists.map(p => ({
            id: p.playlist.id,
            title: p.playlist.title,
            trackCount: p.trackCount,
            partNumber: p.partNumber
          }))
        }
      });
      logOperation({
        userId: req.user.id,
        action: 'merge',
        trackCount: trackIdsArray.length,
        status: 'split',
        durationMs: elapsed(),
        clientInfo: extractClientInfo(req),
        playlistIds: [...sourcePlaylistIds, ...createdPlaylists.map(p => p.playlist.id)],
        trackIds: trackIdsArray,
        metadata: {
          mode: 'split',
          sourceCount: sourcePlaylistIds.length,
          totalTracks: trackIdsArray.length,
          playlistsCreated: numPlaylists,
          fetchedTotal,
          acceptedTotal,
          uniqueBeforeCap,
        },
      });
      invalidatePlaylistState(req.user.id);
    } else {
      // Single playlist (<= 500 tracks) with 100-track batches
      const playlistTitle = baseTitle;
      const mergeBatchSize = 100;
      const initialBatch = trackIdsArray.slice(0, mergeBatchSize);
      const newPlaylist = await soundcloudClient.createPlaylist(
        req.accessToken,
        req.refreshToken,
        playlistTitle,
        playlistDescriptionWithToolkit(`Merged from ${sourcePlaylistIds.length} playlists`),
        initialBatch
      );

      logger.info('[merge] created playlist', { id: newPlaylist.id, initialCount: initialBatch.length });
      await sleep(SC_PLAYLIST_PACING_MS);

      let finalCount = initialBatch.length;
      let addIndex = mergeBatchSize;
      while (addIndex < trackIdsArray.length) {
        await sleep(SC_WRITE_PACING_MS);
        const addBatch = trackIdsArray.slice(0, addIndex + mergeBatchSize);
        await soundcloudClient.addTracksToPlaylist(
          req.accessToken,
          req.refreshToken,
          newPlaylist.id,
          addBatch
        );
        finalCount += addBatch.length;
        addIndex += mergeBatchSize;
      }

      // Verify current count if possible
      let verifiedCount = finalCount;
      try {
        const verified = await soundcloudClient.getPlaylistWithTracks(
          req.accessToken,
          req.refreshToken,
          newPlaylist.id
        );
        verifiedCount = Array.isArray(verified.tracks) ? verified.tracks.length : (verified.track_count || verifiedCount);
      } catch {}

      logger.info('[merge] summary', {
        sourceCount: sourcePlaylistIds.length,
        fetchedTotal,
        acceptedTotal,
        uniqueBeforeCap,
        totalTracks: trackIdsArray.length,
        createdId: newPlaylist.id,
        verifiedCount
      });

      res.json({
        playlist: newPlaylist,
        stats: {
          sourcePlaylists: sourcePlaylistIds.length,
          perPlaylistCounts,
          fetchedTotal,
          acceptedTotal,
          uniqueBeforeCap,
          totalTracks: trackIdsArray.length,
          finalCount: verifiedCount
        }
      });
      logOperation({
        userId: req.user.id,
        action: 'merge',
        trackCount: trackIdsArray.length,
        status: 'success',
        durationMs: elapsed(),
        clientInfo: extractClientInfo(req),
        playlistIds: [...sourcePlaylistIds, newPlaylist.id],
        trackIds: trackIdsArray,
        metadata: {
          mode: 'new',
          sourceCount: sourcePlaylistIds.length,
          totalTracks: trackIdsArray.length,
          playlistsCreated: 1,
          finalCount: verifiedCount,
          fetchedTotal,
          acceptedTotal,
          uniqueBeforeCap,
        },
      });
      invalidatePlaylistState(req.user.id);
    }
  } catch (error) {
    if (error instanceof PlaylistReadIncompleteError || error instanceof PlaylistTooLargeError) {
      // Refused before any write, so nothing was changed.
      return res.status(409).json({ error: error.message });
    }
    // A write may have landed before the failure; do not serve a stale target.
    invalidatePlaylistState(req.user.id);
    logger.error('Merge playlists error:', safeError(error));
    logOperation({
      userId: req.user.id,
      action: 'merge',
      status: 'error',
      durationMs: elapsed(),
      clientInfo: extractClientInfo(req),
      // try-scoped arrays aren't visible here; fall back to the validated body
      playlistIds: Array.isArray(req.body?.sourcePlaylistIds) ? req.body.sourcePlaylistIds : undefined,
      errorCode: error.name || 'MERGE_FAILED',
      errorMessage: safeError(error).message,
    });
    res.status(500).json({ error: 'Failed to merge playlists' });
  }
});

const BATCH_SIZE_PLAYLIST_TRACKS = 100;
const MAX_TRACKS_PER_PLAYLIST = 500;

/**
 * Create a single playlist from track IDs using 100-track batches (SoundCloud API limit).
 * @param {string} operationDescription - Summary only; Track Toolkit footer is appended automatically.
 */
async function createPlaylistFromTrackIds(accessToken, refreshToken, trackIds, title, operationDescription) {
  const initialBatch = trackIds.slice(0, BATCH_SIZE_PLAYLIST_TRACKS);
  const newPlaylist = await soundcloudClient.createPlaylist(
    accessToken,
    refreshToken,
    title,
    playlistDescriptionWithToolkit(operationDescription),
    initialBatch
  );

  let index = BATCH_SIZE_PLAYLIST_TRACKS;
  while (index < trackIds.length) {
    await sleep(SC_WRITE_PACING_MS);
    const batch = trackIds.slice(0, index + BATCH_SIZE_PLAYLIST_TRACKS);
    await soundcloudClient.addTracksToPlaylist(
      accessToken,
      refreshToken,
      newPlaylist.id,
      batch
    );
    index += BATCH_SIZE_PLAYLIST_TRACKS;
  }

  return newPlaylist;
}

function uniquePositiveIds(ids = []) {
  const seen = new Set();
  const unique = [];
  for (const id of ids) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId < 1 || seen.has(numericId)) continue;
    seen.add(numericId);
    unique.push(numericId);
  }
  return unique;
}

/** @param {string} [description] - Operation summary only (no footer); required when creating new playlist(s). */
async function createOrAppendTrackIds({ accessToken, refreshToken, trackIds, title, targetPlaylistId, description }) {
  const uniqueTrackIds = uniquePositiveIds(trackIds);

  if (targetPlaylistId) {
    // Throws PlaylistReadIncompleteError on a short read; the caller's catch
    // turns that into a 409 (appending to a partial list deletes the rest).
    const { playlist: targetPlaylist, ids: existingIds } = await readPlaylistForRewrite(
      soundcloudClient, accessToken, refreshToken, targetPlaylistId,
    );
    assertAppendable(existingIds);
    const { mergedIds, addedCount } = mergeIntoExisting(existingIds, uniqueTrackIds);
    const chunks = splitIntoChunks(mergedIds, MAX_TRACKS_PER_PLAYLIST);
    const targetChunk = chunks[0] || [];
    const overflowChunks = chunks.slice(1);

    // Grow from the existing length, never from zero (see writeGrowingPrefix):
    // a failed later write leaves the target no shorter than it was.
    await writeGrowingPrefix({
      ids: targetChunk,
      floor: existingIds.length,
      batchSize: BATCH_SIZE_PLAYLIST_TRACKS,
      write: (prefix) => soundcloudClient.addTracksToPlaylist(accessToken, refreshToken, targetPlaylistId, prefix),
    });

    const overflowPlaylists = [];
    const baseTitle = targetPlaylist.title || title || 'Playlist';
    for (let i = 0; i < overflowChunks.length; i++) {
      await sleep(SC_PLAYLIST_PACING_MS);
      const overflowTitle = `${baseTitle} (overflow ${i + 1})`;
      const overflowPlaylist = await createPlaylistFromTrackIds(
        accessToken,
        refreshToken,
        overflowChunks[i],
        overflowTitle,
        `Overflow from adding tracks to "${baseTitle}"`
      );
      overflowPlaylists.push({
        id: overflowPlaylist.id,
        title: overflowTitle,
        permalink_url: overflowPlaylist.permalink_url,
        trackCount: overflowChunks[i].length,
      });
    }

    return {
      playlist: { id: targetPlaylistId, title: targetPlaylist.title },
      overflowPlaylists: overflowPlaylists.length > 0 ? overflowPlaylists : undefined,
      totalTracks: mergedIds.length,
      addedCount,
      existingTrackCount: existingIds.length,
    };
  }

  if (uniqueTrackIds.length <= MAX_TRACKS_PER_PLAYLIST) {
    const newPlaylist = await createPlaylistFromTrackIds(accessToken, refreshToken, uniqueTrackIds, title, description);
    return {
      playlistId: newPlaylist.id,
      permalink_url: newPlaylist.permalink_url,
      playlist: { id: newPlaylist.id, title, permalink_url: newPlaylist.permalink_url },
      totalTracks: uniqueTrackIds.length,
    };
  }

  const chunks = splitIntoChunks(uniqueTrackIds, MAX_TRACKS_PER_PLAYLIST);
  const playlists = [];
  for (let i = 0; i < chunks.length; i++) {
    const playlistTitle = `${title} (${i + 1}/${chunks.length})`;
    const partSuffix = chunks.length > 1 ? ` - Part ${i + 1} of ${chunks.length}` : '';
    const newPlaylist = await createPlaylistFromTrackIds(
      accessToken,
      refreshToken,
      chunks[i],
      playlistTitle,
      `${description}${partSuffix}`
    );
    playlists.push({
      id: newPlaylist.id,
      title: playlistTitle,
      permalink_url: newPlaylist.permalink_url,
      trackCount: chunks[i].length,
    });
    if (i < chunks.length - 1) await sleep(SC_PLAYLIST_PACING_MS);
  }

  return {
    playlists,
    totalTracks: uniqueTrackIds.length,
    numPlaylistsCreated: playlists.length,
  };
}

/** The three followed-user library pages differ only in which client method
 * fetches the page, which normalizer shapes the items, and their log/error
 * wording. Response shape and status mapping are identical across all three. */
function followedLibraryPageHandler({ fetchPage, normalizeItem, logLabel, forbiddenMessage, failureMessage }) {
  return async (req, res) => {
    try {
      const targetUser = await assertFollowedUser(req, req.params.userId);
      const page = await fetchPage(req);
      const collection = (Array.isArray(page.collection) ? page.collection : [])
        .map(normalizeItem)
        .filter(Boolean);
      res.json({
        user: {
          id: targetUser.id,
          username: targetUser.username,
          avatar_url: targetUser.avatar_url,
          permalink_url: targetUser.permalink_url,
        },
        collection,
        next_href: page.next_href || null,
        total: page.total_results || undefined,
      });
    } catch (error) {
      logger.error(logLabel, safeError(error));
      const status = error?.status || 500;
      res.status(status === 403 ? 403 : 500).json({
        error: status === 403 ? forbiddenMessage : failureMessage,
      });
    }
  };
}

const followedLibraryPageParams = (req) => ({
  limit: req.query.limit || 50,
  next: req.query.next,
});

router.get(
  '/followings/:userId/likes/paged',
  authenticateUser,
  validateFollowingUserId,
  validateFollowedUserLibraryPagination,
  followedLibraryPageHandler({
    fetchPage: (req) =>
      soundcloudClient.getUserLikedTracksPage(
        req.accessToken,
        req.refreshToken,
        req.params.userId,
        followedLibraryPageParams(req)
      ),
    normalizeItem: normalizeTrackForLibraryBrowser,
    logLabel: 'Get followed user liked tracks error:',
    forbiddenMessage: 'Choose a user you follow to browse their public likes.',
    failureMessage: 'Failed to get followed user likes',
  })
);

router.get(
  '/followings/:userId/playlists/paged',
  authenticateUser,
  validateFollowingUserId,
  validateFollowedUserLibraryPagination,
  followedLibraryPageHandler({
    fetchPage: (req) =>
      soundcloudClient.getUserPlaylistsPage(
        req.accessToken,
        req.refreshToken,
        req.params.userId,
        followedLibraryPageParams(req)
      ),
    normalizeItem: normalizePlaylistForLibraryBrowser,
    logLabel: 'Get followed user playlists error:',
    forbiddenMessage: 'Choose a user you follow to browse their public playlists.',
    failureMessage: 'Failed to get followed user playlists',
  })
);

router.get(
  '/followings/:userId/liked-playlists/paged',
  authenticateUser,
  validateFollowingUserId,
  validateFollowedUserLibraryPagination,
  followedLibraryPageHandler({
    fetchPage: (req) =>
      soundcloudClient.getUserLikedPlaylistsPage(
        req.accessToken,
        req.refreshToken,
        req.params.userId,
        followedLibraryPageParams(req)
      ),
    normalizeItem: normalizePlaylistForLibraryBrowser,
    logLabel: 'Get followed user liked playlists error:',
    forbiddenMessage: 'Choose a user you follow to browse their public liked playlists.',
    failureMessage: 'Failed to get followed user liked playlists',
  })
);

router.post(
  '/followings/:userId/likes/playlist',
  authenticateUser,
  heavyOperationRateLimiter,
  validateFollowingUserId,
  validateCreateFromFollowedLikes,
  async (req, res) => {
    try {
      const targetUser = await assertFollowedUser(req, req.params.userId);
      const { mode, targetPlaylistId } = req.body;
      const baseTitle = req.body.title?.trim() || `${targetUser.username || 'Followed user'} Likes`;
      let fetchedTotal;
      let acceptedTotal;
      let trackIds;

      if (mode === 'all') {
        const tracks = await soundcloudClient.getUserLikedTracks(req.accessToken, req.refreshToken, req.params.userId, 200);
        fetchedTotal = tracks.length;
        trackIds = getPlayableTrackIds(tracks);
        acceptedTotal = trackIds.length;
      } else {
        trackIds = uniquePositiveIds(req.body.trackIds);
        fetchedTotal = trackIds.length;
        acceptedTotal = trackIds.length;
      }

      if (trackIds.length === 0) {
        return res.status(400).json({ error: 'No public streamable tracks were available to add.' });
      }

      const result = await createOrAppendTrackIds({
        accessToken: req.accessToken,
        refreshToken: req.refreshToken,
        trackIds,
        title: baseTitle,
        targetPlaylistId,
        description: `Playlist created from ${targetUser.username || 'a followed user'}'s public liked tracks`,
      });

      logOperation({
        userId: req.user.id,
        action: 'followed-likes-to-playlist',
        trackCount: trackIds.length,
        status: result.numPlaylistsCreated && result.numPlaylistsCreated > 1 ? 'split' : 'success',
        trackIds,
        playlistIds: result.playlists
          ? result.playlists.map(p => p.id)
          : [result.playlist?.id, ...(result.overflowPlaylists || []).map(p => p.id)].filter(Boolean),
        targetUserIds: [Number(req.params.userId)],
      });

      invalidatePlaylistState(req.user.id);
      res.json({
        ...result,
        stats: {
          sourceUserId: Number(req.params.userId),
          sourceUsername: targetUser.username,
          fetchedTotal,
          acceptedTotal,
          mode,
        },
      });
    } catch (error) {
      if (error instanceof PlaylistReadIncompleteError || error instanceof PlaylistTooLargeError) {
        return res.status(409).json({ error: error.message });
      }
      invalidatePlaylistState(req.user.id);
      logger.error('Create playlist from followed likes error:', safeError(error));
      const status = error?.status || 500;
      res.status(status === 403 ? 403 : 500).json({
        error: status === 403 ? 'Choose a user you follow to create from their public likes.' : 'Failed to create playlist from followed user likes',
      });
    }
  }
);

router.post(
  '/followings/:userId/playlists/clone',
  authenticateUser,
  heavyOperationRateLimiter,
  validateFollowingUserId,
  validateCloneFollowedPlaylists,
  async (req, res) => {
    try {
      const targetUser = await assertFollowedUser(req, req.params.userId);
      const playlistIds = uniquePositiveIds(req.body.playlistIds);
      const titlePrefix = req.body.titlePrefix?.trim();
      const playlists = [];
      const errors = [];
      const perPlaylistCounts = [];
      let fetchedTotal = 0;
      let acceptedTotal = 0;

      for (const playlistId of playlistIds) {
        try {
          const playlist = await soundcloudClient.getPlaylistWithTracks(req.accessToken, req.refreshToken, playlistId);
          const allTracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
          const trackIds = getPlayableTrackIds(allTracks);
          fetchedTotal += allTracks.length;
          acceptedTotal += trackIds.length;
          perPlaylistCounts.push({ id: playlistId, fetched: allTracks.length, accepted: trackIds.length });

          if (trackIds.length === 0) {
            errors.push({ id: playlistId, error: 'Playlist has no public streamable tracks to clone.' });
            continue;
          }

          const sourceTitle = playlist.title || `Playlist ${playlistId}`;
          const baseTitle = titlePrefix ? `${titlePrefix} - ${sourceTitle}` : `Clone of ${sourceTitle}`;
          const chunks = splitIntoChunks(trackIds, MAX_TRACKS_PER_PLAYLIST);

          for (let i = 0; i < chunks.length; i++) {
            const playlistTitle = chunks.length > 1 ? `${baseTitle} (${i + 1}/${chunks.length})` : baseTitle;
            const created = await createPlaylistFromTrackIds(
              req.accessToken,
              req.refreshToken,
              chunks[i],
              playlistTitle,
              `Cloned from ${playlist.permalink_url || `${targetUser.username || 'followed user'} playlist ${playlistId}`}`
            );
            playlists.push({
              id: created.id,
              title: playlistTitle,
              permalink_url: created.permalink_url,
              trackCount: chunks[i].length,
              sourcePlaylistId: playlistId,
            });
          }
        } catch (error) {
          logger.warn('Followed playlist clone item failed:', { playlistId, error: safeError(error) });
          errors.push({ id: playlistId, error: 'Playlist could not be cloned. It may be private or unavailable.' });
        }
      }

      if (playlists.length === 0) {
        return res.status(400).json({
          error: 'No selected playlists had public streamable tracks to clone.',
          errors,
        });
      }

      logOperation({
        userId: req.user.id,
        action: 'followed-playlist-clone',
        itemCount: playlistIds.length,
        trackCount: acceptedTotal,
        status: errors.length > 0 ? 'partial' : 'success',
        playlistIds: [...playlistIds, ...playlists.map(p => p.id)],
        targetUserIds: [Number(req.params.userId)],
      });

      invalidatePlaylistState(req.user.id);
      res.status(errors.length > 0 ? 207 : 200).json({
        playlists,
        errors: errors.length > 0 ? errors : undefined,
        stats: {
          sourceUserId: Number(req.params.userId),
          sourceUsername: targetUser.username,
          sourcePlaylists: playlistIds.length,
          fetchedTotal,
          acceptedTotal,
          numPlaylistsCreated: playlists.length,
          perPlaylistCounts,
        },
      });
    } catch (error) {
      logger.error('Clone followed playlists error:', safeError(error));
      const status = error?.status || 500;
      res.status(status === 403 ? 403 : 500).json({
        error: status === 403 ? 'Choose a user you follow to clone their public playlists.' : 'Failed to clone followed user playlists',
      });
    }
  }
);

/**
 * POST /api/playlists/from-likes
 * Create playlist(s) from liked tracks, or append to an existing playlist.
 * Uses 100-track batches. If >500 tracks, creates multiple playlists.
 */
router.post('/playlists/from-likes', authenticateUser, heavyOperationRateLimiter, validateCreateFromLikes, async (req, res) => {
  try {
    const { title, trackIds, targetPlaylistId } = req.body;

    // ── ADD TO EXISTING PLAYLIST ──────────────────────────────────────────────
    if (targetPlaylistId) {
      // Fetch existing target playlist tracks (guarded: all access levels,
      // short read refused — see readPlaylistForRewrite).
      const { playlist: targetPlaylist, ids: existingIds } = await readPlaylistForRewrite(
        soundcloudClient, req.accessToken, req.refreshToken, targetPlaylistId,
      );
      assertAppendable(existingIds);
      const existingTrackCount = existingIds.length;

      // Merge: preserve existing order, append new unique tracks
      const { mergedIds, addedCount } = mergeIntoExisting(existingIds, trackIds);

      // Split into 500-track chunks
      const chunks = splitIntoChunks(mergedIds, MAX_TRACKS_PER_PLAYLIST);
      const targetChunk = chunks[0] || [];
      const overflowChunks = chunks.slice(1);

      // Grow the target from its existing length, never from zero, so a failed
      // later write cannot leave it shorter than it was (see writeGrowingPrefix).
      await writeGrowingPrefix({
        ids: targetChunk,
        floor: existingIds.length,
        batchSize: 100,
        write: (prefix) => soundcloudClient.addTracksToPlaylist(
          req.accessToken,
          req.refreshToken,
          targetPlaylistId,
          prefix
        ),
      });

      // Create overflow playlists for tracks beyond 500
      const overflowPlaylists = [];
      const baseTitle = targetPlaylist.title || 'Playlist';
      for (let j = 0; j < overflowChunks.length; j++) {
        await sleep(SC_PLAYLIST_PACING_MS);
        const overflowTitle = `${baseTitle} (overflow ${j + 1})`;
        const overflowPlaylist = await createPlaylistFromTrackIds(
          req.accessToken,
          req.refreshToken,
          overflowChunks[j],
          overflowTitle,
          `Overflow from adding likes to "${baseTitle}"`
        );
        overflowPlaylists.push({ id: overflowPlaylist.id, title: overflowTitle, permalink_url: overflowPlaylist.permalink_url, trackCount: overflowChunks[j].length });
      }

      logOperation({
        userId: req.user.id,
        action: 'from-likes',
        trackCount: addedCount,
        status: 'success',
        playlistIds: [targetPlaylistId, ...overflowPlaylists.map(p => p.id)],
        trackIds,
      });
      // Client sends bare IDs — the catalog learns their names via enrichment
      piggybackEnrichment(trackIds, req.accessToken, req.refreshToken);
      invalidatePlaylistState(req.user.id);

      return res.json({
        playlist: { id: targetPlaylistId, title: targetPlaylist.title },
        overflowPlaylists: overflowPlaylists.length > 0 ? overflowPlaylists : undefined,
        totalTracks: mergedIds.length,
        addedCount,
        existingTrackCount,
      });
    }
    // ── END ADD TO EXISTING ───────────────────────────────────────────────────

    const baseTitle = title?.trim() || `My Liked Tracks - ${new Date().toLocaleDateString()}`;

    if (trackIds.length <= MAX_TRACKS_PER_PLAYLIST) {
      const newPlaylist = await createPlaylistFromTrackIds(
        req.accessToken,
        req.refreshToken,
        trackIds,
        baseTitle,
        `Playlist created from ${trackIds.length} liked tracks`
      );
      res.json({
        playlistId: newPlaylist.id,
        permalink_url: newPlaylist.permalink_url,
        playlist: { id: newPlaylist.id, title: baseTitle, permalink_url: newPlaylist.permalink_url },
        totalTracks: trackIds.length
      });
      logOperation({
        userId: req.user.id,
        action: 'from-likes',
        trackCount: trackIds.length,
        status: 'success',
        playlistIds: [newPlaylist.id],
        trackIds,
      });
      piggybackEnrichment(trackIds, req.accessToken, req.refreshToken);
      invalidatePlaylistState(req.user.id);
      return;
    }

    const numPlaylists = Math.ceil(trackIds.length / MAX_TRACKS_PER_PLAYLIST);
    const createdPlaylists = [];

    for (let i = 0; i < numPlaylists; i++) {
      const startIdx = i * MAX_TRACKS_PER_PLAYLIST;
      const endIdx = Math.min(startIdx + MAX_TRACKS_PER_PLAYLIST, trackIds.length);
      const chunk = trackIds.slice(startIdx, endIdx);
      const playlistTitle = numPlaylists > 1
        ? `${baseTitle} (${i + 1}/${numPlaylists})`
        : baseTitle;
      const description = `Playlist created from liked tracks${numPlaylists > 1 ? ` - Part ${i + 1} of ${numPlaylists}` : ''}`;

      const newPlaylist = await createPlaylistFromTrackIds(
        req.accessToken,
        req.refreshToken,
        chunk,
        playlistTitle,
        description
      );

      createdPlaylists.push({
        id: newPlaylist.id,
        title: playlistTitle,
        permalink_url: newPlaylist.permalink_url,
        trackCount: chunk.length
      });

      if (i < numPlaylists - 1) await sleep(SC_PLAYLIST_PACING_MS);
    }

    res.json({
      playlists: createdPlaylists,
      totalTracks: trackIds.length,
      numPlaylistsCreated: numPlaylists
    });
    logOperation({
      userId: req.user.id,
      action: 'from-likes',
      trackCount: trackIds.length,
      status: 'split',
      playlistIds: createdPlaylists.map(p => p.id),
      trackIds,
    });
    piggybackEnrichment(trackIds, req.accessToken, req.refreshToken);
    invalidatePlaylistState(req.user.id);
    return;
  } catch (error) {
    if (error instanceof PlaylistReadIncompleteError || error instanceof PlaylistTooLargeError) {
      return res.status(409).json({ error: error.message });
    }
    invalidatePlaylistState(req.user.id);
    logger.error('Create playlist from likes error:', safeError(error));
    res.status(500).json({ error: 'Failed to create playlist from likes' });
  }
});

/**
 * DELETE /api/playlists/:id
 * Delete a user-owned playlist via the SoundCloud API
 */
router.delete('/playlists/:id', authenticateUser, validateDeletePlaylist, async (req, res) => {
  try {
    const playlistId = req.params.id;
    await soundcloudClient.deletePlaylist(req.accessToken, req.refreshToken, playlistId);
    logOperation({ userId: req.user.id, action: 'delete-playlist', itemCount: 1, status: 'success', playlistIds: [playlistId] });
    invalidatePlaylistState(req.user.id);
    res.json({ ok: true });
  } catch (error) {
    logger.error('Delete playlist error:', safeError(error));
    const status = error?.status || error?.statusCode || 500;
    res.status(typeof status === 'number' && status >= 400 && status < 600 ? status : 500)
      .json({ error: 'Failed to delete playlist' });
  }
});

/**
 * GET /api/tracks/search
 * Search SoundCloud tracks by genre, tags, and other filters
 */
router.get('/tracks/search', authenticateUser, validateTrackSearch, async (req, res) => {
  try {
    const { genres, tags, q, bpm_from, bpm_to, duration_from, duration_to, limit, offset } = req.query;
    const params = {};
    if (genres) params.genres = genres;
    if (tags) params.tags = tags;
    if (q) params.q = q;
    if (bpm_from) params.bpm_from = Number(bpm_from);
    if (bpm_to) params.bpm_to = Number(bpm_to);
    if (duration_from) params.duration_from = Number(duration_from);
    if (duration_to) params.duration_to = Number(duration_to);
    params.limit = limit ? Math.min(Number(limit), 200) : 50;
    if (offset) params.offset = Number(offset);

    const data = await soundcloudClient.searchTracks(req.accessToken, req.refreshToken, params);
    harvestTracks(Array.isArray(data.collection) ? data.collection : []);
    const collection = (Array.isArray(data.collection) ? data.collection : [])
      .map(normalizeResource)
      .filter(Boolean);

    logOperation({
      userId: req.user.id,
      action: 'genre-search',
      itemCount: collection.length,
      status: 'success',
      trackIds: collection.map(t => t.id).filter(id => id != null),
      // The search intent itself is signal: what users look for, not just what they got
      metadata: {
        ...(genres ? { genres } : {}),
        ...(tags ? { tags } : {}),
        ...(q ? { q } : {}),
        ...(bpm_from ? { bpmFrom: Number(bpm_from) } : {}),
        ...(bpm_to ? { bpmTo: Number(bpm_to) } : {}),
      },
    });

    res.json({
      collection,
      next_href: data.next_href || null,
      total_results: data.total_results || null,
    });
  } catch (error) {
    logger.error('Track search error:', safeError(error));
    res.status(500).json({ error: 'Failed to search tracks' });
  }
});

/**
 * POST /api/playlists/deduplicate
 * Remove duplicates from a playlist
 */
// Smart Deduplication removed

/**
 * POST /api/resolve/batch
 * Resolve multiple SoundCloud URLs at once
 */
router.post('/resolve/batch', authenticateUser, heavyOperationRateLimiter, validateBatchResolve, async (req, res) => {
  try {
    const useV2 = isResolveV2(req);
    const { urls } = req.body;
    const results = [];
    // v1-normalized resources for logging + harvest, regardless of response version
    const resolvedResources = [];

    // Bounded concurrency rather than one-at-a-time. These resolves are
    // independent, and the previous serial loop cost up to 50 round trips
    // (each potentially a 302 double-hop) inside a single request.
    const settled = await mapWithConcurrency(urls, SC_READ_CONCURRENCY, async (rawUrl, index) => {
      const url = sanitizeUrl(rawUrl);
      if (!url) {
        return { result: { url: rawUrl, status: 'error', error: 'Invalid SoundCloud URL' }, index };
      }

      // Check cache first
      const cached = getCachedResolve(url);
      if (cached) {
        const cachedData = useV2 ? (normalizeResourceV2(cached) || cached) : cached;
        return { result: { url: rawUrl, status: 'ok', data: cachedData }, index, resource: cached };
      }

      try {
        let resource;
        try {
          resource = await soundcloudClient.resolveAny(req.accessToken, req.refreshToken, url);
        } catch (authErr) {
          // Only retry publicly when a public resolve could plausibly succeed.
          // Retrying on a 429 or a timeout doubles the cost of exactly the
          // situation that produced the failure.
          if (!shouldRetryPublicly(authErr)) throw authErr;
          resource = await soundcloudClient.resolvePublic(url);
        }
        const normalizedV1 = normalizeResource(resource);
        if (normalizedV1) {
          if (normalizedV1.type === 'track') harvestTracks([resource]);
          else if (normalizedV1.type === 'playlist') harvestPlaylists([resource]);
          setCachedResolve(url, normalizedV1);
          const payload = useV2 ? normalizeResourceV2(resource) : normalizedV1;
          return { result: { url: rawUrl, status: 'ok', data: payload }, index, resource: normalizedV1 };
        }
        return { result: { url: rawUrl, status: 'error', error: 'Could not parse resource' }, index };
      } catch (err) {
        return { result: { url: rawUrl, status: 'error', error: err.message || 'Resolve failed' }, index };
      }
    });

    // mapWithConcurrency preserves input order, so results and the harvest list
    // come out in request order regardless of which resolve finished first.
    for (const entry of settled) {
      if (entry.resource) resolvedResources.push(entry.resource);
      results.push(useV2 ? { ...entry.result, index: entry.index } : entry.result);
    }

    const failures = results.filter(r => r.status === 'error').length;
    const resolvedTrackIds = resolvedResources
      .filter(r => r?.type === 'track' && r.id != null)
      .map(r => r.id);
    const resolvedPlaylistIds = resolvedResources
      .filter(r => r?.type === 'playlist' && r.id != null)
      .map(r => r.id);
    if (!useV2) {
      res.json({ results });
    } else {
      res.json({
        results,
        summary: {
          total: results.length,
          ok: results.length - failures,
          error: failures
        },
        meta: {
          version: '2',
          resolved_at: nowIso()
        }
      });
    }
    logOperation({
      userId: req.user.id,
      action: 'batch-resolve',
      itemCount: urls.length,
      status: failures > 0 && failures === results.length ? 'error' : 'success',
      trackIds: resolvedTrackIds,
      playlistIds: resolvedPlaylistIds,
      errorCode: failures > 0 && failures === results.length ? 'ALL_ITEMS_FAILED' : undefined,
      errorMessage: failures > 0 && failures === results.length ? results.find(r => r.status === 'error')?.error : undefined,
      metadata: { total: results.length, succeeded: results.length - failures, failed: failures },
    });
  } catch (error) {
    logger.error('Batch resolve error:', safeError(error));
    res.status(500).json({ error: 'Batch resolve failed' });
  }
});

/**
 * GET /api/activities
 * Get the user's activity/stream feed
 */
router.get('/activities', authenticateUser, instrumentRead('activities'), validateActivities, async (req, res) => {
  try {
    const limit = req.query.limit || 200;
    const payload = await getCachedUserPayload(
      'activities',
      req.user.id,
      `limit=${limit}`,
      async () => {
        const activities = await soundcloudClient.getActivities(req.accessToken, req.refreshToken, limit);
        logger.info(`[/api/activities] Fetched ${activities.length} raw activities`);

        const trackActivities = activities.map(item => {
          if (!item.origin || item.origin.kind !== 'track') return null;
          const normalized = normalizeResource(item.origin);
          if (!normalized || normalized.type !== 'track') return null;

          return {
            type: item.type,
            created_at: item.created_at,
            reposter: item.reposter || null,
            origin: {
              ...normalized,
              duration: normalized.duration_ms,
              user: {
                ...normalized.user,
                username: normalized.user?.username || normalized.username || 'Unknown User'
              }
            }
          };
        }).filter(Boolean);

        logger.info(`[/api/activities] Returning ${trackActivities.length} valid track activities`);
        harvestTracks(trackActivities.map(a => a.origin));
        return { collection: trackActivities };
      },
      CACHE_TTL.activities,
    );
    res.json(payload);
  } catch (error) {
    logger.error('Get activities error:', safeError(error));
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

/**
 * POST /api/likes/tracks/bulk-unlike
 * Unlike multiple tracks at once
 */
router.post('/likes/tracks/bulk-unlike', authenticateUser, heavyOperationRateLimiter, validateBulkUnlike, async (req, res) => {
  const elapsed = startOperationTimer();
  try {
    const { trackIds } = req.body;
    const results = [];

    // Process sequentially to avoid SoundCloud rate limits
    for (const trackId of trackIds) {
      try {
        await soundcloudClient.unlikeTrack(req.accessToken, req.refreshToken, trackId);
        results.push({ trackId, status: 'ok' });
      } catch (err) {
        results.push({ trackId, status: 'error', error: err.message || 'Unlike failed' });
      }
      // Paced like the other bulk loops: an unpaced 100-item DELETE run was
      // the most 429-prone path in the app.
      await sleep(SC_BULK_PACING_MS);
    }

    res.json({ results });
    const succeeded = results.filter(r => r.status === 'ok').length;
    const failed = results.filter(r => r.status !== 'ok').length;
    logOperation({
      userId: req.user.id,
      action: 'bulk-unlike',
      trackCount: succeeded,
      itemCount: results.length,
      status: failed > 0 && succeeded === 0 ? 'error' : 'success',
      durationMs: elapsed(),
      clientInfo: extractClientInfo(req),
      trackIds: results.filter(r => r.status === 'ok').map(r => r.trackId),
      errorCode: failed > 0 && succeeded === 0 ? 'ALL_ITEMS_FAILED' : undefined,
      errorMessage: failed > 0 && succeeded === 0 ? results.find(r => r.status === 'error')?.error : undefined,
      metadata: { total: results.length, succeeded, failed },
    });
    // Invalidate AFTER identity is captured — the likes cache holds the full
    // track objects harvesting needs. Same tick as res.json, so no stale reads.
    const cachedLikes = requestCache.get('likes', req.user.id, 'default');
    if (Array.isArray(cachedLikes?.collection)) {
      const processed = new Set(trackIds);
      harvestTracks(cachedLikes.collection.filter(t => t && processed.has(t.id)));
    }
    invalidateUserCollections(req.user.id, ['likes']);
    // Cold-cache IDs still get names via enrichment (no-ops when already known)
    piggybackEnrichment(trackIds, req.accessToken, req.refreshToken);
  } catch (error) {
    logger.error('Bulk unlike error:', safeError(error));
    logOperation({
      userId: req.user.id,
      action: 'bulk-unlike',
      status: 'error',
      durationMs: elapsed(),
      clientInfo: extractClientInfo(req),
      trackIds: Array.isArray(req.body?.trackIds) ? req.body.trackIds : undefined,
      errorCode: error.name || 'BULK_UNLIKE_FAILED',
      errorMessage: safeError(error).message,
    });
    res.status(500).json({ error: 'Bulk unlike failed' });
  }
});

/**
 * Users with a bulk-like currently running. One at a time per user: on
 * 2026-09-22 one account had eight 100-track batches in flight at once, each
 * spending ~460s retrying 429s. In-process is enough because the app is pinned
 * to one worker (see infra/main.bicep and server/lib/social-cache.js).
 */
const bulkLikeInFlight = new Set();

/**
 * POST /api/likes/tracks/bulk-like
 * Like multiple tracks at once (e.g. "like every track in a playlist").
 * Capped at 100 per request; clients chunk larger sets.
 *
 * Stops at the first 429 that survives scRequest's own retries: once
 * SoundCloud's like limit is hit every later track fails the same way, and
 * trying them only adds ~4.6s each and more pressure on the limit. The
 * untried tracks come back as `skipped` with `rateLimited: true` so the
 * client can stop too. Also stops when the client disconnects.
 */
router.post('/likes/tracks/bulk-like', authenticateUser, heavyOperationRateLimiter, validateBulkLike, async (req, res) => {
  const userId = req.user.id;
  if (bulkLikeInFlight.has(userId)) {
    return res.status(409).json({ error: 'A bulk like is already running for your account. Wait for it to finish.' });
  }
  bulkLikeInFlight.add(userId);

  let clientDisconnected = false;
  res.on('close', () => {
    if (!res.writableEnded) clientDisconnected = true;
  });

  const elapsed = startOperationTimer();
  try {
    const { trackIds } = req.body;
    const results = [];
    let rateLimited = false;

    // Process sequentially to avoid SoundCloud rate limits.
    // NOTE: likeTrack is id-first (accessToken/refreshToken follow) — the
    // opposite of unlikeTrack. Getting this order wrong silently no-ops.
    for (const trackId of trackIds) {
      if (rateLimited || clientDisconnected) {
        results.push({ trackId, status: 'skipped' });
        continue;
      }
      try {
        await soundcloudClient.likeTrack(trackId, req.accessToken, req.refreshToken);
        results.push({ trackId, status: 'ok' });
      } catch (err) {
        results.push({ trackId, status: 'error', error: err.message || 'Like failed' });
        if (err.status === 429) {
          rateLimited = true;
          continue;
        }
      }
      await sleep(SC_BULK_PACING_MS);
    }

    if (!clientDisconnected) res.json({ results, rateLimited });
    const succeeded = results.filter(r => r.status === 'ok').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const failed = results.length - succeeded - skipped;
    const allFailed = failed > 0 && succeeded === 0;
    logOperation({
      userId,
      action: 'bulk-like',
      trackCount: succeeded,
      itemCount: results.length,
      status: allFailed ? 'error' : 'success',
      durationMs: elapsed(),
      clientInfo: extractClientInfo(req),
      trackIds: results.filter(r => r.status === 'ok').map(r => r.trackId),
      errorCode: allFailed ? (rateLimited ? 'RATE_LIMITED' : 'ALL_ITEMS_FAILED') : undefined,
      errorMessage: allFailed ? results.find(r => r.status === 'error')?.error : undefined,
      metadata: {
        total: results.length,
        succeeded,
        failed,
        ...(skipped > 0 && { skipped }),
        ...(rateLimited && { rateLimited: true }),
        ...(clientDisconnected && { clientDisconnected: true }),
      },
    });
    const cachedLikes = requestCache.get('likes', userId, 'default');
    if (Array.isArray(cachedLikes?.collection)) {
      const processed = new Set(trackIds);
      harvestTracks(cachedLikes.collection.filter(t => t && processed.has(t.id)));
    }
    invalidateUserCollections(userId, ['likes']);
    piggybackEnrichment(trackIds, req.accessToken, req.refreshToken);
  } catch (error) {
    logger.error('Bulk like error:', safeError(error));
    logOperation({
      userId,
      action: 'bulk-like',
      status: 'error',
      durationMs: elapsed(),
      clientInfo: extractClientInfo(req),
      trackIds: Array.isArray(req.body?.trackIds) ? req.body.trackIds : undefined,
      errorCode: error.name || 'BULK_LIKE_FAILED',
      errorMessage: safeError(error).message,
    });
    if (!res.headersSent) res.status(500).json({ error: 'Bulk like failed' });
  } finally {
    bulkLikeInFlight.delete(userId);
  }
});

/**
 * GET /api/followers
 * Get the user's followers list
 */
router.get('/followers', authenticateUser, instrumentRead('followers'), async (req, res) => {
  try {
    const payload = await loadCachedFollowers(req);
    res.json(payload);
  } catch (error) {
    logger.error('Get followers error:', safeError(error));
    res.status(500).json({ error: 'Failed to fetch followers' });
  }
});

/**
 * GET /api/followings
 * Get the user's followings list
 */
router.get('/followings', authenticateUser, instrumentRead('followings'), async (req, res) => {
  try {
    const payload = await loadCachedFollowings(req);
    res.json(payload);
  } catch (error) {
    logger.error('Get followings error:', safeError(error));
    res.status(500).json({ error: 'Failed to fetch followings' });
  }
});

/**
 * POST /api/followings/bulk-unfollow
 * Unfollow multiple users at once
 */
router.post('/followings/bulk-unfollow', authenticateUser, heavyOperationRateLimiter, validateBulkUnfollow, async (req, res) => {
  const elapsed = startOperationTimer();
  try {
    const { userIds } = req.body;
    const results = [];

    // Process sequentially to avoid SoundCloud rate limits
    for (const userId of userIds) {
      try {
        await soundcloudClient.unfollowUser(req.accessToken, req.refreshToken, userId);
        results.push({ userId, status: 'ok' });
      } catch (err) {
        results.push({ userId, status: 'error', error: err.message || 'Unfollow failed' });
      }
      // Paced like the other bulk loops: an unpaced 100-item DELETE run was
      // the most 429-prone path in the app.
      await sleep(SC_BULK_PACING_MS);
    }

    res.json({ results });
    const succeeded = results.filter(r => r.status === 'ok').length;
    const failed = results.filter(r => r.status !== 'ok').length;
    logOperation({
      userId: req.user.id,
      action: 'bulk-unfollow',
      itemCount: succeeded,
      status: failed > 0 && succeeded === 0 ? 'error' : 'success',
      durationMs: elapsed(),
      clientInfo: extractClientInfo(req),
      targetUserIds: results.filter(r => r.status === 'ok').map(r => r.userId),
      errorCode: failed > 0 && succeeded === 0 ? 'ALL_ITEMS_FAILED' : undefined,
      errorMessage: failed > 0 && succeeded === 0 ? results.find(r => r.status === 'error')?.error : undefined,
      metadata: { total: results.length, succeeded, failed },
    });
    invalidateUserCollections(req.user.id, ['followings']);
  } catch (error) {
    logger.error('Bulk unfollow error:', safeError(error));
    logOperation({
      userId: req.user.id,
      action: 'bulk-unfollow',
      status: 'error',
      durationMs: elapsed(),
      clientInfo: extractClientInfo(req),
      targetUserIds: Array.isArray(req.body?.userIds) ? req.body.userIds : undefined,
      errorCode: error.name || 'BULK_UNFOLLOW_FAILED',
      errorMessage: safeError(error).message,
    });
    res.status(500).json({ error: 'Bulk unfollow failed' });
  }
});

/**
 * GET /api/reposts
 * Get the authenticated user's reposts (tracks + playlists) via activity feed.
 */
router.get('/reposts', authenticateUser, instrumentRead('reposts'), async (req, res) => {
  try {
    const payload = await loadUserCollection(
      req,
      'reposts',
      () => soundcloudClient.getReposts(req.accessToken, req.refreshToken),
      (reposts) => ({ collection: reposts, total_results: reposts.length }),
    );
    res.json(payload);
  } catch (error) {
    logger.error('Get reposts error:', safeError(error));
    res.status(500).json({ error: 'Failed to fetch reposts' });
  }
});

/**
 * GET /api/recently-played
 * Get the authenticated user's recently played tracks.
 */
router.get('/recently-played', authenticateUser, instrumentRead('recently-played'), async (req, res) => {
  try {
    const payload = await getCachedUserPayload(
      'recently-played',
      req.user.id,
      'default',
      async () => {
        const recentlyPlayed = await soundcloudClient.getRecentlyPlayed(req.accessToken, req.refreshToken);
        logger.info(`[GET /api/recently-played] returning ${recentlyPlayed.length} tracks`);
        harvestTracks(recentlyPlayed);
        return { collection: recentlyPlayed };
      },
      60 * 1000 // 1 minute TTL
    );
    res.json(payload);
  } catch (error) {
    logger.error('Get recently played error:', safeError(error));
    res.status(500).json({ error: 'Failed to fetch recently played tracks' });
  }
});

/**
 * GET /api/users/:userUrn/related
 * Get related artists for a user.
 */
router.get('/users/:userUrn/related', authenticateUser, async (req, res) => {
  try {
    const { userUrn } = req.params;
    // userUrn can be a numeric ID or a soundcloud:users:123 format.
    // We trust soundcloudClient to handle either.
    const payload = await getCachedUserPayload(
      'related-artists',
      req.user.id,
      userUrn,
      async () => {
        const related = await soundcloudClient.getRelatedArtists(userUrn, req.accessToken, req.refreshToken);
        logger.info(`[GET /api/users/:userUrn/related] returning ${related.length} artists for ${userUrn}`);
        return { collection: related };
      },
      5 * 60 * 1000 // 5 minute TTL
    );
    res.json(payload);
  } catch (error) {
    logger.error('Get related artists error:', safeError(error));
    res.status(500).json({ error: 'Failed to fetch related artists' });
  }
});



/**
 * POST /api/reposts/bulk-remove
 * Remove multiple reposts at once.
 * Body: { items: Array<{ id: number; resourceType: 'track' | 'playlist' }> }
 */
router.post('/reposts/bulk-remove', authenticateUser, heavyOperationRateLimiter, validateBulkUnrepost, async (req, res) => {
  try {
    const { items } = req.body;
    const results = [];

    // Process sequentially to avoid SoundCloud rate limits
    for (const item of items) {
      try {
        await soundcloudClient.deleteRepost(req.accessToken, req.refreshToken, item.id, item.resourceType);
        results.push({ id: item.id, resourceType: item.resourceType, status: 'ok' });
      } catch (err) {
        results.push({ id: item.id, resourceType: item.resourceType, status: 'error', error: err.message || 'Remove failed' });
      }
      // Paced like the other bulk loops: an unpaced 100-item DELETE run was
      // the most 429-prone path in the app.
      await sleep(SC_BULK_PACING_MS);
    }

    res.json({ results });
    const succeeded = results.filter(r => r.status === 'ok').length;
    const failed = results.length - succeeded;
    logOperation({
      userId: req.user.id,
      action: 'bulk-remove-reposts',
      itemCount: items.length,
      status: failed > 0 && succeeded === 0 ? 'error' : 'success',
      trackIds: results.filter(r => r.status === 'ok' && r.resourceType === 'track').map(r => r.id),
      playlistIds: results.filter(r => r.status === 'ok' && r.resourceType === 'playlist').map(r => r.id),
      errorCode: failed > 0 && succeeded === 0 ? 'ALL_ITEMS_FAILED' : undefined,
      errorMessage: failed > 0 && succeeded === 0 ? results.find(r => r.status === 'error')?.error : undefined,
      metadata: { total: results.length, succeeded, failed },
    });
    const cachedReposts = requestCache.get('reposts', req.user.id, 'default');
    if (Array.isArray(cachedReposts?.collection)) {
      const processedIds = new Set(items.map(i => i.id));
      // getReposts coerces missing titles to 'Unknown' — strip that so the
      // catalog row stays pending and enrichment fetches the real title
      const touched = cachedReposts.collection
        .filter(r => r && processedIds.has(r.id))
        .map(r => (r.title === 'Unknown' ? { ...r, title: null } : r));
      harvestTracks(touched.filter(r => r.resourceType === 'track'));
      harvestPlaylists(touched.filter(r => r.resourceType === 'playlist'));
    }
    invalidateUserCollections(req.user.id, ['reposts']);
    piggybackEnrichment(items.filter(i => i.resourceType === 'track').map(i => i.id), req.accessToken, req.refreshToken);
  } catch (error) {
    logger.error('Bulk unrepost error:', safeError(error));
    logOperation({
      userId: req.user.id,
      action: 'bulk-remove-reposts',
      status: 'error',
      trackIds: Array.isArray(req.body?.items)
        ? req.body.items.filter(i => i?.resourceType === 'track').map(i => i.id)
        : undefined,
      errorCode: error.name || 'BULK_UNREPOST_FAILED',
      errorMessage: safeError(error).message,
    });
    res.status(500).json({ error: 'Bulk unrepost failed' });
  }
});


/**
 * GET /api/users/:id/profile
 * Get any user's profile
 */
router.get('/users/:id/profile', authenticateUser, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const profile = await soundcloudClient.getUserProfile(id, req.accessToken, req.refreshToken);
    res.json(profile);
  } catch (error) {
    logger.error(`Get user profile error for ${req.params.id}:`, safeError(error));
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

/**
 * GET /api/users/:id/tracks
 * Get any user's tracks
 */
router.get('/users/:id/tracks', authenticateUser, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;
    const tracks = await soundcloudClient.getUserTracks(id, req.accessToken, req.refreshToken, limit);
    res.json({ collection: tracks });
  } catch (error) {
    logger.error(`Get user tracks error for ${req.params.id}:`, safeError(error));
    res.status(500).json({ error: 'Failed to fetch user tracks' });
  }
});

/**
 * POST /api/events
 * Lightweight feature-usage event. Records a "user opened feature X" signal
 * into the operation log (namespaced `view:<feature>`) for internal product
 * analytics. No SoundCloud content or request metadata is recorded.
 */
router.post('/events', authenticateUser, validateEvent, async (req, res) => {
  // Fire-and-forget; never block or fail the client.
  void logOperation({
    userId: req.user.id,
    action: `view:${req.body.feature}`,
    status: 'success',
  });
  res.status(204).end();
});

export default router;
