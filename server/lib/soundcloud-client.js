import dotenv from 'dotenv';
dotenv.config();
import { encrypt, decrypt } from './crypto.js';
import logger from './logger.js';
import prisma from './prisma.js';
import { getTokenContext, countScCall } from './token-context.js';
import { invalidateCachedAuth } from './auth-cache.js';

/**
 * Safely parse a fetch Response body as JSON.
 * Reads the body as text first so empty bodies (common for DELETEs, and for
 * SoundCloud hiccups that return empty 2xx responses) don't throw the opaque
 * "Unexpected end of JSON input" error. On a non-empty/unparseable body, logs the
 * real status plus a short snippet and throws a clear, sanitized error.
 */
async function parseScJson(response, { context = 'SoundCloud API', allowEmpty = true } = {}) {
  const text = await response.text();
  if (!text || text.trim() === '') {
    if (allowEmpty) return null;            // empty 2xx — fatal only where a body is required
    logger.warn(`[${context}] empty response body (status ${response.status})`);
    throw new Error(`${context}: empty response (status ${response.status})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    logger.warn(`[${context}] non-JSON response (status ${response.status}): ${snippet}`);
    throw new Error(`${context}: invalid JSON response (status ${response.status})`);
  }
}

const SC_FETCH_TIMEOUT_MS = Number(process.env.SC_FETCH_TIMEOUT_MS) || 30_000;

/** Default ceilings for a full paginate() crawl. At the 200-item page size the
 * client uses everywhere, 200 pages is 40,000 items — far beyond any real
 * library, so these bound pathological cases without truncating normal ones. */
const SC_MAX_CRAWL_PAGES = Number(process.env.SC_MAX_CRAWL_PAGES) || 200;
const SC_MAX_CRAWL_MS = Number(process.env.SC_MAX_CRAWL_MS) || 120_000;

/** fetch that cannot hang: aborts after timeoutMs. SoundCloud has no SLA on
 * slow sockets; without this a single stuck request holds the response open
 * indefinitely. */
export async function fetchWithTimeout(url, options = {}, timeoutMs = SC_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  countScCall();
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Sign-out is best-effort courtesy on a path the user is already leaving.
 *  It gets its own short deadline so a slow SoundCloud cannot hold a
 *  disconnect or an account deletion open for the full 30s fetch budget. */
const SC_SIGN_OUT_TIMEOUT_MS = 5_000;

/**
 * Tell SoundCloud to invalidate this access token (`POST /sign-out`), so
 * disconnecting here also drops the grant on their side rather than only
 * forgetting it on ours.
 *
 * Never throws. Every caller is already committed to tearing the local session
 * down; a failure upstream must not turn a successful disconnect into a 500.
 * Returns whether SoundCloud acknowledged it, for logging only.
 */
export async function signOut(accessToken) {
  if (!accessToken) return false;
  try {
    const response = await fetchWithTimeout('https://api.soundcloud.com/sign-out', {
      method: 'POST',
      headers: {
        'Authorization': `OAuth ${accessToken}`,
        'Accept': 'application/json',
      },
    }, SC_SIGN_OUT_TIMEOUT_MS);

    if (!response.ok) {
      // 401 here is a success in disguise: the token was already dead.
      logger.warn(`[account] SoundCloud sign-out returned ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    // Includes the AbortError from the 5s deadline.
    logger.warn(`[account] SoundCloud sign-out failed: ${error?.name || 'Error'}`);
    return false;
  }
}

/**
 * Does this failed token-endpoint response mean the authorization is gone for
 * good, as opposed to SoundCloud having a bad minute?
 *
 * Exactly two things count:
 *   - a 400 or 401 whose JSON body says `{"error": "invalid_grant"}`;
 *   - a 401 with an *empty* body (SoundCloud returns one for a revoked grant).
 *
 * A 401 with a non-empty body that is not JSON does NOT count. That shape is
 * far more likely to be an HTML error page from a proxy or WAF in front of the
 * token endpoint than a revocation, and acting on it would delete a live
 * user's tokens because of someone else's infrastructure.
 *
 * Network errors, timeouts, 429 and every 5xx are likewise excluded:
 * disconnecting a user because SoundCloud was briefly down would log them out
 * and destroy their tokens over a transient blip.
 */
export function isInvalidGrantResponse(status, bodyText) {
  if (status !== 400 && status !== 401) return false;

  const text = typeof bodyText === 'string' ? bodyText.trim() : '';
  // Empty body: unambiguous on a 401, meaningless on a 400.
  if (!text) return status === 401;

  try {
    return JSON.parse(text)?.error === 'invalid_grant';
  } catch {
    // Non-empty and not JSON — an error page, not an OAuth error.
    return false;
  }
}

/**
 * In-flight token refreshes, keyed by userId. SoundCloud rotates the refresh
 * token on every exchange, so two concurrent 401s for the same user would
 * present the same refresh token twice: the second exchange fails, and the
 * losing prisma.token.update can persist the older pair and log the user out.
 * Collapsing them onto one promise makes the refresh idempotent per user.
 *
 * Per-process, like the resolve cache and the growth job registry — it matches
 * the single-instance deploy. A second backend instance would each hold their
 * own map; the DB write is still last-writer-wins across instances.
 */
const inFlightRefreshes = new Map();

/**
 * The result of the most recent successful refresh for a user, kept for a
 * short while after the exchange settles and tagged with the refresh token(s)
 * that were spent to produce it.
 *
 * The in-flight map above only collapses refreshes that OVERLAP. The common
 * case is sequential: `authenticateUser` captures `req.accessToken` /
 * `req.refreshToken` once and every `scRequest` a route makes is handed that
 * same pair, so at an access-token expiry boundary the first call refreshes
 * and the second re-presents the refresh token the first one already spent.
 * SoundCloud answers a spent refresh token with `invalid_grant` — the same
 * thing it says about a revoked grant. This memo means the second call never
 * asks: it is handed the pair the first call obtained.
 *
 * Per-process, bounded, and short-lived, matching the auth memo it sits
 * beside — and, like that one, dropped the moment the connection is torn down
 * (`forgetRecentRotation`, called from `disconnectUser`).
 */
const recentRotations = new Map();
const ROTATION_MEMO_TTL_MS = Number(process.env.SC_ROTATION_MEMO_TTL_MS) || 60_000;
const ROTATION_MEMO_MAX_ENTRIES = 1000;

/** How much life an access token must have left before it is worth reusing. */
const ACCESS_TOKEN_SKEW_MS = 60_000;

function rememberRotation(userId, consumedTokens, tokens) {
  if (!userId || !tokens?.access_token) return;
  const consumed = new Set((consumedTokens || []).filter(Boolean));
  if (consumed.size === 0) return;
  recentRotations.delete(userId);
  recentRotations.set(userId, { consumed, tokens, expiresAt: Date.now() + ROTATION_MEMO_TTL_MS });
  while (recentRotations.size > ROTATION_MEMO_MAX_ENTRIES) {
    const oldest = recentRotations.keys().next();
    if (oldest.done) break;
    recentRotations.delete(oldest.value);
  }
}

function readRecentRotation(userId, presentedRefreshToken) {
  const entry = recentRotations.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    recentRotations.delete(userId);
    return null;
  }
  return entry.consumed.has(presentedRefreshToken) ? entry.tokens : null;
}

/**
 * Forget a user's last rotation. Called wherever the stored tokens stop being
 * what this process thinks they are — the same contract as
 * `invalidateCachedAuth`, and for the same reason.
 */
export function forgetRecentRotation(userId) {
  if (userId != null) recentRotations.delete(userId);
}

/** Drop every remembered rotation. Tests only. */
export function clearRecentRotations() {
  recentRotations.clear();
}

class SoundCloudClient {
  constructor() {
    this.baseUrl = 'https://api.soundcloud.com';
    this.clientId = process.env.SOUNDCLOUD_CLIENT_ID;
    this.clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET;
    this.redirectUri = process.env.SOUNDCLOUD_REDIRECT_URI;
    this.encryptionKey = process.env.ENCRYPTION_KEY;

    if (!this.clientId || !this.clientSecret || !this.redirectUri || !this.encryptionKey) {
      throw new Error('Missing required SoundCloud environment variables');
    }
  }

  /**
   * Exchange authorization code for access tokens
   */
  async exchangeCodeForTokens(code, codeVerifier) {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      code,
      code_verifier: codeVerifier
    });

    const response = await fetchWithTimeout('https://secure.soundcloud.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      // Sanitize error - don't include full response body which might contain tokens
      const sanitizedError = errorText.length > 200 
        ? errorText.substring(0, 200) + '...' 
        : errorText;
      throw new Error(`Token exchange failed: ${response.status}`);
    }

    return parseScJson(response, { context: 'Token exchange', allowEmpty: false });
  }

  /**
   * Refresh access tokens using refresh token
   */
  async refreshTokens(refreshToken) {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken
    });

    const response = await fetchWithTimeout('https://secure.soundcloud.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      // Sanitize error - don't include full response body
      const error = new Error(`Token refresh failed: ${response.status}`);
      // Flag (rather than re-encode in the message) so the caller can tell a
      // revoked authorization from a transient failure without string-matching
      // a message that is deliberately kept free of response detail.
      error.invalidGrant = isInvalidGrantResponse(response.status, errorText);
      throw error;
    }

    return parseScJson(response, { context: 'Token refresh', allowEmpty: false });
  }

  async refreshTokensAndPersist(refreshToken) {
    const context = getTokenContext();
    const userId = context?.userId;

    // No user context => nothing to collide on (and nothing to persist).
    if (!userId) return this._refreshAndPersistNow(refreshToken, null);

    // Sequential case: an earlier call in this same request (or one a moment
    // ago) already spent this exact refresh token. Presenting it again would
    // be answered `invalid_grant`, which upstream is indistinguishable from a
    // revoked grant. Hand back what that exchange produced instead.
    const alreadyRotated = readRecentRotation(userId, refreshToken);
    if (alreadyRotated) return alreadyRotated;

    const existing = inFlightRefreshes.get(userId);
    if (existing) return existing;

    const pending = this._refreshAndPersistNow(refreshToken, userId)
      .finally(() => {
        // Always clear, on success AND failure, so a failed refresh does not
        // poison every later attempt for this user.
        inFlightRefreshes.delete(userId);
      });
    inFlightRefreshes.set(userId, pending);
    return pending;
  }

  /** The original, un-deduplicated refresh+persist. Do not call directly. */
  async _refreshAndPersistNow(refreshToken, userId) {
    if (!userId) {
      // Refuse, rather than exchange and throw the result away.
      //
      // A context-free refresh can only ever strand the caller. The exchange
      // rotates the refresh token upstream, there is no userId to persist the
      // replacement against, and the row is left holding a token SoundCloud
      // has already consumed. The user's next request presents it, is refused
      // with invalid_grant, and — because the stored token really IS the one
      // presented — `_resolveInvalidGrant` correctly concludes "revoked" and
      // deletes their tokens. So the quiet version of this turns into an
      // account teardown one request later, which is how it reached a
      // Critical: `growth-scheduler.js` ran from a boot-time timer with no
      // AsyncLocalStorage store and did exactly this, daily.
      //
      // The old behaviour exchanged first and warned afterwards
      // ("Token refresh completed without user context; refreshed tokens were
      // not persisted"), then carried on. That line is what to grep for in
      // logs predating this change — it means somebody was stranded.
      //
      // Every SoundCloud caller either runs inside `authenticateUser` (which
      // opens the context) or must open one itself with `runWithTokenContext`.
      logger.warn('Token refresh without user context: refusing the exchange, because the refreshed tokens could not be persisted');
      throw new Error('Token refresh failed: no user context');
    }

    let newTokens;
    try {
      newTokens = await this.refreshTokens(refreshToken);
    } catch (error) {
      // `invalid_grant` is what SoundCloud says about a revoked grant AND what
      // it says about a refresh token that has simply already been spent. Only
      // one of those should destroy the connection, so ask which it is.
      if (error?.invalidGrant && userId) {
        const recovered = await this._resolveInvalidGrant(refreshToken, userId);
        // A pair came back: the token presented was stale, not revoked. Hand it
        // to the caller so its retry succeeds.
        if (recovered) return recovered;
      }
      // Rethrow either way: scRequest still converts this into the generic
      // "Token refresh failed" the caller has always seen.
      throw error;
    }

    await this._persistRefreshedTokens(userId, newTokens, [refreshToken]);
    return newTokens;
  }

  /**
   * Store a freshly exchanged pair and tell the rest of the process about it.
   *
   * `consumedTokens` are the refresh tokens this exchange spent. Each one is
   * now dead upstream, so a later caller that presents one is served from the
   * rotation memo instead of being reported as revoked.
   */
  async _persistRefreshedTokens(userId, newTokens, consumedTokens) {
    if (!userId || !newTokens?.access_token || !newTokens?.refresh_token) return false;

    const expiresAt = new Date(Date.now() + ((newTokens.expires_in || 3600) * 1000));
    await prisma.token.update({
      where: { userId },
      data: {
        encrypted: encrypt(newTokens.access_token, this.encryptionKey),
        refresh: encrypt(newTokens.refresh_token, this.encryptionKey),
        expiresAt,
        updatedAt: new Date(),
      },
    });
    // The auth memo is now holding the tokens we just replaced. SoundCloud
    // rotates the refresh token on every exchange, so serving the memo after
    // this point would hand out a refresh token that no longer works.
    invalidateCachedAuth(userId);
    rememberRotation(userId, consumedTokens, newTokens);
    return true;
  }

  /**
   * Read and decrypt the stored token pair. Returns null when there is no row,
   * or when it cannot be read or decrypted. Never throws.
   *
   * "Cannot read" deliberately collapses into the same answer as "no row",
   * because the only thing this is used for is deciding whether to destroy a
   * user's connection. That decision must rest on positive evidence; a
   * database hiccup or a rotated key must never supply it.
   */
  async _readStoredTokens(userId) {
    try {
      const row = await prisma.token.findUnique({ where: { userId } });
      if (!row?.refresh) return null;
      const expiresAt = row.expiresAt ? new Date(row.expiresAt) : null;
      return {
        refresh: decrypt(row.refresh, this.encryptionKey),
        access: row.encrypted ? decrypt(row.encrypted, this.encryptionKey) : null,
        expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
      };
    } catch {
      // No identifiers, no ciphertext — just the fact.
      logger.warn('[auth] could not read the stored token pair while classifying invalid_grant');
      return null;
    }
  }

  /**
   * SoundCloud refused a refresh token with `invalid_grant`. That means one of
   * two very different things, and the OAuth error code does not distinguish
   * them:
   *
   *   1. the user revoked this app in SoundCloud's settings — the grant is
   *      gone and the local connection should be torn down; or
   *   2. the refresh token presented had simply already been spent. Every
   *      exchange rotates it, and a route that makes two SoundCloud calls
   *      hands the same captured pair to both, so the second call presents a
   *      token the first consumed. Nothing is wrong: the current pair is in
   *      the database, freshly written.
   *
   * Reading (2) as (1) deletes a live user's tokens and starts the
   * account-deletion clock on an ordinary hourly expiry boundary, so the
   * database settles it. If the stored refresh token is still the one that was
   * presented, nothing has rotated and the grant really is gone. If it has
   * moved on, it is case (2) — and this returns a usable pair so the caller's
   * retry succeeds rather than failing.
   *
   * **This is the load-bearing half of the fix, not the memo.** The memo above
   * only saves a round trip, and only for a spent token re-presented in this
   * process inside its TTL; this is what prevents the teardown in every other
   * case. Do not drop it as redundant.
   *
   * **It assumes one worker, and that assumption is a correctness constraint.**
   * Inside one process the in-flight map holds its entry until the persist has
   * completed, so a second caller either joins that promise or reads the
   * rotated row. Across processes there is no such ordering: two instances can
   * present the same token, the loser reads the row before the winner's
   * `token.update` lands, sees it still equal to what it presented, and tears
   * a live user down. `infra/main.bicep` pins `numberOfWorkers: 1`; raising it
   * needs a database-side guard here first (a compare-and-swap on `refresh`,
   * or a `rotatedAt` the loser can compare against), not just a bigger memo.
   *
   * @returns {Promise<object|null>} tokens to continue with, or null to let the
   *   original error propagate (including after a genuine disconnect)
   */
  async _resolveInvalidGrant(presentedRefreshToken, userId) {
    const stored = await this._readStoredTokens(userId);

    // Nothing readable to compare against: either the row is already gone (a
    // disconnect or an account deletion got there first, and re-running the
    // teardown would only restart the deletion clock) or the database or key
    // is unavailable. Neither is evidence of a revocation.
    if (!stored) return null;

    if (stored.refresh === presentedRefreshToken) {
      // The token presented IS the current one, so nothing rotated it: the
      // grant is gone. The user revoked us from their account settings, or
      // SoundCloud invalidated it. The stored pair is dead weight and every
      // later request would 401 against it, so tear the connection down now.
      // No signOut: there is nothing left to sign out of.
      await this._disconnectRevoked(userId);
      return null;
    }

    // The stored pair has moved on since this caller captured its copy. That
    // is the ordinary expiry-boundary shape, not a revocation.
    logger.warn('[auth] invalid_grant for a superseded refresh token — treated as a spent token, not a revocation');

    if (stored.access && stored.expiresAt
        && stored.expiresAt.getTime() - Date.now() > ACCESS_TOKEN_SKEW_MS) {
      // The stored access token still has life in it; no exchange needed.
      //
      // Deliberately NOT remembered in the rotation memo. The read above and
      // this line are separated by an await, so a disconnect can run to
      // completion in between — delete the row, then `forgetRecentRotation` —
      // and a memo write here would land *after* the forget, serving a live
      // pair for a minute against a row that no longer exists. That is the
      // auth-memo landmine one layer down. What it would have bought is one
      // saved exchange on a *third* call presenting the same stale token,
      // which is not worth a write that happens after the only ordering
      // guarantee has passed. The success-path write in
      // `_persistRefreshedTokens` is safe by construction: its `token.update`
      // throws on a missing row before the memo is touched.
      return {
        access_token: stored.access,
        refresh_token: stored.refresh,
        expires_in: Math.floor((stored.expiresAt.getTime() - Date.now()) / 1000),
      };
    }

    // The stored access token has expired too — a long-running job holding one
    // captured pair for over an hour. One exchange with the CURRENT refresh
    // token; if that also comes back invalid_grant, the grant really is gone.
    let refreshed;
    try {
      refreshed = await this.refreshTokens(stored.refresh);
    } catch (retryError) {
      if (retryError?.invalidGrant) await this._disconnectRevoked(userId);
      return null;
    }
    await this._persistRefreshedTokens(userId, refreshed, [presentedRefreshToken, stored.refresh]);
    return refreshed;
  }

  /** Tear the connection down after a confirmed revocation. Never throws. */
  async _disconnectRevoked(userId) {
    try {
      // Dynamic import: account-lifecycle imports signOut from this module, so
      // a static import here would close the cycle at module-evaluation time.
      const { disconnectUser } = await import('./account-lifecycle.js');
      await disconnectUser(userId, { reason: 'revoked' });
    } catch (disconnectError) {
      logger.error('[account] disconnect after revocation failed:', disconnectError);
    }
  }

  /**
   * Make authenticated request to SoundCloud API with automatic token refresh
   */
  async scRequest(endpoint, accessToken, refreshToken, options = {}) {
    const { max429Retries = 3, retryAttempt = 0, ...fetchOptions } = options;
    const url = `${this.baseUrl}${endpoint}`;
    
    const response = await fetchWithTimeout(url, {
      ...fetchOptions,
      headers: {
        'Authorization': `OAuth ${accessToken}`,
        'Accept': 'application/json',
        ...fetchOptions.headers
      }
    });

    // Handle 401 - token expired, try to refresh
    if (response.status === 401) {
      try {
        const newTokens = await this.refreshTokensAndPersist(refreshToken);
        const newAccessToken = newTokens.access_token;

        // Retry the request with new token
        const retryResponse = await fetchWithTimeout(url, {
          ...fetchOptions,
          headers: {
            'Authorization': `OAuth ${newAccessToken}`,
            'Accept': 'application/json',
            ...fetchOptions.headers
          }
        });

        if (!retryResponse.ok) {
          // Don't include response body in error message
          throw new Error(`API request failed after token refresh: ${retryResponse.status}`);
        }

        return parseScJson(retryResponse, { context: endpoint });
      } catch (refreshError) {
        // Don't expose refresh error details
        throw new Error(`Token refresh failed`);
      }
    }

    // Handle 429 - rate limit, implement exponential backoff
    if (response.status === 429) {
      if (retryAttempt >= max429Retries) {
        // `status` lets a caller stop a loop on the rate limit without
        // string-matching the message (see bulk-like in routes/api.js).
        throw Object.assign(new Error(`API request failed: 429`), { status: 429 });
      }
      const retryAfter = response.headers.get('Retry-After');
      const delay = retryAfter ? parseInt(retryAfter) * 1000 : 1000;
      
      await new Promise(resolve => setTimeout(resolve, delay));
      return this.scRequest(endpoint, accessToken, refreshToken, {
        ...fetchOptions,
        max429Retries,
        retryAttempt: retryAttempt + 1,
      });
    }

    if (!response.ok) {
      // Don't include response body in error message to prevent secret leakage
      throw new Error(`API request failed: ${response.status}`);
    }

    return parseScJson(response, { context: endpoint });
  }

  /**
   * Get current user information
   */
  async getMe(accessToken, refreshToken) {
    return this.scRequest('/me', accessToken, refreshToken);
  }

  /**
   * Get every one of the user's playlists (fully paginated via next_href).
   * `/me/playlists` returns oldest-created playlists first, so a single
   * page silently drops newer playlists once a user has more than `limit`
   * of them — which is why there is no single-page variant here. The one
   * that existed sent `offset`, which this endpoint's own spec marks
   * deprecated in favour of `linked_partitioning`; callers that want a
   * page slice the cached full list instead (see lib/playlist-pages.js).
   */
  async getAllPlaylists(accessToken, refreshToken, limit = 200) {
    return this.paginate('/me/playlists', accessToken, refreshToken, limit);
  }

  /**
   * Get a playlist with tracks included.
   *
   * SoundCloud's `access` parameter defaults to `playable,preview`, so by
   * default blocked tracks are left out of `tracks` while `track_count` still
   * counts them. `allAccess` asks for all three levels; anything that will
   * write the list back must use it (see readPlaylistForRewrite).
   */
  async getPlaylistWithTracks(accessToken, refreshToken, playlistId, { allAccess = false } = {}) {
    const access = allAccess ? '&access=playable,preview,blocked' : '';
    return this.scRequest(`/playlists/${playlistId}?show_tracks=true${access}`, accessToken, refreshToken);
  }

  /**
   * Get user's liked tracks with pagination
   */
  async getLikes(accessToken, refreshToken, limit = 50, offset = 0) {
    const params = new URLSearchParams({
      limit: limit.toString(),
      offset: offset.toString(),
      linked_partitioning: '1'
    });

    // Prefer newer endpoint; fallback to older favorites
    try {
      return await this.scRequest(`/me/likes/tracks?${params.toString()}`, accessToken, refreshToken);
    } catch (e) {
      return this.scRequest(`/me/favorites?${params.toString()}`, accessToken, refreshToken);
    }
  }

  /**
   * Get all items from a paginated endpoint.
   *
   * `limit` is the page size. Pass `options` to bound the crawl:
   *   maxItems      stop once this many items are collected (result is sliced)
   *   maxPages      stop after this many pages (default SC_MAX_CRAWL_PAGES)
   *   deadlineAt    epoch ms; stop and return what's collected once reached
   *                 (defaults to now + SC_MAX_CRAWL_MS)
   *   max429Retries bounded Retry-After retries per page (resets each page)
   *   max401Retries bounded token refreshes for the whole crawl
   *
   * The defaults matter. The per-fetch AbortController deadline resets on every
   * page, so an unbounded crawl of a large library had a worst case measured in
   * minutes while holding one HTTP response open. Bounding pages and total wall
   * time makes a slow SoundCloud degrade into a partial result instead.
   */
  async paginate(endpoint, accessToken, refreshToken, limit = 50, options = {}) {
    const {
      maxItems = Infinity,
      maxPages = SC_MAX_CRAWL_PAGES,
      deadlineAt = Date.now() + SC_MAX_CRAWL_MS,
      max429Retries = 3,
      max401Retries = 2,
    } = options;
    const allItems = [];
    let pagesFetched = 0;
    let retries401 = 0;
    // Prefer cursor-based pagination via next_href to avoid deprecated offset limits
    let nextUrl = `${this.baseUrl}${endpoint}?${new URLSearchParams({
      limit: limit.toString(),
      linked_partitioning: '1'
    }).toString()}`;

    let currentAccessToken = accessToken;
    let retries429 = 0;

    while (
      nextUrl
      && allItems.length < maxItems
      && pagesFetched < maxPages
      && (deadlineAt === null || Date.now() < deadlineAt)
    ) {
      const res = await fetchWithTimeout(nextUrl, {
        headers: {
          'Authorization': `OAuth ${currentAccessToken}`,
          'Accept': 'application/json'
        }
      });

      if (res.status === 401) {
        // Bounded: this `continue` retries the same URL without consuming a
        // page, so an endpoint that keeps 401-ing after a successful refresh
        // would otherwise spin forever, burning a token exchange each pass.
        if (retries401 >= max401Retries) {
          throw new Error('API request failed: 401');
        }
        retries401++;
        const refreshed = await this.refreshTokensAndPersist(refreshToken);
        currentAccessToken = refreshed.access_token;
        refreshToken = refreshed.refresh_token || refreshToken;
        continue; // retry loop with same nextUrl
      }

      if (res.status === 429) {
        if (retries429 >= max429Retries) {
          throw Object.assign(new Error(`API request failed: 429`), { status: 429 });
        }
        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : 1000;
        // Sleeping past the deadline is worse than a partial crawl
        if (deadlineAt !== null && Date.now() + delay >= deadlineAt) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
        retries429++;
        continue; // retry loop with same nextUrl
      }

      if (!res.ok) {
        // Don't include response body in error message
        throw new Error(`API request failed: ${res.status}`);
      }

      retries429 = 0;
      retries401 = 0;
      pagesFetched++;
      const data = (await parseScJson(res, { context: endpoint })) || {};
      if (Array.isArray(data.collection)) {
        allItems.push(...data.collection);
      }
      nextUrl = data.next_href || null;
    }

    const items = maxItems === Infinity ? allItems : allItems.slice(0, maxItems);

    // A crawl that stopped early because it ran out of page budget or wall
    // clock has NOT returned the user's whole library. Callers that render a
    // list must be able to say so rather than silently showing a subset, so
    // the flag rides along on the array: existing callers keep treating this
    // as a plain array (JSON.stringify ignores the extra property), and
    // callers that care can read `.truncated`.
    const hitPageCap = pagesFetched >= maxPages && Boolean(nextUrl);
    const hitDeadline = deadlineAt !== null && Date.now() >= deadlineAt && Boolean(nextUrl);
    if (hitPageCap || hitDeadline) {
      Object.defineProperty(items, 'truncated', {
        value: true, enumerable: false, configurable: true,
      });
      Object.defineProperty(items, 'truncatedReason', {
        value: hitPageCap ? 'page-cap' : 'deadline', enumerable: false, configurable: true,
      });
      logger.warn('SoundCloud crawl truncated', {
        endpoint, pagesFetched, collected: items.length,
        reason: hitPageCap ? 'page-cap' : 'deadline',
      });
    }
    return items;
  }

  /**
   * Create a new playlist
   */
  async createPlaylist(accessToken, refreshToken, title, description, trackIds = []) {
    const payload = {
      playlist: {
        title,
        description: description || '',
        sharing: 'public',
        ...(trackIds.length > 0 ? { tracks: trackIds.map(id => ({ urn: `soundcloud:tracks:${id}` })) } : {})
      }
    };

    return this.scRequest('/playlists', accessToken, refreshToken, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  }

  /**
   * Add tracks to a playlist
   */
  async addTracksToPlaylist(accessToken, refreshToken, playlistId, trackIds) {
    const payload = {
      playlist: {
        tracks: trackIds.map(id => ({ urn: `soundcloud:tracks:${id}` }))
      }
    };

    return this.scRequest(`/playlists/${playlistId}`, accessToken, refreshToken, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  }

  /**
   * Resolve a SoundCloud URL to get track/playlist information
   */
  async resolveUrl(accessToken, refreshToken, url) {
    const params = new URLSearchParams({
      url,
      client_id: this.clientId
    });

    return this.scRequest(`/resolve?${params.toString()}`, accessToken, refreshToken);
  }

  /**
   * Resolve URL with explicit 302 handling
   */
  async resolveAny(accessToken, refreshToken, targetUrl) {
    const doFetch = async (token) => {
      const res = await fetchWithTimeout(`https://api.soundcloud.com/resolve?url=${encodeURIComponent(targetUrl)}`, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'Authorization': `OAuth ${token}`,
          'Accept': 'application/json'
        }
      });
      if (res.status === 302) {
        const location = res.headers.get('location');
        if (!location) throw new Error('Resolve redirect missing location');
        const res2 = await fetchWithTimeout(location, {
          headers: {
            'Authorization': `OAuth ${token}`,
            'Accept': 'application/json'
          }
        });
        if (!res2.ok) {
          // Don't include response body in error message
          throw new Error(`Resolve follow error: ${res2.status}`);
        }
        return parseScJson(res2, { context: 'resolve' });
      }
      if (!res.ok) {
        // Don't include response body in error message
        throw new Error(`Resolve error: ${res.status}`);
      }
      return parseScJson(res, { context: 'resolve' });
    };

    try {
      return await doFetch(accessToken);
    } catch (err) {
      if (!String(err?.message || '').includes('401')) throw err;
      const refreshed = await this.refreshTokensAndPersist(refreshToken);
      return doFetch(refreshed.access_token);
    }
  }

  /**
   * Resolve URL using public client_id (no OAuth). Works for public resources.
   */
  async resolvePublic(targetUrl) {
    const base = `https://api.soundcloud.com/resolve?url=${encodeURIComponent(targetUrl)}&client_id=${encodeURIComponent(this.clientId)}`;
    const res = await fetchWithTimeout(base, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'Accept': 'application/json' }
    });
    if (res.status === 302) {
      const location = res.headers.get('location');
      if (!location) throw new Error('Resolve redirect missing location');
      const res2 = await fetchWithTimeout(location, { headers: { 'Accept': 'application/json' } });
      if (!res2.ok) {
        // Don't include response body in error message
        throw new Error(`Resolve follow error: ${res2.status}`);
      }
      return parseScJson(res2, { context: 'resolve (public)' });
    }
    if (!res.ok) {
      // Don't include response body in error message
      throw new Error(`Resolve error: ${res.status}`);
    }
    return parseScJson(res, { context: 'resolve (public)' });
  }

  buildPagedEndpoint(endpoint, { limit = 50, next, extraParams = {} } = {}) {
    if (next) {
      const nextUrl = new URL(String(next));
      return `${nextUrl.pathname}${nextUrl.search}`;
    }

    const params = new URLSearchParams({
      limit: String(limit),
      linked_partitioning: '1',
      ...extraParams,
    });
    return `${endpoint}?${params.toString()}`;
  }

  /**
   * Get a page of another user's public liked tracks.
   */
  async getUserLikedTracksPage(accessToken, refreshToken, userId, options = {}) {
    const endpoint = this.buildPagedEndpoint(`/users/${userId}/likes/tracks`, options);
    return this.scRequest(endpoint, accessToken, refreshToken);
  }

  /**
   * Get all public liked tracks visible for another user.
   */
  async getUserLikedTracks(accessToken, refreshToken, userId, limit = 200) {
    return this.paginate(`/users/${userId}/likes/tracks`, accessToken, refreshToken, limit);
  }

  /**
   * Get a page of another user's public playlists without embedded tracks.
   */
  async getUserPlaylistsPage(accessToken, refreshToken, userId, options = {}) {
    const endpoint = this.buildPagedEndpoint(`/users/${userId}/playlists`, {
      ...options,
      extraParams: { show_tracks: 'false', ...(options.extraParams || {}) },
    });
    return this.scRequest(endpoint, accessToken, refreshToken);
  }

  /**
   * Get a page of playlists liked by another user when visible via the API.
   */
  async getUserLikedPlaylistsPage(accessToken, refreshToken, userId, options = {}) {
    const endpoint = this.buildPagedEndpoint(`/users/${userId}/likes/playlists`, {
      ...options,
      extraParams: { show_tracks: 'false', ...(options.extraParams || {}) },
    });
    return this.scRequest(endpoint, accessToken, refreshToken);
  }

  /**
   * Get the user's activity/stream feed
   */
  async getActivities(accessToken, refreshToken, limit = 50) {
    return this.paginate('/me/activities', accessToken, refreshToken, limit);
  }

  /**
   * Unlike a track by its ID.
   * Tokens come first here, but the inverse (likeTrack) takes the ID first.
   */
  async unlikeTrack(accessToken, refreshToken, trackId) {
    return this.scRequest(`/likes/tracks/${trackId}`, accessToken, refreshToken, { method: 'DELETE' });
  }

  /**
   * Get the user's followings list
   */
  async getFollowings(accessToken, refreshToken, limit = 200) {
    return this.paginate('/me/followings', accessToken, refreshToken, limit);
  }

  /**
   * Get the user's followers list
   */
  async getFollowers(accessToken, refreshToken, limit = 200) {
    return this.paginate('/me/followers', accessToken, refreshToken, limit);
  }

  /**
   * Unfollow a user by their ID.
   * Tokens come first here, but the inverse (followUser) takes the ID first.
   */
  async unfollowUser(accessToken, refreshToken, userId) {
    return this.scRequest(`/me/followings/${userId}`, accessToken, refreshToken, { method: 'DELETE' });
  }

  /**
   * Get the user's reposts using SoundCloud's V2 API
   * (same endpoint SC's web app uses for the profile "Reposts" tab).
   * Falls back to the V1 activity feed if the V2 endpoint fails.
   */
  async getReposts(accessToken, refreshToken) {
    try {
      const [trackReposts, playlistReposts] = await Promise.all([
        this.paginate('/me/reposts/tracks', accessToken, refreshToken, 200),
        this.paginate('/me/reposts/playlists', accessToken, refreshToken, 200),
      ]);

      const normalize = (items, resourceType) => {
        return items.map(item => {
          // Some endpoints return { track: {...} }, others return the resource directly
          const resource = item.track || item.playlist || item;
          const id = resource.id ? Number(resource.id) : null;
          if (!id) return null;

          return {
            id,
            urn: resource.urn || `soundcloud:${resourceType}s:${id}`,
            resourceType,
            title: resource.title || 'Unknown',
            user: { username: resource.user?.username || 'Unknown' },
            artwork_url: resource.artwork_url || resource.user?.avatar_url || null,
            permalink_url: resource.permalink_url || null,
            created_at: item.created_at || resource.created_at || null,
          };
        }).filter(Boolean);
      };

      const results = [
        ...normalize(trackReposts, 'track'),
        ...normalize(playlistReposts, 'playlist')
      ];

      // Sort by created_at descending if available
      results.sort((a, b) => {
        if (!a.created_at) return 1;
        if (!b.created_at) return -1;
        return new Date(b.created_at) - new Date(a.created_at);
      });

      logger.info(`[getReposts] returning ${results.length} reposts`);
      return results;
    } catch (e) {
      logger.error('[getReposts] error fetching reposts:', e.message);
      return [];
    }
  }

  /**
   * Get the user's recently played tracks
   */
  async getRecentlyPlayed(accessToken, refreshToken) {
    const data = await this.scRequest('/me/recently-played/tracks', accessToken, refreshToken);
    return data?.collection || [];
  }

  /**
   * Get related artists for a user
   */
  async getRelatedArtists(userUrn, accessToken, refreshToken, limit = 10) {
    const data = await this.scRequest(`/users/${userUrn}/related?limit=${limit}&linked_partitioning=1`, accessToken, refreshToken);
    return data?.collection || [];
  }

  /**
   * Remove a repost. resourceType must be 'track' or 'playlist'.
   */
  async deleteRepost(accessToken, refreshToken, id, resourceType) {
    const path = resourceType === 'playlist'
      ? `/reposts/playlists/${id}`
      : `/reposts/tracks/${id}`;
    return this.scRequest(path, accessToken, refreshToken, { method: 'DELETE' });
  }

  /**
   * Delete a playlist by its ID
   */
  async deletePlaylist(accessToken, refreshToken, playlistId) {
    return this.scRequest(`/playlists/${playlistId}`, accessToken, refreshToken, { method: 'DELETE' });
  }

  /**
   * Search tracks by genre, tags, and other filters
   */
  async searchTracks(accessToken, refreshToken, params = {}) {
    const queryParams = new URLSearchParams();

    if (params.genres) queryParams.set('genres', params.genres);
    if (params.tags) queryParams.set('tags', params.tags);
    if (params.q) queryParams.set('q', params.q);
    if (params.bpm_from) queryParams.set('bpm[from]', String(params.bpm_from));
    if (params.bpm_to) queryParams.set('bpm[to]', String(params.bpm_to));
    if (params.duration_from) queryParams.set('duration[from]', String(params.duration_from));
    if (params.duration_to) queryParams.set('duration[to]', String(params.duration_to));
    if (params.limit) queryParams.set('limit', String(params.limit));
    if (params.offset) queryParams.set('offset', String(params.offset));

    queryParams.set('linked_partitioning', '1');

    return this.scRequest(`/tracks?${queryParams.toString()}`, accessToken, refreshToken);
  }

  /**
   * Fetch full track objects by ID in bulk (GET /tracks?ids=...).
   * Pass at most ~50 IDs per call; returns only the tracks SoundCloud still
   * knows about — missing IDs are simply absent from the result.
   */
  async getTracksByIds(accessToken, refreshToken, trackIds) {
    const ids = (trackIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (ids.length === 0) return [];
    const queryParams = new URLSearchParams({
      ids: ids.join(','),
      limit: String(ids.length),
      linked_partitioning: '1',
    });
    const data = await this.scRequest(`/tracks?${queryParams.toString()}`, accessToken, refreshToken);
    if (Array.isArray(data?.collection)) return data.collection;
    return Array.isArray(data) ? data : [];
  }

  /**
   * Get any user's profile
   */
  async getUserProfile(userId, accessToken, refreshToken) {
    return this.scRequest(`/users/${userId}`, accessToken, refreshToken);
  }

  /**
   * Get any user's followers (paginated; see paginate() for crawl options)
   */
  async getUserFollowers(userId, accessToken, refreshToken, limit = 200, options = {}) {
    return this.paginate(`/users/${userId}/followers`, accessToken, refreshToken, limit, options);
  }

  /**
   * Get any user's followings (paginated; see paginate() for crawl options)
   */
  async getUserFollowings(userId, accessToken, refreshToken, limit = 200, options = {}) {
    return this.paginate(`/users/${userId}/followings`, accessToken, refreshToken, limit, options);
  }

  /**
   * Get any user's tracks
   */
  async getUserTracks(userId, accessToken, refreshToken, limit = 10) {
    const data = await this.scRequest(
      `/users/${userId}/tracks?limit=${limit}&linked_partitioning=1`,
      accessToken,
      refreshToken
    );
    return data?.collection || [];
  }

  /**
   * Follow a user
   */
  async followUser(userId, accessToken, refreshToken) {
    return this.scRequest(`/me/followings/${userId}`, accessToken, refreshToken, { method: 'PUT' });
  }

  /**
   * Like a track
   */
  async likeTrack(trackId, accessToken, refreshToken) {
    return this.scRequest(`/likes/tracks/${trackId}`, accessToken, refreshToken, { method: 'POST' });
  }

  /**
   * Get the final download link for a track
   * Handles the redirect manually to ensure we get the final URL
   */
  async getDownloadLink(accessToken, refreshToken, downloadUrl, triedRefresh = false) {
    // Only allow SoundCloud API download URLs to prevent SSRF / token leakage
    try {
      const u = new URL(downloadUrl);
      const host = u.hostname.toLowerCase();
      if (u.protocol !== 'https:' || host !== 'api.soundcloud.com') {
        throw new Error('Invalid download URL');
      }
      if (!/^\/tracks\/\d+\/download$/.test(u.pathname)) {
        throw new Error('Invalid download path');
      }
    } catch (e) {
      if (e.message === 'Invalid download URL' || e.message === 'Invalid download path') throw e;
      throw new Error('Invalid download URL');
    }

    const fetchUrl = downloadUrl.replace('https://api.soundcloud.com', this.baseUrl);
    const res = await fetchWithTimeout(fetchUrl, {
      method: 'GET',
      headers: {
        'Authorization': `OAuth ${accessToken}`,
        'Accept': 'application/json, */*'
      },
      redirect: 'manual' 
    });

    if (res.status === 302 || res.status === 301) {
      return { redirect: res.headers.get('location') };
    }
    
    if (res.status === 200) {
        // Sometimes it returns the file directly? Or a JSON with the link?
        // Usually it's a redirect. If it's 200, it might be the binary data, 
        // which we can't easily proxy without streaming.
        // But for "download" we usually want to redirect the user.
        // Let's check headers.
        const type = res.headers.get('content-type');
        if (type && type.includes('application/json')) {
            const json = (await parseScJson(res, { context: 'download' })) || {};
            return { redirect: json.redirectUri || json.url || json.link }; // Handle various JSON responses
        }
        // If it's a file, we might be in trouble if we expected a link.
        // But the 401 error usually implies we failed the manifest check.
        // Let's assume correct auth gets us a redirect.
    }

    if (res.status === 401 && !triedRefresh) {
        // Try refreshing
        const refreshed = await this.refreshTokensAndPersist(refreshToken);
        return this.getDownloadLink(refreshed.access_token, refreshed.refresh_token || refreshToken, downloadUrl, true);
    }
    
    throw new Error(`Download request failed: ${res.status}`);
  }
}

export const soundcloudClient = new SoundCloudClient();