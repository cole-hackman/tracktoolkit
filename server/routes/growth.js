import express from 'express';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { safeError } from '../lib/safe-error.js';
import { logOperation } from '../lib/analytics.js';
import { authenticateUser } from '../middleware/auth.js';
import { heavyOperationRateLimiter } from '../middleware/rateLimiter.js';
import { soundcloudClient } from '../lib/soundcloud-client.js';
import { sleep, SC_WRITE_PACING_MS } from '../lib/pacing.js';
import {
  invalidateUserCollections,
  loadCachedFollowings,
  loadCachedFollowers,
} from '../lib/social-cache.js';
import {
  validateGrowthDiscover,
  validateGrowthCheckFollowbacks,
  validateGrowthEngageBatch,
  validateReverseGrowthActions,
} from '../middleware/validation.js';
import {
  GrowthEngine,
  getGrowthBudget,
  getEngagementJob,
  cancelEngagementJob,
  startEngagementJob,
  serializeJob,
} from '../lib/growth-engine.js';

const growthEngine = new GrowthEngine(soundcloudClient);

const router = express.Router();

/**
 * POST /api/growth/discover
 * Discover suggested follow candidates
 */
router.post('/growth/discover', authenticateUser, heavyOperationRateLimiter, validateGrowthDiscover, async (req, res) => {
  try {
    const { inspirationUserIds, limit, strategy, genre } = req.body;

    // Never resurface anyone previously targeted (including reversed follows)
    // and preload the auth user's own lists through the shared request cache
    // (a page load of the growth tool has usually warmed the followings entry).
    const [priorTargets, followingsPayload, followersPayload] = await Promise.all([
      prisma.growthAction.findMany({
        where: { userId: req.user.id, actionType: 'follow' },
        select: { targetId: true },
        distinct: ['targetId'],
      }),
      loadCachedFollowings(req).catch(() => null),
      loadCachedFollowers(req).catch(() => null),
    ]);

    const result = await growthEngine.discoverSuggestions({
      inspirationUserIds,
      authUserId: req.user.id,
      authSoundCloudId: req.user.soundcloudId,
      accessToken: req.accessToken,
      refreshToken: req.refreshToken,
      strategy,
      limit,
      genre,
      excludedTargetIds: priorTargets.map((t) => Number(t.targetId)),
      // On a preload failure the engine falls back to fetching these itself
      authFollowingIds: followingsPayload ? followingsPayload.collection.map((u) => u.id) : null,
      authFollowerIds: followersPayload ? followersPayload.collection.map((u) => u.id) : null,
    });
    res.json(result);
    logOperation({
      userId: req.user.id,
      action: 'growth-discover',
      itemCount: result?.suggestions?.length ?? 0,
      status: 'success',
      targetUserIds: (result?.suggestions ?? []).map(s => s.user?.id).filter(id => id != null),
      trackIds: (result?.suggestions ?? []).map(s => s.suggestedTrack?.id).filter(id => id != null),
      metadata: { inspirationUserIds, genre: genre || null },
    });
  } catch (error) {
    logger.error('Growth discover error:', safeError(error));
    res.status(500).json({ error: 'Failed to run growth discovery' });
  }
});

/**
 * GET /api/growth/limits
 * Daily follow budget and session cooldown for the current user
 */
router.get('/growth/limits', authenticateUser, async (req, res) => {
  try {
    const budget = await getGrowthBudget(prisma, req.user.id);
    res.json(budget);
  } catch (error) {
    logger.error('Get growth limits error:', safeError(error));
    res.status(500).json({ error: 'Failed to fetch growth limits' });
  }
});

/**
 * POST /api/growth/engage
 * Start a paced background engagement batch (follow + optional like).
 * Server enforces the daily follow cap and session cooldown.
 */
router.post('/growth/engage', authenticateUser, heavyOperationRateLimiter, validateGrowthEngageBatch, async (req, res) => {
  try {
    const { targets, likeTracks, sessionLabel, inspirationIds, inspirationNames } = req.body;

    const budget = await getGrowthBudget(prisma, req.user.id);
    if (budget.remaining <= 0) {
      return res.status(429).json({
        error: `Daily follow limit reached (${budget.dailyCap} per 24h). Try again later.`,
        budget,
      });
    }
    if (budget.cooldownRemainingMs > 0) {
      const mins = Math.ceil(budget.cooldownRemainingMs / 60000);
      return res.status(429).json({
        error: `Session cooldown active. You can start a new batch in ${mins} minute${mins === 1 ? '' : 's'}.`,
        budget,
      });
    }
    if (targets.length > budget.remaining) {
      return res.status(400).json({
        error: `Only ${budget.remaining} follows remaining in your daily budget. Select ${budget.remaining} or fewer users.`,
        budget,
      });
    }

    const job = startEngagementJob(growthEngine, {
      prisma,
      userId: req.user.id,
      accessToken: req.accessToken,
      refreshToken: req.refreshToken,
      targets,
      likeTracks,
      sessionLabel,
      inspirationIds,
      inspirationNames,
      // Invalidate again when the job settles. The invalidation below fires
      // before a single follow has happened, so on its own it certified a
      // crawl that ran mid-job as authoritative and durable.
      onSettled: () => invalidateUserCollections(req.user.id, ['followings', 'likes']),
    });

    invalidateUserCollections(req.user.id, ['followings', 'likes']);
    res.status(202).json({ job: serializeJob(job), budget });
    logOperation({
      userId: req.user.id,
      action: 'growth-engage-start',
      itemCount: targets.length,
      status: 'success',
      targetUserIds: targets.map(t => t.userId),
      trackIds: targets.filter(t => t.likeTrackId).map(t => t.likeTrackId),
    });
  } catch (error) {
    if (error.code === 'JOB_RUNNING') {
      return res.status(409).json({ error: 'An engagement batch is already running.' });
    }
    logger.error('Growth engage error:', safeError(error));
    res.status(500).json({ error: 'Failed to start engagement batch' });
  }
});

/**
 * GET /api/growth/engage/status
 * Progress of the current (or most recent) engagement batch
 */
router.get('/growth/engage/status', authenticateUser, (req, res) => {
  const job = getEngagementJob(req.user.id);
  res.json({ job: serializeJob(job) });
});

/**
 * POST /api/growth/engage/cancel
 * Request cancellation of the running engagement batch
 */
router.post('/growth/engage/cancel', authenticateUser, (req, res) => {
  const cancelled = cancelEngagementJob(req.user.id);
  res.json({ cancelled });
});

/**
 * GET /api/growth/analytics
 * Per-seed conversion rates and follow-back timing buckets
 */
router.get('/growth/analytics', authenticateUser, async (req, res) => {
  try {
    const follows = await prisma.growthAction.findMany({
      where: { userId: req.user.id, actionType: 'follow' },
      select: {
        targetId: true,
        followedBack: true,
        checkedAt: true,
        createdAt: true,
        inspirationIds: true,
        inspirationNames: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });

    // Per-seed conversion (each follow attributes to every seed in its session)
    const seedMap = new Map(); // seedId -> { seedId, name, follows, followedBack, checked }
    for (const f of follows) {
      if (!f.inspirationIds) continue;
      const ids = f.inspirationIds.split(',').map((x) => x.trim()).filter(Boolean);
      const names = (f.inspirationNames || '').split(',').map((x) => x.trim());
      ids.forEach((id, idx) => {
        if (!seedMap.has(id)) {
          seedMap.set(id, { seedId: id, name: names[idx] || `User ${id}`, follows: 0, followedBack: 0, checked: 0 });
        }
        const entry = seedMap.get(id);
        entry.follows++;
        if (f.followedBack !== null) {
          entry.checked++;
          if (f.followedBack === true) entry.followedBack++;
        }
        // Prefer a real name if a later record has one
        if (names[idx] && entry.name.startsWith('User ')) entry.name = names[idx];
      });
    }
    const perSeed = Array.from(seedMap.values())
      .map((s) => ({ ...s, rate: s.checked > 0 ? s.followedBack / s.checked : null }))
      .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));

    // Follow-back timing buckets (days between follow and confirmation check)
    const curve = [
      { bucket: '0-3 days', followedBack: 0, notFollowedBack: 0 },
      { bucket: '4-7 days', followedBack: 0, notFollowedBack: 0 },
      { bucket: '8-14 days', followedBack: 0, notFollowedBack: 0 },
      { bucket: '15+ days', followedBack: 0, notFollowedBack: 0 },
    ];
    for (const f of follows) {
      if (f.followedBack === null || !f.checkedAt) continue;
      const days = (new Date(f.checkedAt).getTime() - new Date(f.createdAt).getTime()) / 86400000;
      const idx = days <= 3 ? 0 : days <= 7 ? 1 : days <= 14 ? 2 : 3;
      if (f.followedBack) curve[idx].followedBack++;
      else curve[idx].notFollowedBack++;
    }

    res.json({ perSeed, followBackCurve: curve, totalFollows: follows.length });
  } catch (error) {
    logger.error('Get growth analytics error:', safeError(error));
    res.status(500).json({ error: 'Failed to fetch growth analytics' });
  }
});

/**
 * GET /api/growth/history
 * Fetch past growth actions
 */
router.get('/growth/history', authenticateUser, async (req, res) => {
  try {
    const { actionType, followedBack, reversed, sessionId } = req.query;

    const whereClause = { userId: req.user.id };

    if (actionType) whereClause.actionType = actionType;
    if (reversed) whereClause.reversed = reversed === 'true';
    if (sessionId) whereClause.sessionId = sessionId;

    if (followedBack) {
      if (followedBack === 'unchecked') {
        whereClause.followedBack = null;
      } else {
        whereClause.followedBack = followedBack === 'true';
      }
    }

    const actions = await prisma.growthAction.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    // Fetch and aggregate session groups
    const allActionsForSessions = await prisma.growthAction.findMany({
      where: { userId: req.user.id },
      select: {
        sessionId: true,
        sessionLabel: true,
        actionType: true,
        followedBack: true,
        reversed: true,
        createdAt: true,
      },
    });

    const sessionGroupsMap = new Map();
    for (const act of allActionsForSessions) {
      if (!act.sessionId) continue;
      if (!sessionGroupsMap.has(act.sessionId)) {
        sessionGroupsMap.set(act.sessionId, {
          sessionId: act.sessionId,
          label: act.sessionLabel || 'Unnamed Session',
          date: act.createdAt,
          totalActions: 0,
          followedBack: 0,
          notFollowedBack: 0,
          unchecked: 0,
          reversed: 0,
        });
      }

      const s = sessionGroupsMap.get(act.sessionId);
      s.totalActions++;
      if (act.reversed) {
        s.reversed++;
      } else if (act.actionType === 'follow') {
        if (act.followedBack === true) s.followedBack++;
        else if (act.followedBack === false) s.notFollowedBack++;
        else s.unchecked++;
      }
      
      // Keep earliest/latest date?
      if (act.createdAt > s.date) s.date = act.createdAt;
    }

    const sessions = Array.from(sessionGroupsMap.values()).sort((a, b) => b.date - a.date);

    res.json({ actions, sessions });
  } catch (error) {
    logger.error('Get growth history error:', safeError(error));
    res.status(500).json({ error: 'Failed to fetch growth history' });
  }
});

/**
 * POST /api/growth/check-followbacks
 * Check reciprocation rate against the current followers list
 */
router.post('/growth/check-followbacks', authenticateUser, heavyOperationRateLimiter, validateGrowthCheckFollowbacks, async (req, res) => {
  try {
    const { sessionId } = req.body;

    logger.info(`[check-followbacks] Fetching current followers list for user ${req.user.id}`);
    const followers = await soundcloudClient.getFollowers(req.accessToken, req.refreshToken);
    const followerIds = new Set(followers.map(f => f.id));
    logger.info(`[check-followbacks] Found ${followerIds.size} total followers on SoundCloud`);

    const whereClause = {
      userId: req.user.id,
      actionType: 'follow',
      reversed: false,
    };
    if (sessionId) {
      whereClause.sessionId = sessionId;
    }

    const unreversedFollows = await prisma.growthAction.findMany({
      where: whereClause,
    });

    let checked = 0;
    let followedBack = 0;
    let didNotFollowBack = 0;
    let alreadyChecked = 0;
    const results = [];

    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    for (const action of unreversedFollows) {
      // Cooldown: skip checking if checked in the last 24 hours and already checked
      if (action.checkedAt && (Date.now() - new Date(action.checkedAt).getTime() < ONE_DAY_MS) && action.followedBack !== null) {
        alreadyChecked++;
        continue;
      }

      const isFollowingBack = followerIds.has(Number(action.targetId));
      
      await prisma.growthAction.update({
        where: { id: action.id },
        data: {
          followedBack: isFollowingBack,
          checkedAt: new Date(),
        },
      });

      results.push({
        actionId: action.id,
        targetId: Number(action.targetId),
        targetName: action.targetName,
        followedBack: isFollowingBack,
      });

      checked++;
      if (isFollowingBack) followedBack++;
      else didNotFollowBack++;
    }

    invalidateUserCollections(req.user.id, ['followers']);

    res.json({
      checked,
      followedBack,
      didNotFollowBack,
      alreadyChecked,
      results,
    });
    logOperation({
      userId: req.user.id,
      action: 'growth-check-followbacks',
      itemCount: checked,
      status: 'success',
      targetUserIds: results.map(r => Number(r.targetId)).filter(n => !isNaN(n)),
      metadata: { followedBack, didNotFollowBack, alreadyChecked },
    });
  } catch (error) {
    logger.error('Check followbacks error:', safeError(error));
    res.status(500).json({ error: 'Failed to check followbacks' });
  }
});

/**
 * POST /api/growth/reverse
 * Unfollow and/or unlike targeted growth actions
 */
router.post('/growth/reverse', authenticateUser, validateReverseGrowthActions, async (req, res) => {
  try {
    const { actionIds, filter } = req.body;
    let targets = [];

    if (actionIds) {
      targets = await prisma.growthAction.findMany({
        where: {
          id: { in: actionIds },
          userId: req.user.id,
          reversed: false,
        },
      });
    } else if (filter) {
      const whereClause = {
        userId: req.user.id,
        reversed: false,
      };
      if (filter.sessionId) whereClause.sessionId = filter.sessionId;
      if (filter.actionType) whereClause.actionType = filter.actionType;
      
      if (filter.followedBack !== undefined) {
        whereClause.followedBack = filter.followedBack;
      }

      targets = await prisma.growthAction.findMany({
        where: whereClause,
      });
    }

    logger.info(`[reverse] Initiating reversal of ${targets.length} growth actions`);
    const results = [];
    let reversed = 0;
    let failed = 0;

    for (const action of targets) {
      try {
        if (action.actionType === 'follow') {
          await soundcloudClient.unfollowUser(req.accessToken, req.refreshToken, action.targetId);
        } else if (action.actionType === 'like') {
          await soundcloudClient.unlikeTrack(req.accessToken, req.refreshToken, action.targetId);
        }

        await prisma.growthAction.update({
          where: { id: action.id },
          data: {
            reversed: true,
            reversedAt: new Date(),
          },
        });

        results.push({ actionId: action.id, targetId: action.targetId, status: 'reversed' });
        reversed++;
      } catch (err) {
        logger.error(`Failed to reverse growth action ${action.id}:`, safeError(err));
        results.push({ actionId: action.id, targetId: action.targetId, status: 'error', error: 'Reversal failed' });
        failed++;
      }
      // sequential delay
      await sleep(SC_WRITE_PACING_MS);
    }

    invalidateUserCollections(req.user.id, ['followings', 'likes']);

    res.json({
      reversed,
      failed,
      results,
    });
    // 'partial' (not 'split') for partial failures — 'split' means playlist auto-splitting.
    logOperation({
      userId: req.user.id,
      action: 'growth-reverse',
      itemCount: targets.length,
      status: failed === 0 ? 'success' : (reversed > 0 ? 'partial' : 'error'),
      targetUserIds: targets.filter(t => t.actionType === 'follow' && results.some(r => r.actionId === t.id && r.status === 'reversed')).map(t => t.targetId),
      trackIds: targets.filter(t => t.actionType === 'like' && results.some(r => r.actionId === t.id && r.status === 'reversed')).map(t => t.targetId),
      errorCode: failed > 0 && reversed === 0 ? 'ALL_ITEMS_FAILED' : undefined,
      metadata: { total: targets.length, succeeded: reversed, failed },
    });
  } catch (error) {
    logger.error('Reverse growth actions error:', safeError(error));
    res.status(500).json({ error: 'Reversal operation failed' });
  }
});

/**
 * GET /api/growth/stats
 * Stats summary of growth features
 */
router.get('/growth/stats', authenticateUser, async (req, res) => {
  try {
    const totalFollowed = await prisma.growthAction.count({
      where: { userId: req.user.id, actionType: 'follow' },
    });
    const totalLiked = await prisma.growthAction.count({
      where: { userId: req.user.id, actionType: 'like' },
    });
    const followedBackCount = await prisma.growthAction.count({
      where: { userId: req.user.id, actionType: 'follow', followedBack: true },
    });
    const didNotFollowBackCount = await prisma.growthAction.count({
      where: { userId: req.user.id, actionType: 'follow', followedBack: false },
    });
    const activeFollows = await prisma.growthAction.count({
      where: { userId: req.user.id, actionType: 'follow', reversed: false },
    });
    const reversedFollows = await prisma.growthAction.count({
      where: { userId: req.user.id, actionType: 'follow', reversed: true },
    });
    const uncheckedFollows = await prisma.growthAction.count({
      where: { userId: req.user.id, actionType: 'follow', followedBack: null },
    });

    const totalFollowsChecked = followedBackCount + didNotFollowBackCount;
    const followedBackRate = totalFollowsChecked > 0 ? (followedBackCount / totalFollowsChecked) : 0;

    res.json({
      totalFollowed,
      totalLiked,
      followedBackRate,
      activeFollows,
      reversedFollows,
      uncheckedFollows,
    });
  } catch (error) {
    logger.error('Get growth stats error:', safeError(error));
    res.status(500).json({ error: 'Failed to fetch growth stats' });
  }
});

export default router;
