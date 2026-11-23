/**
 * Disconnecting an account — the step between logging out and deleting.
 *
 * Logout forgets the session cookie and nothing else: the encrypted token pair
 * stays in the database and the next login picks it straight back up. Deletion
 * is the other extreme and is irreversible. Disconnect is the middle: the
 * SoundCloud grant is handed back, the stored tokens are destroyed, and the
 * user row is stamped so the retention job removes it six days later unless the
 * person comes back (a successful login clears the stamp).
 *
 * Two callers:
 *   - POST /api/auth/disconnect, with the user's access token, so SoundCloud
 *     is told as well;
 *   - the refresh choke point in soundcloud-client.js, when SoundCloud reports
 *     the authorization already revoked — no access token, nothing to sign out
 *     of, but exactly the same local teardown.
 */
import prisma from './prisma.js';
import logger from './logger.js';
import { signOut, forgetRecentRotation } from './soundcloud-client.js';
import { invalidateCachedAuth } from './auth-cache.js';
import { requestCache } from './request-cache.js';
import { dropSnapshots } from './snapshot-cache.js';
import { dropInvalidationMarks } from './social-cache.js';
import { cancelEngagementJob } from './growth-engine.js';

/**
 * Hand back the SoundCloud grant and destroy everything this process or the
 * database holds on that user's behalf, short of the account itself.
 *
 * @param {string} userId                internal User.id
 * @param {object} [options]
 * @param {string} [options.accessToken] present only when the token is still
 *   believed live; omitted on the revocation path
 * @param {string} [options.reason]      'user' | 'revoked' — logged, not stored
 */
export async function disconnectUser(userId, { accessToken, reason } = {}) {
  if (!userId) throw new Error('disconnectUser requires a userId');

  // A running growth engagement job holds the decrypted pair in its closure
  // and checks only its own cancel flag before each follow or like, so
  // destroying the stored tokens does not stop it. Flag it first, before any
  // await, so no write starts once the teardown has. A write already in
  // flight cannot be recalled. Covers the revocation path too.
  cancelEngagementJob(userId);

  // Best-effort and non-throwing by construction (see signOut). Done first, so
  // the token is still readable from the caller when we use it.
  if (accessToken) await signOut(accessToken);

  // deleteMany, not delete: the token row may already be gone (a second
  // disconnect, or a revocation racing a manual one) and that is not an error.
  try {
    await prisma.token.deleteMany({ where: { userId } });
  } finally {
    // The auth memo holds DECRYPTED tokens for 30s — the landmine documented
    // in STATE.md. This runs immediately after the delete, in a finally, so no
    // later failure in this function can leave the memo serving credentials
    // whose database row is already gone. Invalidating when the delete itself
    // failed is harmless: a miss only costs one lookup.
    invalidateCachedAuth(userId);
    // The rotation memo in soundcloud-client.js holds the last refresh's
    // plaintext pair for a minute, so that a route's second call is not told
    // its spent refresh token means revocation. Those tokens are gone too.
    forgetRecentRotation(userId);
  }

  await prisma.user.update({
    where: { id: userId },
    data: { disconnectedAt: new Date() },
  });

  // Their library payloads are derived from the grant we just gave back, so
  // nothing about them should outlive it in memory or in the durable tier.
  requestCache.invalidateUser(userId);
  dropInvalidationMarks(userId);
  await dropSnapshots(userId);

  // No identifiers: the reason is the only thing worth correlating, and
  // per-account logging is what the account-deletion path deliberately avoids.
  logger.info('[account] disconnected', { reason });
}
