import express from 'express';
import { accessFor } from '../lib/download-access.js';
import { createPkcePair } from '../lib/pkce.js';
import { signSession, unsignSession, parseSessionData, createSessionCookieOptions } from '../lib/session.js';
import { encrypt } from '../lib/crypto.js';
import { soundcloudClient, signOut, forgetRecentRotation } from '../lib/soundcloud-client.js';
import { disconnectUser } from '../lib/account-lifecycle.js';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { safeError } from '../lib/safe-error.js';
import { logOperation } from '../lib/analytics.js';
import { authenticateUser } from '../middleware/auth.js';
import { heavyOperationRateLimiter } from '../middleware/rateLimiter.js';
import { invalidateCachedAuth } from '../lib/auth-cache.js';
import { requestCache } from '../lib/request-cache.js';
import { dropSnapshots } from '../lib/snapshot-cache.js';
import { dropInvalidationMarks } from '../lib/social-cache.js';

const router = express.Router();

/** Safe path for post-OAuth redirect (same-site frontend only). */
function safePostLoginPath(raw) {
  if (typeof raw !== 'string') return '';
  const p = raw.trim();
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('..')) return '';
  if (p.length > 200) return '';
  return p;
}

/**
 * GET /api/auth/login
 * Generate PKCE pair and redirect to SoundCloud OAuth
 */
router.get('/login', async (req, res) => {
  try {
    const { codeVerifier, codeChallenge } = createPkcePair();
    
    // Store code verifier in httpOnly cookie
    res.cookie('pkce_verifier', codeVerifier, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000, // 10 minutes
      path: '/'
    });

    // Remember app origin so callback can redirect to the right port (dev 5173 vs preview 4173)
    // Determine app origin from Origin header, else Referer, else env default
    let appOrigin = req.get('origin') || '';
    if (!appOrigin) {
      const ref = req.get('referer');
      if (ref) {
        try { appOrigin = new URL(ref).origin; } catch {}
      }
    }
    if (!appOrigin) appOrigin = process.env.APP_URL || 'http://localhost:4173';
    res.cookie('app_url', appOrigin, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000,
      path: '/'
    });

    const redirectPath = safePostLoginPath(req.query.redirect_path);
    if (redirectPath) {
      res.cookie('post_login_path', redirectPath, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 10 * 60 * 1000,
        path: '/'
      });
    }

    // Build SoundCloud OAuth URL (modern authorize endpoint)
    const authUrl = new URL('https://secure.soundcloud.com/authorize');
    authUrl.searchParams.set('client_id', process.env.SOUNDCLOUD_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', process.env.SOUNDCLOUD_REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    // scope can be blank per spec; omit non-expiring (deprecated)
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    res.redirect(authUrl.toString());
  } catch (error) {
    logger.error('Login error:', safeError(error));
    res.status(500).json({ error: 'Failed to initiate login' });
  }
});

/**
 * GET /api/auth/callback
 * Handle SoundCloud OAuth callback
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    const codeVerifier = req.cookies.pkce_verifier;
    const appUrlCookie = req.cookies.app_url;
    const appUrl = appUrlCookie || process.env.APP_URL;
    const postLoginPath = req.cookies.post_login_path;

    if (error) {
      logger.error('OAuth error:', safeError(error));
      res.clearCookie('pkce_verifier');
      res.clearCookie('app_url');
      res.clearCookie('post_login_path');
      return res.redirect(`${appUrl}/login?error=${encodeURIComponent(error)}`);
    }

    if (!code || !codeVerifier) {
      res.clearCookie('pkce_verifier');
      res.clearCookie('app_url');
      res.clearCookie('post_login_path');
      return res.redirect(`${appUrl}/login?error=missing_code_or_verifier`);
    }

    // Exchange code for tokens
    const tokens = await soundcloudClient.exchangeCodeForTokens(code, codeVerifier);
    
    // Get user information
    const userInfo = await soundcloudClient.getMe(tokens.access_token, tokens.refresh_token);

    // Calculate token expiration (SoundCloud may omit expires_in in edge cases)
    const expiresMs = Number(tokens.expires_in);
    const expiresSeconds = Number.isFinite(expiresMs) && expiresMs > 0 ? expiresMs : 3600;
    const expiresAt = new Date(Date.now() + expiresSeconds * 1000);

    // Encrypt tokens
    const encryptionKey = process.env.ENCRYPTION_KEY;
    const encryptedAccessToken = encrypt(tokens.access_token, encryptionKey);
    const encryptedRefreshToken = encrypt(tokens.refresh_token, encryptionKey);

    // Upsert user in database
    const user = await prisma.user.upsert({
      where: { soundcloudId: userInfo.id },
      update: {
        username: userInfo.username,
        displayName: userInfo.display_name,
        avatarUrl: userInfo.avatar_url,
        // A successful login is what the inactive-account purge measures, and
        // it un-disconnects an account the user (or SoundCloud) had cut loose:
        // reconnecting must clear the stamp, or the retention job would delete
        // a user who just came back.
        lastLoginAt: new Date(),
        disconnectedAt: null,
        updatedAt: new Date()
      },
      create: {
        soundcloudId: userInfo.id,
        username: userInfo.username,
        displayName: userInfo.display_name,
        avatarUrl: userInfo.avatar_url,
        lastLoginAt: new Date(),
        disconnectedAt: null
      }
    });

    // Store encrypted tokens
    await prisma.token.upsert({
      where: { userId: user.id },
      update: {
        encrypted: encryptedAccessToken,
        refresh: encryptedRefreshToken,
        expiresAt,
        updatedAt: new Date()
      },
      create: {
        userId: user.id,
        encrypted: encryptedAccessToken,
        refresh: encryptedRefreshToken,
        expiresAt
      }
    });

    // Create session data
    const sessionData = {
      userId: user.id,
      soundcloudId: user.soundcloudId,
      username: user.username,
      avatarUrl: user.avatarUrl,
      displayName: user.displayName,
      iat: Date.now(),
    };

    // Sign and set session cookie
    const sessionValue = signSession(JSON.stringify(sessionData), process.env.SESSION_SECRET);
    res.cookie('session', sessionValue, createSessionCookieOptions());

    // Log OAuth login success
    logOperation({
      userId: user.id,
      soundcloudId: user.soundcloudId,
      action: 'auth-login',
      status: 'success',
      // No metadata. The privacy page describes the operation log as ids plus
      // device/browser/OS, and `username` here was a second copy of a column
      // the `users` row already holds — nothing read it, and it outlived the
      // description it was supposed to match.
    });

    // Clear PKCE verifier and app origin cookies
    res.clearCookie('pkce_verifier');
    res.clearCookie('app_url');
    res.clearCookie('post_login_path');

    const pathAfterLogin =
      (typeof postLoginPath === 'string' && postLoginPath.startsWith('/') && !postLoginPath.startsWith('//')
        ? postLoginPath
        : '/dashboard');

    res.redirect(`${appUrl}${pathAfterLogin}`);
  } catch (error) {
    logger.error('Callback error:', safeError(error));
    const appUrl = req.cookies.app_url || process.env.APP_URL;
    res.clearCookie('pkce_verifier');
    res.clearCookie('app_url');
    res.clearCookie('post_login_path');
    res.redirect(`${appUrl}/login?error=callback_failed`);
  }
});

/**
 * POST /api/auth/logout
 * Clear session and redirect to home
 */
router.post('/logout', async (req, res) => {
  try {
    const sessionCookie = req.cookies.session;
    if (sessionCookie) {
      const sessionValue = unsignSession(sessionCookie, process.env.SESSION_SECRET);
      if (sessionValue) {
        const sessionData = parseSessionData(sessionValue);
        if (sessionData?.userId) {
          logOperation({
            userId: sessionData.userId,
            soundcloudId: sessionData.soundcloudId,
            action: 'auth-logout',
            status: 'success',
          });
        }
      }
    }

    // Clear session cookie
    res.clearCookie('session');
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Logout error:', safeError(error));
    res.status(500).json({ error: 'Failed to logout' });
  }
});

/**
 * POST /api/auth/disconnect
 *
 * Hand the SoundCloud grant back and destroy the stored tokens, without
 * deleting the account. The user row survives, stamped with disconnectedAt,
 * so logging back in restores the connection — but if they do not, the
 * retention job removes the row (and everything cascading from it) six days
 * later. See server/lib/account-lifecycle.js.
 *
 * It is a POST under /api, so rejectUntrustedOrigin already refuses it from a
 * foreign origin (tests/routes/account-deletion.test.js). It takes no body, so the
 * empty-body fail-closed layer that guards the other mutations does not apply
 * here — the Origin check is the guard.
 */
router.post('/disconnect', authenticateUser, async (req, res) => {
  try {
    await disconnectUser(req.user.id, { accessToken: req.accessToken, reason: 'user' });
    // Same call shape as logout: the cookie is host-only with a default path,
    // so it clears with no options.
    res.clearCookie('session');
    res.json({ success: true });
  } catch (error) {
    logger.error('Account disconnect error:', safeError(error));
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

/**
 * DELETE /api/auth/account
 * Permanently delete the authenticated user's account and everything keyed to
 * it. Every per-user table relates to users with onDelete: Cascade (tokens,
 * operation_logs, growth_actions, survey_responses, beta_signups, plus the
 * cross-branch chat/indexed/snapshot tables), so the single user delete
 * removes all of it — enforced by tests/account-deletion-cascade.test.js.
 * Body: { confirm: "DELETE" } — explicit confirmation checked server-side.
 */
router.delete('/account', authenticateUser, async (req, res) => {
  try {
    if (req.body?.confirm !== 'DELETE') {
      return res.status(400).json({ error: 'Confirmation required: send { "confirm": "DELETE" }' });
    }
    const { id } = req.user;
    // Hand the grant back before the row goes, so deleting an account also
    // drops the authorization on SoundCloud's side rather than leaving a live
    // grant pointing at data we no longer hold. Never throws.
    await signOut(req.accessToken);
    await prisma.user.delete({ where: { id } });
    // The user row and its tokens are gone; drop the memo and any cached
    // library payloads so nothing survives the deletion in process memory.
    // The auth memo holds DECRYPTED tokens for 30s and the rotation memo holds
    // the last refresh's pair for a minute, so without these two a request
    // arriving inside the window would keep working — and writing — against an
    // account whose row no longer exists. tests/routes/account-deletion.test.js
    // asserts both through this route, not by calling them directly.
    invalidateCachedAuth(id);
    forgetRecentRotation(id);
    requestCache.invalidateUser(id);
    dropInvalidationMarks(id);
    await dropSnapshots(id);
    // Deliberately not logOperation: the operation_logs rows (and their FK
    // target) were just deleted with the account.
    // No identifier: the point of the route is that nothing about this person
    // is kept, and a log line naming them would outlive the rows it names.
    logger.info('[account] deleted account');
    res.clearCookie('session');
    res.json({ success: true });
  } catch (error) {
    logger.error('Account deletion error:', safeError(error));
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

/**
 * GET /api/auth/export
 *
 * Everything this service stores about the authenticated user, as one JSON
 * download. Deliberately a full dump rather than a summary — the point is that
 * a person can see the actual rows, not a description of them.
 *
 * Three invariants:
 *   1. Every query is scoped to req.user.id. There is no id parameter to
 *      tamper with, and nothing here reads a foreign row.
 *   2. The token record contributes its expiry only. `encrypted` and `refresh`
 *      are AES-GCM ciphertext of live credentials and never leave the server,
 *      exported or not.
 *   3. Every per-user table is here. The privacy policy and the account page
 *      both promise "everything keyed to your account", so a table that stores
 *      per-user rows and is missing from this list makes that promise false.
 *      The list is not maintained by hand: tests/routes/export.test.js derives
 *      it from prisma/schema.prisma the way the deletion-cascade test does, so
 *      a per-user table added later cannot quietly fall out of the export.
 * All three are asserted by tests/routes/export.test.js.
 *
 * BigInt columns (soundcloudId on the vote/survey tables, growth target ids)
 * serialize through the BigInt.prototype.toJSON patch in server/index.js.
 */
router.get('/export', authenticateUser, heavyOperationRateLimiter, async (req, res) => {
  try {
    const userId = req.user.id;
    const scope = { where: { userId } };

    // A delegate can be absent from the generated client when the model
    // belongs to a feature branch that has not landed here yet; asking for it
    // would throw and cost the caller their whole export. An absent table has
    // no rows to export either way, so it contributes an empty array.
    const optional = (delegate, args = scope) =>
      (delegate ? delegate.findMany(args) : Promise.resolve([]));

    const [
      token,
      operationLogs,
      growthActions,
      feedback,
      rebrandVotes,
      surveyResponses,
      betaSignups,
      libraryCacheState,
      libraryCachePages,
      chatConversations,
      indexedLikes,
      indexedPlaylistTracks,
      librarySnapshots,
    ] = await Promise.all([
      prisma.token.findFirst({ where: { userId }, select: { expiresAt: true } }),
      prisma.operationLog.findMany(scope),
      prisma.growthAction.findMany(scope),
      // No `select`, deliberately: `adminNote` is in the export even though
      // GET /api/feedback/mine hides it. The two disagree on purpose. /mine is
      // a convenience list in the UI; this file is the data-subject export,
      // and a note an operator wrote about a person is still that person's
      // data, so leaving it out would make "everything keyed to your account"
      // untrue. The practical consequence, worth knowing before writing one:
      // an admin note is visible to the person it is about, on request.
      optional(prisma.feedback),
      prisma.rebrandVote.findMany(scope),
      prisma.surveyResponse.findMany(scope),
      prisma.betaSignup.findMany(scope),
      prisma.libraryCacheState.findMany(scope),
      prisma.libraryCachePage.findMany({
        where: { userId },
        select: { resource: true, pageIndex: true, itemCount: true, items: true },
      }),
      // The library-chat and library-index tables. They are declared in this
      // schema (so `prisma db push` does not drop them) and the privacy policy
      // lists them as stored and keyed to the account, so the export has to
      // carry them or the promise it makes is false. `chat_messages` has no
      // userId of its own — it hangs off the conversation, and is included
      // that way, which is also how the deletion cascade reaches it.
      optional(prisma.chat_conversations, {
        where: { userId },
        include: { chat_messages: true },
      }),
      optional(prisma.indexed_likes),
      optional(prisma.indexed_playlist_tracks),
      optional(prisma.library_snapshots),
    ]);

    const { id, soundcloudId, username, displayName, avatarUrl, createdAt, lastLoginAt } = req.user;

    const payload = {
      // 2: added chatConversations (with their messages), indexedLikes,
      // indexedPlaylistTracks and librarySnapshots.
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      user: { id, soundcloudId, username, displayName, avatarUrl, createdAt, lastLoginAt },
      // Expiry only — see the invariant above.
      token: token ? { expiresAt: token.expiresAt } : null,
      operationLogs,
      growthActions,
      feedback,
      rebrandVotes,
      surveyResponses,
      betaSignups,
      libraryCacheState,
      libraryCachePages,
      chatConversations,
      indexedLikes,
      indexedPlaylistTracks,
      librarySnapshots,
    };

    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="track-toolkit-export-${day}.json"`);
    res.json(payload);
  } catch (error) {
    logger.error('Account export error:', safeError(error));
    res.status(500).json({ error: 'Failed to build export' });
  }
});

/**
 * GET /api/auth/me
 * Get current user session — validates session cookie AND token expiry in DB
 */
router.get('/me', async (req, res) => {
  try {
    const sessionCookie = req.cookies.session;
    
    if (!sessionCookie) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const sessionValue = unsignSession(sessionCookie, process.env.SESSION_SECRET);
    if (!sessionValue) {
      res.clearCookie('session');
      return res.status(401).json({ error: 'Invalid session' });
    }

    const sessionData = parseSessionData(sessionValue);
    if (!sessionData) {
      res.clearCookie('session');
      return res.status(401).json({ error: 'Invalid session data' });
    }

    // Verify user and tokens exist in the database and aren't expired
    const user = await prisma.user.findUnique({
      where: { id: sessionData.userId },
      include: { tokens: true },
    });

    if (!user || !user.tokens.length) {
      res.clearCookie('session');
      return res.status(401).json({ error: 'Session expired' });
    }

    // Admins plus DOWNLOAD_ALLOWLIST (comma-separated SoundCloud ids); the
    // same helper backs requireCanDownload, so page and server agree.
    const { isAdmin, canDownload } = accessFor(sessionData.soundcloudId);

    res.json({ ...sessionData, isAdmin, canDownload });
  } catch (error) {
    logger.error('Me error:', safeError(error));
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

export default router;
