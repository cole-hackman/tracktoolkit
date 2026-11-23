import { jest } from '@jest/globals';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { Response } from 'node-fetch';

// Second independent pass on fix/token-lifecycle-integrity (C1 held pair, C6
// growth-job cancel). Each test targets an interleaving the first two passes
// did not: a teardown or login that lands *inside* the save-retry loop, a
// genuine revocation while the held access token is still fresh, an unreadable
// row during resume, cancel on the 401-refresh re-send, and the shouldAbort
// option leaking into fetch.

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

describe('held pair vs a teardown or login inside the save-retry loop', () => {
  // Regression guard, now passing. Before the fix: `_persistRefreshedTokens` holds the pair after
  // its last attempt fails, with no check that a disconnect ran meanwhile. If
  // disconnectUser completes (row deleted, forgetRecentRotation called) while
  // the final update is in flight and that update then fails with anything but
  // P2025, the hold lands AFTER the forget: plaintext live tokens for a
  // disconnected user stay in a no-TTL map until restart or the next login,
  // and an in-flight caller presenting the spent token is served them.
  test('a disconnect that completes during the last save attempt leaves no held pair', async () => {
    const sc = rotatingSoundCloud();
    let calls = 0;
    tokenUpdate.mockImplementation(async () => {
      calls += 1;
      if (calls === 4) {
        await disconnectUser('user-1', { reason: 'user' });
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      throw poolTimeout();
    });

    const res = await request(app).get('/probe').set('Cookie', sessionCookie());
    expect(res.status).toBe(500);
    expect(storedTokenRow).toBeNull();
    expect(tokenUpdate).toHaveBeenCalledTimes(4);

    // Past the rotation memo's 60 s, only the no-TTL held map could answer.
    advanceClock(61_000);
    const served = await runWithTokenContext({ userId: 'user-1' },
      () => soundcloudClient.refreshTokensAndPersist('good-refresh')).catch(() => null);

    expect(served).toBeNull();
    expect(sc.presented).toEqual(['good-refresh', 'good-refresh']);
  });

  // Regression guard, now passing. Before the fix: the retry loop writes without the
  // compare-before-write that _resumeUnsavedRotation has. A login that lands
  // between attempt 1 and attempt 2 is overwritten by the older pair. The same
  // race existed with one update, but the retries widen it from one query to
  // ~600 ms plus four queries.
  test('a login between save attempts is not overwritten by the retry', async () => {
    rotatingSoundCloud();
    tokenUpdate.mockImplementationOnce(async () => {
      // The OAuth callback runs now: upsert, then forgetRecentRotation.
      storedTokenRow = {
        encrypted: encrypt('login-access', KEY),
        refresh: encrypt('login-refresh', KEY),
        expiresAt: new Date(Date.now() + 3600_000),
      };
      forgetRecentRotation('user-1');
      throw poolTimeout();
    });

    await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(decrypt(storedTokenRow.refresh, KEY)).toBe('login-refresh');
  });

  test('a disconnect during a retry sleep: P2025 on the next attempt, nothing held', async () => {
    const sc = rotatingSoundCloud();
    tokenUpdate.mockImplementationOnce(async () => {
      await disconnectUser('user-1', { reason: 'user' });
      throw poolTimeout();
    });

    const res = await request(app).get('/probe').set('Cookie', sessionCookie());
    expect(res.status).toBe(500);
    expect(tokenUpdate).toHaveBeenCalledTimes(2);   // retried once, then P2025

    advanceClock(61_000);
    await runWithTokenContext({ userId: 'user-1' },
      () => soundcloudClient.refreshTokensAndPersist('good-refresh')).catch(() => null);
    expect(sc.presented).toEqual(['good-refresh', 'good-refresh']);
  });
});

describe('resume path', () => {
  test('an unreadable row during resume: served, not written, still held, saved next time', async () => {
    const sc = rotatingSoundCloud();
    await holdAPair();
    advanceClock(61_000);
    clearAuthCache();

    tokenFindUnique.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Can\'t reach database server'), { code: 'P1001' });
    });
    const updatesBefore = tokenUpdate.mock.calls.length;
    const res = await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(res.status).toBe(200);
    expect(sc.apiCalls.at(-1).auth).toBe('OAuth access-1');
    expect(tokenUpdate.mock.calls.length).toBe(updatesBefore);    // no blind write
    expect(decrypt(storedTokenRow.refresh, KEY)).toBe('good-refresh');

    clearAuthCache();
    const again = await request(app).get('/probe').set('Cookie', sessionCookie());
    expect(again.status).toBe(200);
    expect(decrypt(storedTokenRow.refresh, KEY)).toBe('refresh-1');
    expect(sc.presented).toEqual(['good-refresh']);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
  });

  test('a genuine revocation while the held access token is still fresh is torn down on the next request, no loop', async () => {
    const sc = rotatingSoundCloud();
    await holdAPair();
    sc.revoked = true;
    advanceClock(61_000);           // memo gone, held access-1 still has ~59 min
    clearAuthCache();

    // 1: served the held pair (now dead upstream), which is saved; the retry 401s.
    const first = await request(app).get('/probe').set('Cookie', sessionCookie());
    expect(first.status).toBe(500);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(decrypt(storedTokenRow.refresh, KEY)).toBe('refresh-1');

    // 2: presents refresh-1, which is the stored token: a real revocation.
    clearAuthCache();
    const second = await request(app).get('/probe').set('Cookie', sessionCookie());
    expect(second.status).toBe(500);
    expect(tokenDeleteMany).toHaveBeenCalledTimes(1);
    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ disconnectedAt: expect.any(Date) }),
    }));
    expect(sc.oauthCalls).toBe(2);   // good-refresh once, refresh-1 once
  });

  test('a pair re-held after a second failed exchange still answers the first spent token', async () => {
    const sc = rotatingSoundCloud();
    await holdAPair();                              // good-refresh -> refresh-1, held
    advanceClock(2 * 3600_000);                     // held access expired
    clearAuthCache();
    tokenUpdate.mockImplementation(async () => { throw poolTimeout(); });
    await request(app).get('/probe').set('Cookie', sessionCookie());   // refresh-1 -> refresh-2, held again
    expect(sc.presented).toEqual(['good-refresh', 'refresh-1']);

    tokenUpdate.mockImplementation(writeTokenRow);
    const tokens = await runWithTokenContext({ userId: 'user-1' },
      () => soundcloudClient.refreshTokensAndPersist('good-refresh'));
    expect(tokens.refresh_token).toBe('refresh-2');
    expect(decrypt(storedTokenRow.refresh, KEY)).toBe('refresh-2');
    expect(sc.presented).toEqual(['good-refresh', 'refresh-1']);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
  });
});

describe('scRequest shouldAbort', () => {
  test('never reaches fetch, with or without the option, across a 429 retry', async () => {
    const seen = [];
    let n = 0;
    global.fetch = jest.fn(async (_url, options) => {
      seen.push(Object.keys(options).sort());
      n += 1;
      if (n % 2 === 1) return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
      return new Response('{}', { status: 200 });
    });

    await soundcloudClient.scRequest('/likes/tracks/1', 'a', 'r', { method: 'POST', body: '{}', shouldAbort: () => false });
    await soundcloudClient.scRequest('/likes/tracks/1', 'a', 'r', { method: 'POST', body: '{}' });

    expect(seen).toHaveLength(4);
    for (const keys of seen) {
      expect(keys).toEqual(['body', 'headers', 'method', 'signal']);
    }
  });

  test('a cancel during the 401 refresh stops the re-send, and the refreshed pair is still saved', async () => {
    const flag = { abort: false };
    const writes = [];
    global.fetch = jest.fn(async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/oauth/token')) {
        flag.abort = true;     // disconnect lands while the exchange is in flight
        return new Response(JSON.stringify({
          access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600,
        }), { status: 200 });
      }
      writes.push(options.headers.Authorization);
      return new Response('', { status: 401 });
    });

    await expect(runWithTokenContext({ userId: 'user-1' },
      () => soundcloudClient.followUser(42, 'stale-access', 'good-refresh', { shouldAbort: () => flag.abort })))
      .rejects.toThrow();

    expect(writes).toEqual(['OAuth stale-access']);    // never re-sent
    // The rotation happened upstream; dropping its result would strand the row.
    expect(decrypt(storedTokenRow.refresh, KEY)).toBe('refresh-new');
  });

  test('a like waiting in 429 backoff is not re-sent after a user cancel', async () => {
    const posts = [];
    let cancelled = false;
    let sawLike429;
    const like429 = new Promise((r) => { sawLike429 = r; });
    global.fetch = jest.fn(async (url, options = {}) => {
      const method = String(options.method || 'GET').toUpperCase();
      if (method === 'POST') {
        posts.push({ afterCancel: cancelled });
        if (posts.length === 1) {
          sawLike429();
          return new Response('', { status: 429, headers: { 'Retry-After': '1' } });
        }
      }
      return new Response('{}', { status: 200 });
    });

    let settledResolve;
    const settled = new Promise((r) => { settledResolve = r; });
    const job = startEngagementJob(new GrowthEngine(soundcloudClient), {
      prisma: prismaMock,
      userId: 'user-like',
      accessToken: 'a',
      refreshToken: 'r',
      targets: [{ userId: 301, likeTrackId: 9001 }, { userId: 302, likeTrackId: 9002 }],
      likeTracks: true,
      sessionLabel: 't',
      inspirationIds: [],
      inspirationNames: [],
      onSettled: settledResolve,
    });

    await like429;
    expect(cancelEngagementJob('user-like')).toBe(true);
    cancelled = true;
    await settled;

    expect(job.status).toBe('cancelled');
    expect(job.followed).toBe(1);
    expect(job.liked).toBe(0);
    expect(posts.filter((p) => p.afterCancel)).toEqual([]);
  }, 15_000);
});
