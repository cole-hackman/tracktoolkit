import prisma from './prisma.js';
import logger from './logger.js';
import { decrypt } from './crypto.js';
import { safeError } from './safe-error.js';
import { sleep } from './pacing.js';
import { runWithTokenContext } from './token-context.js';
import { backgroundJobsAllowed } from './background-jobs.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const INITIAL_DELAY_MS = 5 * 60 * 1000; // let the server settle first
const MIN_FOLLOW_AGE_MS = 2 * 24 * 60 * 60 * 1000; // give people time to reciprocate
const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;
const USER_CHECK_DELAY_MS = 400;

/**
 * Scheduled follow-back verification. Finds users with pending growth
 * follows, refreshes their follower list once, and marks reciprocation —
 * the same logic as POST /api/growth/check-followbacks, run daily so the
 * history stays fresh without the user clicking anything.
 */
export async function runScheduledFollowbackChecks(soundcloudClient) {
  const cutoffCreated = new Date(Date.now() - MIN_FOLLOW_AGE_MS);
  const cutoffChecked = new Date(Date.now() - RECHECK_AFTER_MS);

  const pending = await prisma.growthAction.findMany({
    where: {
      actionType: 'follow',
      reversed: false,
      createdAt: { lte: cutoffCreated },
      OR: [
        { checkedAt: null },
        { AND: [{ checkedAt: { lte: cutoffChecked } }, { followedBack: null }] },
      ],
    },
    select: { id: true, userId: true, targetId: true },
  });

  if (pending.length === 0) return { usersChecked: 0, actionsChecked: 0 };

  const byUser = new Map();
  for (const action of pending) {
    if (!byUser.has(action.userId)) byUser.set(action.userId, []);
    byUser.get(action.userId).push(action);
  }

  let usersChecked = 0;
  let actionsChecked = 0;
  let hasFetchedFollowers = false;

  for (const [userId, actions] of byUser) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { tokens: true },
      });
      if (!user || !user.tokens.length) continue;

      const token = user.tokens[0];
      const accessToken = decrypt(token.encrypted, process.env.ENCRYPTION_KEY);
      const refreshToken = decrypt(token.refresh, process.env.ENCRYPTION_KEY);

      if (hasFetchedFollowers) await sleep(USER_CHECK_DELAY_MS);
      // The token context is not optional here, and it is the whole reason
      // this line looks the way it does.
      //
      // This job runs from a boot-time timer, so there is no request and no
      // AsyncLocalStorage store — `authenticateUser` is the only other place
      // that opens one. Without it, a 401 inside `getFollowers` reaches
      // `refreshTokensAndPersist` with no userId: SoundCloud rotates the
      // refresh token, there is nobody to persist the replacement against,
      // and the row is left holding a token SoundCloud has already consumed.
      // The user's next request presents it, is refused with invalid_grant,
      // and — because the stored token really is the one presented —
      // `_resolveInvalidGrant` correctly concludes "revoked" and deletes
      // their tokens, stamping the six-day deletion clock. A daily job
      // against users whose access token is almost always expired made that
      // the common case, not an edge one.
      //
      // With the context, the refresh persists exactly as it would in a
      // request. `_refreshAndPersistNow` now also refuses a context-free
      // exchange outright, so a future caller that forgets this fails loudly
      // instead of stranding somebody.
      const followers = await runWithTokenContext({ userId }, () =>
        soundcloudClient.getFollowers(accessToken, refreshToken));
      hasFetchedFollowers = true;
      const followerIds = new Set(followers.map((f) => f.id));

      for (const action of actions) {
        await prisma.growthAction.update({
          where: { id: action.id },
          data: {
            followedBack: followerIds.has(Number(action.targetId)),
            checkedAt: new Date(),
          },
        });
        actionsChecked++;
      }
      usersChecked++;
    } catch (err) {
      logger.error(`[GrowthScheduler] Follow-back check failed for user ${userId}:`, safeError(err));
    }
  }

  logger.info(`[GrowthScheduler] Checked ${actionsChecked} follows across ${usersChecked} users`);
  return { usersChecked, actionsChecked };
}

/**
 * Start the daily follow-back scheduler. Production only; disable with
 * GROWTH_AUTOCHECK=false.
 */
export function startGrowthScheduler(soundcloudClient) {
  if (!backgroundJobsAllowed()) {
    logger.info('[GrowthScheduler] Not started: NODE_ENV is not production');
    return null;
  }
  if (process.env.GROWTH_AUTOCHECK === 'false') {
    logger.info('[GrowthScheduler] Disabled via GROWTH_AUTOCHECK=false');
    return null;
  }

  const run = () =>
    runScheduledFollowbackChecks(soundcloudClient).catch((err) =>
      logger.error('[GrowthScheduler] Run failed:', safeError(err))
    );

  setTimeout(run, INITIAL_DELAY_MS);
  const interval = setInterval(run, CHECK_INTERVAL_MS);
  interval.unref?.();
  logger.info('[GrowthScheduler] Daily follow-back checks scheduled');
  return interval;
}
