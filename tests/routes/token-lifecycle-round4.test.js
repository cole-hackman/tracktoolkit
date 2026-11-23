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

// Round 4 (independent verifier): what the latest fixes must not have broken.

describe('_readStoredTokens: the new option changes nothing for default callers', () => {
  test('a failed read is null by default, the sentinel only when asked', async () => {
    tokenFindUnique.mockImplementation(async () => { throw poolTimeout(); });
    expect(await soundcloudClient._readStoredTokens('user-1')).toBeNull();
    const flagged = await soundcloudClient._readStoredTokens('user-1', { distinguishUnreadable: true });
    expect(flagged).not.toBeNull();
    expect(typeof flagged).toBe('symbol');
  });

  test('_resolveInvalidGrant on an unreadable row: null, nothing torn down', async () => {
    tokenFindUnique.mockImplementation(async () => { throw poolTimeout(); });
    expect(await soundcloudClient._resolveInvalidGrant('good-refresh', 'user-1')).toBeNull();
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  test('a missing row (no option) is still null and never a teardown', async () => {
    storedTokenRow = null;
    expect(await soundcloudClient._resolveInvalidGrant('good-refresh', 'user-1')).toBeNull();
    expect(tokenDeleteMany).not.toHaveBeenCalled();
  });
});

describe('genuine revocation with a healthy database still tears down', () => {
  test('stored == presented, exchange refused: one teardown, no loop', async () => {
    const sc = rotatingSoundCloud();
    sc.revoked = true;
    const res = await request(app).get('/probe').set('Cookie', sessionCookie());
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Token refresh failed');
    expect(tokenDeleteMany).toHaveBeenCalledTimes(1);
    expect(sc.oauthCalls).toBe(1);
  });
});

describe('401 path: only a cancel keeps its code', () => {
  test('a refresh failure without a cancel is still the generic message', async () => {
    rotatingSoundCloud().revoked = true;
    const err = await runWithTokenContext({ userId: 'user-1' },
      () => soundcloudClient.followUser(42, 'stale-access', 'good-refresh', { shouldAbort: () => false }))
      .catch((e) => e);
    expect(err.message).toBe('Token refresh failed');
    expect(err.code).toBeUndefined();
  });
});

describe('growth job: a cancelled break still finalises and frees the user', () => {
  test('cancel during a like\'s 429 backoff: cancelled, finishedAt set, onSettled fired, a new job may start', async () => {
    let saw429;
    const hit429 = new Promise((r) => { saw429 = r; });
    const calls = [];
    global.fetch = jest.fn(async (url, options = {}) => {
      calls.push(`${options.method} ${String(url).replace('https://api.soundcloud.com', '')}`);
      if (options.method === 'POST') {
        saw429();
        return new Response('', { status: 429, headers: { 'Retry-After': '1' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    let settledResolve;
    const settled = new Promise((r) => { settledResolve = r; });
    const onSettled = jest.fn((j) => settledResolve(j));
    const job = startEngagementJob(new GrowthEngine(soundcloudClient), {
      prisma: prismaMock, userId: 'user-r4', accessToken: 'a', refreshToken: 'r',
      targets: [{ userId: 701, likeTrackId: 9001 }, { userId: 702, likeTrackId: 9002 }],
      likeTracks: true, sessionLabel: 't', inspirationIds: [], inspirationNames: [], onSettled,
    });
    await hit429;
    expect(cancelEngagementJob('user-r4')).toBe(true);
    await settled;

    expect(calls).toEqual(['PUT /me/followings/701', 'POST /likes/tracks/9001']);
    expect(job.status).toBe('cancelled');
    expect(job.followed).toBe(1);
    expect(job.liked).toBe(0);
    expect(job.errors).toEqual([]);
    expect(typeof job.finishedAt).toBe('number');
    expect(onSettled).toHaveBeenCalledTimes(1);

    // The per-user lock is the job's status: a new batch must be accepted.
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    let s2;
    const settled2 = new Promise((r) => { s2 = r; });
    const next = startEngagementJob(new GrowthEngine(soundcloudClient), {
      prisma: prismaMock, userId: 'user-r4', accessToken: 'a', refreshToken: 'r',
      targets: [{ userId: 703 }], likeTracks: false,
      sessionLabel: 't', inspirationIds: [], inspirationNames: [], onSettled: s2,
    });
    await settled2;
    expect(next).not.toBe(job);
    expect(next.status).toBe('complete');
    expect(next.followed).toBe(1);
  }, 20_000);
});

describe('no plaintext pair survives a login', () => {
  test('a held pair is dropped by the login-time forget and never served for the spent token', async () => {
    const sc = rotatingSoundCloud();
    await holdAPair();
    // A login writes a fresh pair and forgets (what the callback does).
    storedTokenRow = {
      encrypted: encrypt('login-access', KEY),
      refresh: encrypt('login-refresh', KEY),
      expiresAt: new Date(Date.now() + 3600_000),
    };
    forgetRecentRotation('user-1');

    // The spent token is now just superseded: the login's pair comes back, not refresh-1.
    const tokens = await soundcloudClient._resolveInvalidGrant('good-refresh', 'user-1');
    expect(tokens?.refresh_token).toBe('login-refresh');
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(sc.presented.filter((t) => t === 'refresh-1')).toEqual([]);
  });
});
