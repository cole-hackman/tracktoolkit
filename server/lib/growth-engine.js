import logger from './logger.js';
import { sleep } from './pacing.js';
import { findGenreFocusMatch } from './genres.js';

const DISCOVERY_TRACK_CONCURRENCY = 5;
// Per seed and per direction (followers/followings), sample only the most
// recent slice of a large network. SoundCloud returns newest first, so this
// keeps the crawl bounded on 20k+ follower artists while biasing toward
// recently active accounts.
export const SEED_SAMPLE_MAX = 1000;
const SEED_CRAWL_CONCURRENCY = 2;
// Discovery runs inside a synchronous HTTP request; stay well under the
// platform gateway timeout and return partial results instead of failing.
export const DISCOVERY_TIME_BUDGET_MS = 45_000;
// With a genre focus the per-candidate track lookup (the only place a
// candidate's genre becomes known) is widened from `limit` to this many of the
// top-scored candidates: up to +100 /users/:id/tracks calls per scan.
export const GENRE_FOCUS_LOOKUP_MAX = 150;

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

/* ── Safety limits ─────────────────────────────────────────────────────────
 * SoundCloud flags aggressive follow activity. These caps are enforced
 * server-side regardless of what the client requests.
 */
export const GROWTH_DAILY_FOLLOW_CAP = 50;
export const GROWTH_SESSION_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between sessions
export const GROWTH_BATCH_MAX = 50;
// Jittered pacing between follow actions in a batch (feature: server-side pacing)
const BATCH_DELAY_MIN_MS = 2000;
const BATCH_DELAY_JITTER_MS = 3000;

/**
 * Compute the user's remaining follow budget and session cooldown.
 * Counts every follow action in the last 24h (reversed or not — reversing
 * doesn't refund budget, since the write still happened on SoundCloud).
 */
export async function getGrowthBudget(prisma, userId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const used24h = await prisma.growthAction.count({
    where: { userId, actionType: 'follow', createdAt: { gte: since } },
  });

  const lastAction = await prisma.growthAction.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, sessionId: true },
  });

  let cooldownRemainingMs = 0;
  if (lastAction) {
    const elapsed = Date.now() - new Date(lastAction.createdAt).getTime();
    cooldownRemainingMs = Math.max(0, GROWTH_SESSION_COOLDOWN_MS - elapsed);
  }

  return {
    dailyCap: GROWTH_DAILY_FOLLOW_CAP,
    used24h,
    remaining: Math.max(0, GROWTH_DAILY_FOLLOW_CAP - used24h),
    cooldownRemainingMs,
    lastSessionId: lastAction?.sessionId ?? null,
  };
}

/* ── In-memory engagement job registry ─────────────────────────────────────
 * One active job per user. Single-instance deployment assumption matches
 * the existing in-memory resolve cache.
 */
const engagementJobs = new Map(); // userId -> job

const JOB_RETENTION_MS = 30 * 60 * 1000;

export function getEngagementJob(userId) {
  const job = engagementJobs.get(userId);
  if (!job) return null;
  if (job.status !== 'running' && Date.now() - job.finishedAt > JOB_RETENTION_MS) {
    engagementJobs.delete(userId);
    return null;
  }
  return job;
}

export function cancelEngagementJob(userId) {
  const job = engagementJobs.get(userId);
  if (job && job.status === 'running') {
    job.cancelRequested = true;
    return true;
  }
  return false;
}

export class GrowthEngine {
  constructor(soundcloudClient) {
    this.soundcloudClient = soundcloudClient;
  }

  /**
   * Run the discovery algorithm to find suggested follow candidates.
   * excludedTargetIds: SoundCloud user IDs previously targeted by growth
   * actions (including reversed ones) so they never resurface.
   * authFollowingIds / authFollowerIds: preloaded (e.g. cached) SoundCloud
   * user ids for the auth user's own lists; null means fetch them here.
   */
  async discoverSuggestions({
    inspirationUserIds,
    authUserId,
    authSoundCloudId,
    accessToken,
    refreshToken,
    strategy = 'followers',
    limit = 50,
    excludedTargetIds = [],
    authFollowingIds = null,
    authFollowerIds = null,
    timeBudgetMs = DISCOVERY_TIME_BUDGET_MS,
    genre = null,
  }) {
    const startedAt = Date.now();
    const deadlineAt = startedAt + timeBudgetMs;
    logger.info(`[GrowthEngine] Starting discovery for user ${authUserId} (${authSoundCloudId}) with strategy=${strategy}, limit=${limit}, timeBudgetMs=${timeBudgetMs}`);

    // 1. Auth user's followings and followers for filtering — use preloaded
    // ids when the caller has them cached; fetch only what's missing.
    let authFollowingsSet = new Set(authFollowingIds ?? []);
    let authFollowersSet = new Set(authFollowerIds ?? []);

    const [followingsResult, followersResult] = await Promise.allSettled([
      authFollowingIds === null
        ? this.soundcloudClient.getFollowings(accessToken, refreshToken)
        : Promise.resolve(null),
      authFollowerIds === null
        ? this.soundcloudClient.getFollowers(accessToken, refreshToken)
        : Promise.resolve(null),
    ]);

    if (followingsResult.status === 'fulfilled') {
      (followingsResult.value || []).forEach(u => authFollowingsSet.add(u.id));
      logger.info(`[GrowthEngine] Found ${authFollowingsSet.size} existing followings${authFollowingIds !== null ? ' (preloaded)' : ''}`);
    } else {
      logger.error(`[GrowthEngine] Failed to fetch auth user's followings:`, followingsResult.reason);
    }

    if (followersResult.status === 'fulfilled') {
      (followersResult.value || []).forEach(u => authFollowersSet.add(u.id));
      logger.info(`[GrowthEngine] Found ${authFollowersSet.size} existing followers${authFollowerIds !== null ? ' (preloaded)' : ''}`);
    } else {
      logger.error(`[GrowthEngine] Failed to fetch auth user's followers:`, followersResult.reason);
    }

    const excludedSet = new Set(excludedTargetIds);
    const candidateMap = new Map(); // id -> { user, appearances: Set, isRelated: boolean }
    const seedGenres = new Map(); // genre -> weight

    // 2. Fetch candidates from inspiration users. Follower/following crawls
    // are capped at the most recent SEED_SAMPLE_MAX per seed, so running a
    // couple of seeds concurrently stays bounded even for huge artists.
    const seedCrawls = await mapWithConcurrency(inspirationUserIds, SEED_CRAWL_CONCURRENCY, async (inspId) => {
      if (Date.now() >= deadlineAt) {
        logger.warn(`[GrowthEngine] Time budget exhausted before crawling inspiration ${inspId}; skipping`);
        return { inspId, skipped: true };
      }
      logger.info(`[GrowthEngine] Crawling network for inspiration user: ${inspId}`);

      const crawlOptions = { maxItems: SEED_SAMPLE_MAX, deadlineAt };
      const [seedTracksResult, followersResult, peersResult, relatedResult] = await Promise.allSettled([
        this.soundcloudClient.getUserTracks(inspId, accessToken, refreshToken, 10),
        (strategy === 'followers' || strategy === 'both')
          ? this.soundcloudClient.getUserFollowers(inspId, accessToken, refreshToken, 200, crawlOptions)
          : Promise.resolve(null),
        (strategy === 'followings' || strategy === 'both')
          ? this.soundcloudClient.getUserFollowings(inspId, accessToken, refreshToken, 200, crawlOptions)
          : Promise.resolve(null),
        this.soundcloudClient.getRelatedArtists(inspId, accessToken, refreshToken, 20),
      ]);

      return { inspId, skipped: false, seedTracksResult, followersResult, peersResult, relatedResult };
    });

    // Was the deadline already spent when the crawl phase ended? Then a seed's
    // pagination may have stopped early. Measured here, before the track
    // lookups, so lookups that merely finish late do not count as a cut crawl.
    const crawlEndedPastDeadline = Date.now() >= deadlineAt;

    // Merge crawl results sequentially in seed order so appearance counts and
    // isRelated flags come out identical to the old sequential crawl.
    for (const crawl of seedCrawls) {
      if (crawl.skipped) continue;
      const { inspId, seedTracksResult, followersResult, peersResult, relatedResult } = crawl;

      if (seedTracksResult.status === 'fulfilled') {
        const seedTracks = seedTracksResult.value;
        for (const t of seedTracks || []) {
          for (const g of extractGenres(t)) {
            seedGenres.set(g, (seedGenres.get(g) || 0) + 1);
          }
        }
      } else {
        logger.debug(`[GrowthEngine] Seed genre fetch failed for ${inspId}: ${seedTracksResult.reason?.message}`);
      }

      // Path A: the inspiration's followers (their audience)
      if (strategy === 'followers' || strategy === 'both') {
        if (followersResult.status === 'fulfilled') {
          const followers = followersResult.value || [];
          logger.info(`[GrowthEngine] Path A: Found ${followers.length} followers for inspiration ${inspId}`);
          for (const u of followers) {
            if (!candidateMap.has(u.id)) {
              candidateMap.set(u.id, { user: u, appearances: new Set(), isRelated: false });
            }
            candidateMap.get(u.id).appearances.add(inspId);
          }
        } else {
          logger.error(`[GrowthEngine] Path A crawl failed for user ${inspId}:`, followersResult.reason);
        }
      }

      // Path A2: who the inspiration follows (their peers)
      if (strategy === 'followings' || strategy === 'both') {
        if (peersResult.status === 'fulfilled') {
          const peers = peersResult.value || [];
          logger.info(`[GrowthEngine] Path A2: Found ${peers.length} followings for inspiration ${inspId}`);
          for (const u of peers) {
            if (!candidateMap.has(u.id)) {
              candidateMap.set(u.id, { user: u, appearances: new Set(), isRelated: false });
            }
            candidateMap.get(u.id).appearances.add(inspId);
          }
        } else {
          logger.error(`[GrowthEngine] Path A2 crawl failed for user ${inspId}:`, peersResult.reason);
        }
      }

      // Path B: related artists
      if (relatedResult.status === 'fulfilled') {
        const related = relatedResult.value || [];
        logger.info(`[GrowthEngine] Path B: Found ${related.length} related artists for inspiration ${inspId}`);
        for (const u of related) {
          if (!candidateMap.has(u.id)) {
            candidateMap.set(u.id, { user: u, appearances: new Set(), isRelated: true });
          } else {
            candidateMap.get(u.id).isRelated = true;
          }
          candidateMap.get(u.id).appearances.add(inspId);
        }
      } else {
        logger.error(`[GrowthEngine] Path B crawl failed for user ${inspId}:`, relatedResult.reason);
      }
    }

    const perSeed = seedCrawls.map((crawl) => {
      const followersFetched = crawl.followersResult?.status === 'fulfilled' ? (crawl.followersResult.value?.length ?? 0) : 0;
      const followingsFetched = crawl.peersResult?.status === 'fulfilled' ? (crawl.peersResult.value?.length ?? 0) : 0;
      return {
        id: crawl.inspId,
        followersFetched,
        followingsFetched,
        sampled: followersFetched >= SEED_SAMPLE_MAX || followingsFetched >= SEED_SAMPLE_MAX,
        skipped: Boolean(crawl.skipped),
      };
    });

    const candidates = Array.from(candidateMap.values());
    logger.info(`[GrowthEngine] Total unique candidates found across all paths: ${candidates.length}`);

    // 3. Filter candidates
    const filteredCandidates = candidates.filter(({ user }) => {
      // Exclude self
      if (user.id === authSoundCloudId) return false;
      // Exclude already followed
      if (authFollowingsSet.has(user.id)) return false;
      // Exclude already following you
      if (authFollowersSet.has(user.id)) return false;
      // Exclude anyone previously targeted by a growth action (incl. reversed)
      if (excludedSet.has(user.id)) return false;
      // Filter out obvious spam/inactive bots (0 followers AND 0 tracks)
      if ((user.followers_count || 0) === 0 && (user.track_count || 0) === 0) return false;

      return true;
    });

    logger.info(`[GrowthEngine] Candidates remaining after filtering: ${filteredCandidates.length}`);

    // 4. Score candidates (genre affinity neutral until tracks are fetched)
    const scoredSuggestions = filteredCandidates.map(({ user, appearances, isRelated }) => {
      const scoreData = this.scoreCandidate(user, appearances.size, inspirationUserIds.length, isRelated);
      return {
        user: {
          id: user.id,
          username: user.username,
          avatar_url: user.avatar_url,
          permalink_url: user.permalink_url,
          followers_count: user.followers_count || 0,
          followings_count: user.followings_count || 0,
          track_count: user.track_count || 0,
        },
        _rawUser: user,
        score: scoreData.score,
        scoreLabel: scoreData.scoreLabel,
        signals: scoreData.signals,
      };
    });

    // 5. Sort by score descending and limit
    scoredSuggestions.sort((a, b) => b.score - a.score);
    // A genre focus has to look at more candidates than it returns: genre is
    // only known after the track lookup below, so the slice is widened.
    const lookupCount = genre
      ? Math.min(GENRE_FOCUS_LOOKUP_MAX, scoredSuggestions.length)
      : limit;
    const topSuggestions = scoredSuggestions.slice(0, lookupCount);

    // 6. Fetch best track for top suggestions and apply genre-affinity re-score
    logger.info(`[GrowthEngine] Fetching best tracks for top ${topSuggestions.length} candidates`);
    const results = await mapWithConcurrency(topSuggestions, DISCOVERY_TRACK_CONCURRENCY, async (sug) => {
      let suggestedTrack = null;
      let genreAffinity = null;
      let candidateGenres = [];
      let genreTokens = new Set();
      let skipped = false;
      // Past the time budget, skip the lookup: null affinity keeps the score
      // neutral, exactly like the failed-fetch path below.
      try {
        if (Date.now() >= deadlineAt) skipped = true;
        const tracks = skipped
          ? null
          : await this.soundcloudClient.getUserTracks(sug.user.id, accessToken, refreshToken, 5);
        if (tracks && tracks.length > 0) {
          genreAffinity = computeGenreAffinity(tracks, seedGenres);
          candidateGenres = topGenres(tracks, 3);
          genreTokens = new Set();
          for (const t of tracks) for (const g of extractGenres(t)) genreTokens.add(g);
          const sortedTracks = [...tracks].sort((a, b) => (b.likes_count || 0) - (a.likes_count || 0));
          const best = sortedTracks[0];
          suggestedTrack = {
            id: best.id,
            title: best.title,
            artwork_url: best.artwork_url || sug.user.avatar_url,
            likes_count: best.likes_count || 0,
            playback_count: best.playback_count || 0,
            permalink_url: best.permalink_url,
            created_at: best.created_at,
          };
        }
      } catch (err) {
        logger.debug(`[GrowthEngine] Failed to fetch tracks for candidate ${sug.user.id}: ${err.message}`);
      }

      // Re-score with real genre affinity when we have it
      const rescored = this.scoreCandidate(
        sug._rawUser,
        sug.signals.sharedInspirationCount,
        inspirationUserIds.length,
        sug.signals.isRelatedArtist,
        genreAffinity
      );

      return {
        user: sug.user,
        score: rescored.score,
        scoreLabel: rescored.scoreLabel,
        signals: rescored.signals,
        suggestedTrack,
        genres: candidateGenres,
        _genreTokens: genreTokens,
        _genreSkipped: skipped,
      };
    });

    // Candidates whose track lookup never ran because the deadline had passed.
    // Reported with or without a focus so an unfocused scan can warn too.
    const lookupsSkipped = results.filter((r) => r._genreSkipped).length;
    let finalResults = results;
    let genreChecked = null;
    let genreMatched = null;
    let genreUnknown = null;
    let genreSkipped = null;
    // With a focus keep only candidates whose fetched tracks match. A candidate
    // whose genre could not be established is excluded and counted, never
    // guessed. Skipped = the deadline passed before its lookup ran; unknown =
    // the lookup ran but gave no genre (failed, no tracks, no metadata).
    if (genre) {
      genreSkipped = lookupsSkipped;
      genreChecked = results.length - genreSkipped;
      genreUnknown = results.filter((r) => !r._genreSkipped && r._genreTokens.size === 0).length;
      finalResults = [];
      for (const r of results) {
        const hit = findGenreFocusMatch(r._genreTokens, genre);
        if (hit === null) continue;
        // The token that matched leads, so the chip explains the match.
        r.genres = [hit, ...r.genres.filter((g) => g !== hit)].slice(0, 3);
        finalResults.push(r);
      }
      genreMatched = finalResults.length;
    }
    for (const r of results) {
      delete r._genreTokens;
      delete r._genreSkipped;
    }

    // Genre affinity can reorder the top set
    finalResults.sort((a, b) => b.score - a.score);
    finalResults = finalResults.slice(0, limit);

    return {
      suggestions: finalResults,
      stats: {
        inspirationUsers: inspirationUserIds.length,
        candidatesScanned: candidates.length,
        afterDedup: filteredCandidates.length,
        suggestionsReturned: finalResults.length,
        genreFocus: genre || null,
        genreChecked,
        genreMatched,
        genreUnknown,
        genreSkipped,
        lookupsSkipped,
        seedGenres: Array.from(seedGenres.keys()).slice(0, 10),
        trackLookupConcurrency: DISCOVERY_TRACK_CONCURRENCY,
        durationMs: Date.now() - startedAt,
        sampleCapPerSeed: SEED_SAMPLE_MAX,
        sampledFollowers: perSeed.some((s) => s.sampled),
        partial: Date.now() >= deadlineAt || perSeed.some((s) => s.skipped),
        // The crawl itself was cut short (a seed skipped, or the deadline hit
        // before it finished); distinct from candidate lookups being skipped.
        crawlPartial: crawlEndedPastDeadline || perSeed.some((s) => s.skipped),
        perSeed,
        timeBudgetMs,
      },
    };
  }

  /**
   * Score a single candidate.
   * Genre affinity with the seed scene is the point of the tool; the
   * follow-back ratio is deliberately a minor signal (see audit 2026-07-09).
   * Weights: genre 0.20, overlap 0.25, related 0.15, creator 0.15,
   * activity 0.15, follow-ratio 0.10.
   */
  scoreCandidate(user, appearancesCount, totalInspirations, isRelated, genreAffinity = null) {
    const followers = user.followers_count || 0;
    const followings = user.followings_count || 0;
    const tracks = user.track_count || 0;

    // A. Following-to-Follower Ratio Score (10%)
    const ratio = followers > 0 ? followings / followers : followings;
    const clampedRatio = Math.min(Math.max(ratio, 0), 5);
    const ratioScore = clampedRatio / 5.0;

    // B. Shared Network Overlap Score (25%)
    const overlapScore = totalInspirations > 0 ? appearancesCount / totalInspirations : 0;

    // C. Related artists boost (15%)
    const relatedBoost = isRelated ? 1.0 : 0.0;

    // D. Creator Signal Score (15%)
    const creatorScore = tracks > 0 ? Math.min(tracks / 10, 1.0) : 0.0;

    // E. Activity Recency (15%)
    let activityScore = 0.5; // neutral default
    if (user.last_modified) {
      try {
        const modifiedDate = new Date(user.last_modified);
        const diffDays = (Date.now() - modifiedDate.getTime()) / (1000 * 60 * 60 * 24);
        if (diffDays < 30) activityScore = 1.0;
        else if (diffDays < 90) activityScore = 0.5;
        else activityScore = 0.1;
      } catch {
        activityScore = 0.5;
      }
    }

    // F. Genre affinity with the seed scene (20%); neutral when unknown
    const genreScore = genreAffinity === null ? 0.5 : genreAffinity;

    const rawScore =
      (ratioScore * 0.10) +
      (overlapScore * 0.25) +
      (relatedBoost * 0.15) +
      (creatorScore * 0.15) +
      (activityScore * 0.15) +
      (genreScore * 0.20);

    const score = Math.round(rawScore * 100);

    // SoundCloud frequently omits both genre metadata and last_modified. Do
    // not present a neutral, partially inferred score as a confident match.
    const hasSceneEvidence = genreAffinity !== null;
    const hasActivityEvidence = Boolean(user.last_modified);
    let scoreLabel = score < 40 ? 'low' : 'limited';
    if (hasSceneEvidence && hasActivityEvidence) {
      scoreLabel = 'low';
      if (score >= 70) scoreLabel = 'high';
      else if (score >= 40) scoreLabel = 'medium';
    }

    return {
      score,
      scoreLabel,
      signals: {
        followBackRatio: Math.round(ratio * 100) / 100,
        sharedInspirationCount: appearancesCount,
        isRelatedArtist: isRelated,
        isCreator: tracks > 0,
        genreAffinity: genreAffinity === null ? null : Math.round(genreAffinity * 100) / 100,
        evidence: {
          hasSceneEvidence,
          hasActivityEvidence,
        },
      },
    };
  }

  /**
   * Run a paced engagement batch as a background job.
   * Follows each target (and optionally likes their track) with a jittered
   * delay between writes. Progress is tracked on the shared job object.
   */
  async runEngagementBatch(job, { prisma, accessToken, refreshToken }) {
    for (let i = 0; i < job.targets.length; i++) {
      if (job.cancelRequested) {
        job.status = 'cancelled';
        break;
      }

      const target = job.targets[i];
      try {
        await this.soundcloudClient.followUser(target.userId, accessToken, refreshToken);
        job.followed++;
        await prisma.growthAction.create({
          data: {
            userId: job.userId,
            actionType: 'follow',
            targetId: target.userId,
            targetName: target.targetName ?? null,
            targetAvatar: target.targetAvatar ?? null,
            targetFollowers: target.targetFollowers ?? null,
            targetFollowings: target.targetFollowings ?? null,
            sessionId: job.sessionId,
            sessionLabel: job.sessionLabel,
            inspirationIds: job.inspirationIds,
            inspirationNames: job.inspirationNames,
          },
        });
      } catch (err) {
        logger.error(`[GrowthEngine] Batch follow failed for ${target.userId}:`, err?.message || err);
        job.errors.push({ targetId: target.userId, action: 'follow', error: 'Follow failed' });
      }

      if (job.likeTracks && target.likeTrackId) {
        await sleep(BATCH_DELAY_MIN_MS / 2 + Math.random() * 1000);
        if (job.cancelRequested) {
          job.status = 'cancelled';
          break;
        }
        try {
          await this.soundcloudClient.likeTrack(target.likeTrackId, accessToken, refreshToken);
          job.liked++;
          await prisma.growthAction.create({
            data: {
              userId: job.userId,
              actionType: 'like',
              targetId: target.likeTrackId,
              targetName: target.targetName ? `${target.targetName} - Track` : 'Track',
              targetAvatar: target.targetAvatar ?? null,
              sessionId: job.sessionId,
              sessionLabel: job.sessionLabel,
              inspirationIds: job.inspirationIds,
              inspirationNames: job.inspirationNames,
            },
          });
        } catch (err) {
          logger.error(`[GrowthEngine] Batch like failed for track ${target.likeTrackId}:`, err?.message || err);
          job.errors.push({ targetId: target.likeTrackId, action: 'like', error: 'Like failed' });
        }
      }

      job.current = i + 1;

      if (i < job.targets.length - 1 && !job.cancelRequested) {
        await sleep(BATCH_DELAY_MIN_MS + Math.random() * BATCH_DELAY_JITTER_MS);
      }
    }

    if (job.status === 'running') job.status = 'complete';
    job.finishedAt = Date.now();
    logger.info(`[GrowthEngine] Engagement batch ${job.sessionId} finished: status=${job.status}, followed=${job.followed}, liked=${job.liked}, errors=${job.errors.length}`);
  }
}

/**
 * Start an engagement batch job for a user. Returns the job object.
 * Throws if a job is already running for this user.
 */
export function startEngagementJob(engine, {
  prisma,
  userId,
  accessToken,
  refreshToken,
  targets,
  likeTracks,
  sessionLabel,
  inspirationIds,
  inspirationNames,
  onSettled = null,
}) {
  const existing = engagementJobs.get(userId);
  if (existing && existing.status === 'running') {
    const err = new Error('An engagement batch is already running');
    err.code = 'JOB_RUNNING';
    throw err;
  }

  const job = {
    userId,
    sessionId: `sess_${Date.now()}`,
    sessionLabel,
    inspirationIds,
    inspirationNames,
    targets,
    likeTracks: Boolean(likeTracks),
    status: 'running',
    current: 0,
    total: targets.length,
    followed: 0,
    liked: 0,
    errors: [],
    cancelRequested: false,
    startedAt: Date.now(),
    finishedAt: null,
  };
  engagementJobs.set(userId, job);

  // Fires exactly once when the job reaches any terminal state — complete,
  // cancelled, or crashed. The route uses it to invalidate the followings and
  // likes caches AFTER the follows have actually happened. Invalidating only
  // at start certified a mid-job crawl as authoritative: it took the job-start
  // mark, passed every check, and was persisted to the durable tier as a
  // 'complete' snapshot reflecting 8 of 50 follows for the 30-minute TTL.
  // Injected rather than imported so this module stays free of cache concerns.
  const settle = () => {
    if (typeof onSettled !== 'function') return;
    try {
      onSettled(job);
    } catch (err) {
      logger.warn('[GrowthEngine] onSettled threw:', err?.message || err);
    }
  };

  engine
    .runEngagementBatch(job, { prisma, accessToken, refreshToken })
    .then(settle)
    .catch((err) => {
      logger.error('[GrowthEngine] Engagement batch crashed:', err?.message || err);
      job.status = 'error';
      job.finishedAt = Date.now();
      settle();
    });

  return job;
}

/** Public snapshot of a job (no tokens, no raw errors). */
export function serializeJob(job) {
  if (!job) return null;
  return {
    sessionId: job.sessionId,
    sessionLabel: job.sessionLabel,
    status: job.status,
    current: job.current,
    total: job.total,
    followed: job.followed,
    liked: job.liked,
    errorCount: job.errors.length,
    likeTracks: job.likeTracks,
  };
}

/* ── Genre helpers ── */

function extractGenres(track) {
  const genres = new Set();
  if (track?.genre && typeof track.genre === 'string') {
    const g = track.genre.trim().toLowerCase();
    if (g) genres.add(g);
  }
  if (track?.tag_list && typeof track.tag_list === 'string') {
    // tag_list is space-separated with quoted multi-word tags
    const matches = track.tag_list.match(/"[^"]+"|\S+/g) || [];
    for (const m of matches.slice(0, 8)) {
      const tag = m.replace(/"/g, '').trim().toLowerCase();
      if (tag.length > 1) genres.add(tag);
    }
  }
  return genres;
}

/** Up to `n` genre tokens across the tracks, most frequent first. */
function topGenres(tracks, n) {
  const counts = new Map();
  for (const t of tracks || []) {
    for (const g of extractGenres(t)) counts.set(g, (counts.get(g) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([g]) => g);
}

function computeGenreAffinity(candidateTracks, seedGenres) {
  if (!seedGenres || seedGenres.size === 0) return null;
  const candidateGenres = new Set();
  for (const t of candidateTracks || []) {
    for (const g of extractGenres(t)) candidateGenres.add(g);
  }
  if (candidateGenres.size === 0) return 0;
  let hits = 0;
  for (const g of candidateGenres) {
    if (seedGenres.has(g)) hits++;
  }
  // Fraction of the candidate's genres that overlap the seed scene
  return Math.min(1, hits / Math.min(candidateGenres.size, 5));
}
