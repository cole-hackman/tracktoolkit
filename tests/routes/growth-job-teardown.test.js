import { jest } from '@jest/globals';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

process.env.ENCRYPTION_KEY ||= 'x'.repeat(32);
process.env.SESSION_SECRET ||= 's'.repeat(40);
process.env.APP_URL ||= 'https://tracktoolkit.com';
process.env.APP_URLS ||= 'https://tracktoolkit.com';

// A running engagement job holds the user's decrypted tokens in its closure
// and only stops when `job.cancelRequested` is set. Disconnect and account
// deletion destroy the stored tokens, but before this suite nothing told the
// job, so it kept following and liking on the person's behalf after they had
// handed the grant back — or deleted the account outright.
//
// The job's pacing sleep is gated here, so the teardown lands exactly where it
// would in production: between two writes, while the job is waiting.

const pendingSleeps = [];
jest.unstable_mockModule('../../server/lib/pacing.js', () => ({
  SC_WRITE_PACING_MS: 300,
  SC_PLAYLIST_PACING_MS: 500,
  SC_BULK_PACING_MS: 150,
  SC_READ_CONCURRENCY: 5,
  mapWithConcurrency: async (items, _limit, fn) => Promise.all(items.map(fn)),
  sleep: () => new Promise((resolve) => pendingSleeps.push(resolve)),
}));

function releaseSleeps() {
  while (pendingSleeps.length) pendingSleeps.shift()();
}

/** Let every queued promise callback run, without real timers. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Release sleeps until the job reaches a terminal state, then wait for it. */
async function runToEnd(job, settled) {
  for (let i = 0; i < 20 && job.status === 'running'; i++) {
    releaseSleeps();
    await settle();
  }
  await settled;
}

const userDelete = jest.fn().mockResolvedValue({});
const userUpdate = jest.fn().mockResolvedValue({});
const tokenDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
const growthActionCreate = jest.fn().mockResolvedValue({});
const signOut = jest.fn().mockResolvedValue(true);

const prismaMock = {
  user: { delete: userDelete, update: userUpdate },
  token: { deleteMany: tokenDeleteMany },
  growthAction: { create: growthActionCreate },
};
jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: {},
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
  signOut,
  forgetRecentRotation: jest.fn(),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation: jest.fn(),
  startOperationTimer: () => () => 0,
  extractClientInfo: () => ({}),
  getAnalyticsWriteHealth: jest.fn(),
}));
jest.unstable_mockModule('../../server/lib/snapshot-cache.js', () => ({
  dropSnapshots: jest.fn().mockResolvedValue(undefined),
  readSnapshot: jest.fn(),
  writeSnapshot: jest.fn(),
  invalidateSnapshot: jest.fn().mockResolvedValue({ count: 0 }),
  SNAPSHOT_RESOURCES: ['likes', 'playlists', 'followings', 'followers', 'reposts'],
}));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, _res, next) => {
    req.user = { id: 'user-del', soundcloudId: 555 };
    req.accessToken = 'live-access-token';
    next();
  },
}));
jest.unstable_mockModule('../../server/middleware/rateLimiter.js', () => ({
  heavyOperationRateLimiter: (_req, _res, next) => next(),
}));

const { GrowthEngine, startEngagementJob } = await import('../../server/lib/growth-engine.js');
const { disconnectUser } = await import('../../server/lib/account-lifecycle.js');
const { default: authRoutes } = await import('../../server/routes/auth.js');

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/api/auth', authRoutes);

/**
 * A SoundCloud that records every write, and when it happened relative to the
 * teardown. `teardownAt` is set by the test the moment the token rows are
 * deleted; a write recorded after that is the bug.
 */
function recordingSoundCloud() {
  const writes = [];
  const clock = { teardownDone: false };
  const client = {
    followUser: jest.fn(async (id) => { writes.push({ kind: 'follow', id, afterTeardown: clock.teardownDone }); }),
    likeTrack: jest.fn(async (id) => { writes.push({ kind: 'like', id, afterTeardown: clock.teardownDone }); }),
  };
  return { client, writes, clock };
}

function startJob(userId, client, { likeTracks = false } = {}) {
  let resolveSettled;
  const settled = new Promise((resolve) => { resolveSettled = resolve; });
  const job = startEngagementJob(new GrowthEngine(client), {
    prisma: prismaMock,
    userId,
    accessToken: 'live-access-token',
    refreshToken: 'live-refresh-token',
    targets: [
      { userId: 101, likeTrackId: 9001 },
      { userId: 102, likeTrackId: 9002 },
      { userId: 103, likeTrackId: 9003 },
    ],
    likeTracks,
    sessionLabel: 'test',
    inspirationIds: [],
    inspirationNames: [],
    onSettled: resolveSettled,
  });
  return { job, settled };
}

beforeEach(() => {
  releaseSleeps();
  for (const fn of [userDelete, userUpdate, tokenDeleteMany, growthActionCreate, signOut]) fn.mockClear();
});

describe('teardown stops a running engagement job', () => {
  test('disconnectUser: no follow after the tokens are gone', async () => {
    const sc = recordingSoundCloud();
    const { job, settled } = startJob('user-disc', sc.client);

    // First follow happens, then the job waits in its pacing sleep.
    await settle();
    expect(sc.writes).toEqual([{ kind: 'follow', id: 101, afterTeardown: false }]);
    expect(pendingSleeps.length).toBe(1);

    await disconnectUser('user-disc', { accessToken: 'live-access-token' });
    sc.clock.teardownDone = true;

    await runToEnd(job, settled);

    expect(sc.writes.filter((w) => w.afterTeardown)).toEqual([]);
    expect(job.status).toBe('cancelled');
  });

  test('the revocation path (no access token) stops it too', async () => {
    const sc = recordingSoundCloud();
    const { job, settled } = startJob('user-revoked', sc.client);
    await settle();

    await disconnectUser('user-revoked', { reason: 'revoked' });
    sc.clock.teardownDone = true;

    await runToEnd(job, settled);

    expect(sc.writes.filter((w) => w.afterTeardown)).toEqual([]);
    expect(job.status).toBe('cancelled');
  });

  test('a like waiting on its pre-like sleep is not sent after disconnect', async () => {
    // With likeTracks the job sleeps between the follow and the like, so the
    // teardown can land between two writes to the SAME target.
    const sc = recordingSoundCloud();
    const { job, settled } = startJob('user-like', sc.client, { likeTracks: true });
    await settle();
    expect(sc.writes).toEqual([{ kind: 'follow', id: 101, afterTeardown: false }]);

    await disconnectUser('user-like', { accessToken: 'live-access-token' });
    sc.clock.teardownDone = true;

    await runToEnd(job, settled);

    expect(sc.writes.filter((w) => w.afterTeardown)).toEqual([]);
    expect(sc.client.likeTrack).not.toHaveBeenCalled();
  });

  test('DELETE /api/auth/account: no write after the account is gone', async () => {
    const sc = recordingSoundCloud();
    const { job, settled } = startJob('user-del', sc.client);
    await settle();
    expect(sc.writes.length).toBe(1);

    const res = await request(app).delete('/api/auth/account').send({ confirm: 'DELETE' });
    expect(res.status).toBe(200);
    expect(userDelete).toHaveBeenCalledWith({ where: { id: 'user-del' } });
    sc.clock.teardownDone = true;

    await runToEnd(job, settled);

    expect(sc.writes.filter((w) => w.afterTeardown)).toEqual([]);
    expect(job.status).toBe('cancelled');
  });

  test("another user's job keeps running", async () => {
    // The cancel is keyed: tearing one account down must not stop a bystander.
    const bystander = recordingSoundCloud();
    const { job, settled } = startJob('user-bystander', bystander.client);
    await settle();

    await disconnectUser('someone-else', { reason: 'revoked' });

    await runToEnd(job, settled);

    expect(job.status).toBe('complete');
    expect(bystander.client.followUser).toHaveBeenCalledTimes(3);
  });
});
