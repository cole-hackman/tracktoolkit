import { jest } from '@jest/globals';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { Response } from 'node-fetch';


const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ORIGINAL_SESSION_SECRET = process.env.SESSION_SECRET;
process.env.ENCRYPTION_KEY = 'x'.repeat(32);
process.env.SESSION_SECRET = 's'.repeat(40);

let storedTokenRow;
const writeTokenRow = async (args) => {
  if (!storedTokenRow) {
    throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
  }
  storedTokenRow = {
    encrypted: args.data.encrypted,
    refresh: args.data.refresh,
    expiresAt: args.data.expiresAt,
  };
  return {};
};
const tokenUpdate = jest.fn(writeTokenRow);
const tokenFindUnique = jest.fn(async () => storedTokenRow ?? null);
const tokenDeleteMany = jest.fn(async () => { storedTokenRow = null; return { count: 1 }; });
const userUpdate = jest.fn().mockResolvedValue({});
// authenticateUser reads the user with its tokens; derive them from the row so
// a saved pair is what the next request starts from.
const userFindUnique = jest.fn(async () => ({
  id: 'user-1',
  soundcloudId: 111,
  tokens: storedTokenRow ? [{ ...storedTokenRow }] : [],
}));

const prismaMock = {
  user: { findUnique: userFindUnique, update: userUpdate },
  token: { update: tokenUpdate, deleteMany: tokenDeleteMany, findUnique: tokenFindUnique },
  growthAction: { create: jest.fn().mockResolvedValue({}) },
};
jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../server/lib/snapshot-cache.js', () => ({
  dropSnapshots: jest.fn().mockResolvedValue(undefined),
  readSnapshot: jest.fn(),
  writeSnapshot: jest.fn(),
  invalidateSnapshot: jest.fn().mockResolvedValue({ count: 0 }),
  SNAPSHOT_RESOURCES: ['likes', 'playlists', 'followings', 'followers', 'reposts'],
}));

const { encrypt, decrypt } = await import('../../server/lib/crypto.js');
const { signSession } = await import('../../server/lib/session.js');
const { authenticateUser } = await import('../../server/middleware/auth.js');
const { clearAuthCache } = await import('../../server/lib/auth-cache.js');
const { soundcloudClient, clearRecentRotations, forgetRecentRotation } =
  await import('../../server/lib/soundcloud-client.js');
const { runWithTokenContext } = await import('../../server/lib/token-context.js');
const { disconnectUser } = await import('../../server/lib/account-lifecycle.js');
const { GrowthEngine, startEngagementJob, cancelEngagementJob } =
  await import('../../server/lib/growth-engine.js');

const KEY = process.env.ENCRYPTION_KEY;

const app = express();
app.use(cookieParser());
app.get('/probe', authenticateUser, async (req, res) => {
  try {
    const data = await soundcloudClient.scRequest('/me', req.accessToken, req.refreshToken);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function sessionCookie(userId = 'user-1') {
  const value = JSON.stringify({ userId, soundcloudId: 111, iat: Date.now() });
  return `session=${encodeURIComponent(signSession(value, process.env.SESSION_SECRET))}`;
}

let clockSpy = null;
function advanceClock(ms) {
  const base = Date.now();
  clockSpy?.mockRestore();
  clockSpy = jest.spyOn(Date, 'now').mockImplementation(() => base + ms);
}

function poolTimeout() {
  return Object.assign(new Error('Timed out fetching a new connection'), { code: 'P2024' });
}

/**
 * Rotating SoundCloud. `revoked` makes every exchange invalid_grant AND every
 * API call with a non-stale token 401, as a real revocation would.
 */
function rotatingSoundCloud() {
  const spent = new Set();
  const state = { oauthCalls: 0, presented: [], apiCalls: [], revoked: false };
  let issued = 0;
  global.fetch = jest.fn(async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/oauth/token')) {
      state.oauthCalls += 1;
      const presented = new URLSearchParams(String(options.body)).get('refresh_token');
      state.presented.push(presented);
      if (state.revoked || spent.has(presented)) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      spent.add(presented);
      issued += 1;
      return new Response(JSON.stringify({
        access_token: `access-${issued}`,
        refresh_token: `refresh-${issued}`,
        expires_in: 3600,
      }), { status: 200 });
    }
    const auth = options.headers?.Authorization || '';
    state.apiCalls.push({ target, auth, method: options.method || 'GET' });
    if (auth === 'OAuth stale-access' || state.revoked) return new Response('', { status: 401 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  return state;
}

/** Exchange good-refresh -> refresh-1 while every save fails, leaving it held. */
async function holdAPair() {
  tokenUpdate.mockImplementation(async () => { throw poolTimeout(); });
  const res = await request(app).get('/probe').set('Cookie', sessionCookie());
  expect(res.status).toBe(500);
  expect(decrypt(storedTokenRow.refresh, KEY)).toBe('good-refresh');
  tokenUpdate.mockImplementation(writeTokenRow);
}

const originalFetch = global.fetch;

beforeEach(() => {
  tokenUpdate.mockReset();
  tokenUpdate.mockImplementation(writeTokenRow);
  tokenFindUnique.mockReset();
  tokenFindUnique.mockImplementation(async () => storedTokenRow ?? null);
  tokenDeleteMany.mockClear();
  userUpdate.mockClear();
  storedTokenRow = {
    encrypted: encrypt('stale-access', KEY),
    refresh: encrypt('good-refresh', KEY),
    expiresAt: new Date(Date.now() - 60_000),
  };
  clearAuthCache();
  clearRecentRotations();
  clockSpy?.mockRestore();
  clockSpy = null;
  global.fetch = jest.fn();
});

afterAll(() => {
  clockSpy?.mockRestore();
  if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
  if (ORIGINAL_SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = ORIGINAL_SESSION_SECRET;
  global.fetch = originalFetch;
});

// Round 3 (independent): the forget-generation write path, SC_CANCELLED across
// the 401 path, the growth job's `continue`, and revocation under a database
// whose writes never recover.

describe('forgotten save: the compare read is the only guard', () => {
  // Regression guard, now passing. Before the fix: once `forgotten()` is true every possible
  // cause (disconnect, deletion, login, resume "moved on") means the row is no
  // longer the one this pair replaced, yet an UNREADABLE compare read
  // (`_readStoredTokens` -> null on any DB error) is treated like a missing row
  // and the retry writes. On a flaky pool — the only reason the retry runs —
  // that overwrites the login's fresh pair with the older one.
  test('a login between attempts is not overwritten when the compare read fails', async () => {
    rotatingSoundCloud();
    tokenUpdate.mockImplementationOnce(async () => {
      storedTokenRow = {
        encrypted: encrypt('login-access', KEY),
        refresh: encrypt('login-refresh', KEY),
        expiresAt: new Date(Date.now() + 3600_000),
      };
      forgetRecentRotation('user-1');
      throw poolTimeout();
    });
    tokenFindUnique.mockImplementationOnce(async () => { throw poolTimeout(); });

    await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(decrypt(storedTokenRow.refresh, KEY)).toBe('login-refresh');
  });
});

describe('SC_CANCELLED across the 401 path', () => {
  // Regression guard, now passing. Before the fix: throwIfAborted() after the refresh runs
  // inside scRequest's 401 try-block, whose catch rethrows a fresh
  // "Token refresh failed". The code is lost, so the growth job's
  // SC_CANCELLED check never matches on this path and the cancelled follow is
  // recorded as a failure. No write is re-sent (that part holds).
  test('followUser cancelled during the refresh rejects with code SC_CANCELLED', async () => {
    let abort = false;
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/oauth/token')) {
        abort = true;
        return new Response(JSON.stringify({
          access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600,
        }), { status: 200 });
      }
      return new Response('', { status: 401 });
    });

    const err = await runWithTokenContext({ userId: 'user-1' },
      () => soundcloudClient.followUser(42, 'stale-access', 'good-refresh', { shouldAbort: () => abort }))
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('SC_CANCELLED');
  });

  test('a growth job cancelled during a follow\'s 401 refresh records no failure', async () => {
    const puts = [];
    global.fetch = jest.fn(async (url, options = {}) => {
      if (String(url).includes('/oauth/token')) {
        cancelEngagementJob('user-1');
        return new Response(JSON.stringify({
          access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600,
        }), { status: 200 });
      }
      puts.push(options.headers.Authorization);
      return new Response('', { status: 401 });
    });

    let settledResolve;
    const settled = new Promise((r) => { settledResolve = r; });
    const job = await runWithTokenContext({ userId: 'user-1' }, async () => startEngagementJob(
      new GrowthEngine(soundcloudClient), {
        prisma: prismaMock, userId: 'user-1', accessToken: 'stale-access', refreshToken: 'good-refresh',
        targets: [{ userId: 501 }, { userId: 502 }], likeTracks: false,
        sessionLabel: 't', inspirationIds: [], inspirationNames: [], onSettled: settledResolve,
      }));
    await settled;

    expect(puts).toEqual(['OAuth stale-access']);   // never re-sent: holds
    expect(job.status).toBe('cancelled');
    expect(job.errors).toEqual([]);                  // fails: 'Follow failed' recorded
  });
});

describe('growth job: SC_CANCELLED `continue` on the last target', () => {
  // Regression guard, now passing. Before the fix: `continue` on the LAST target leaves the
  // loop without passing the top-of-loop cancel check, so a job the user (or a
  // disconnect) cancelled is finalised as status 'complete'.
  test('a cancel during the last follow\'s 429 backoff ends the job as cancelled', async () => {
    let sawFirst;
    const first429 = new Promise((r) => { sawFirst = r; });
    const puts = [];
    global.fetch = jest.fn(async (_url, options = {}) => {
      puts.push(options.method);
      sawFirst();
      return new Response('', { status: 429, headers: { 'Retry-After': '1' } });
    });

    let settledResolve;
    const settled = new Promise((r) => { settledResolve = r; });
    const job = startEngagementJob(new GrowthEngine(soundcloudClient), {
      prisma: prismaMock, userId: 'user-last', accessToken: 'a', refreshToken: 'r',
      targets: [{ userId: 601 }], likeTracks: false,
      sessionLabel: 't', inspirationIds: [], inspirationNames: [], onSettled: settledResolve,
    });
    await first429;
    expect(cancelEngagementJob('user-last')).toBe(true);
    await settled;

    expect(puts).toEqual(['PUT']);           // not re-sent: holds
    expect(job.errors).toEqual([]);          // holds
    expect(job.status).toBe('cancelled');    // fails: 'complete'
  }, 15_000);
});

describe('genuine revocation while writes never recover', () => {
  test('stays connected at most until the held access token expires, then torn down; bounded calls', async () => {
    const sc = rotatingSoundCloud();
    await holdAPair();
    sc.revoked = true;
    tokenUpdate.mockImplementation(async () => { throw poolTimeout(); });   // DB writes stay down

    // Inside the held token's hour: served, retry 401s, nothing torn down.
    for (const ms of [61_000, 10 * 60_000, 10 * 60_000]) {   // cumulative: ~21 min
      advanceClock(ms);
      clearAuthCache();
      const res = await request(app).get('/probe').set('Cookie', sessionCookie());
      expect(res.status).toBe(500);
    }
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(sc.oauthCalls).toBe(1);   // resume never exchanges

    // Past it: the held refresh token is presented, refused, and since it IS
    // the live one, that is a revocation.
    advanceClock(2 * 3600_000);
    clearAuthCache();
    await request(app).get('/probe').set('Cookie', sessionCookie());
    expect(tokenDeleteMany).toHaveBeenCalledTimes(1);
    expect(sc.oauthCalls).toBe(2);

    // And nothing plaintext survives for the next presenter.
    expect(await soundcloudClient._resolveInvalidGrant('good-refresh', 'user-1')).toBeNull();
    expect(await soundcloudClient._resolveInvalidGrant('refresh-1', 'user-1')).toBeNull();
  }, 20_000);

  test('a held pair is not served after DELETE-style teardown even while a resume save is mid-retry', async () => {
    const sc = rotatingSoundCloud();
    await holdAPair();
    advanceClock(61_000);
    clearAuthCache();
    // The resume's save fails once; during that attempt the account is torn down.
    tokenUpdate.mockImplementationOnce(async () => {
      await disconnectUser('user-1', { reason: 'user' });
      throw poolTimeout();
    });

    const tokens = await runWithTokenContext({ userId: 'user-1' },
      () => soundcloudClient.refreshTokensAndPersist('good-refresh')).catch(() => null);

    expect(tokens).toBeNull();
    // Nothing held afterwards either.
    expect(await soundcloudClient._resolveInvalidGrant('good-refresh', 'user-1')).toBeNull();
    expect(sc.presented.filter((t) => t === 'refresh-1')).toEqual([]);
  }, 20_000);
});
