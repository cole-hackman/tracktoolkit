import { jest } from '@jest/globals';
import { Response } from 'node-fetch';

// Independent check on C6: does a cancel (disconnect / account deletion) stop a
// write that is sitting in scRequest's 429 backoff? The job checks
// `cancelRequested` only before it calls followUser/likeTrack. Once a PUT has
// been answered 429, scRequest waits Retry-After seconds (up to 3 times) and
// re-sends the same PUT with the closure's access token, with no look at the
// job. That re-send is a NEW write that starts after the teardown.

process.env.ENCRYPTION_KEY ||= 'x'.repeat(32);
process.env.SOUNDCLOUD_CLIENT_ID ||= 'cid';
process.env.SOUNDCLOUD_CLIENT_SECRET ||= 'csecret';
process.env.SOUNDCLOUD_REDIRECT_URI ||= 'http://localhost/cb';

// The job's own pacing sleeps resolve immediately; scRequest's 429 backoff is
// a raw setTimeout and stays real (Retry-After: 1 => 1 s).
jest.unstable_mockModule('../server/lib/pacing.js', () => ({
  SC_WRITE_PACING_MS: 300,
  SC_PLAYLIST_PACING_MS: 500,
  SC_BULK_PACING_MS: 150,
  SC_READ_CONCURRENCY: 5,
  mapWithConcurrency: async (items, _limit, fn) => Promise.all(items.map(fn)),
  sleep: () => Promise.resolve(),
}));

const prismaMock = {
  user: { update: jest.fn().mockResolvedValue({}) },
  token: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn(), findUnique: jest.fn() },
  growthAction: { create: jest.fn().mockResolvedValue({}) },
};
jest.unstable_mockModule('../server/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../server/lib/snapshot-cache.js', () => ({
  dropSnapshots: jest.fn().mockResolvedValue(undefined),
  readSnapshot: jest.fn(),
  writeSnapshot: jest.fn(),
  invalidateSnapshot: jest.fn().mockResolvedValue({ count: 0 }),
  SNAPSHOT_RESOURCES: ['likes', 'playlists', 'followings', 'followers', 'reposts'],
}));

const { GrowthEngine, startEngagementJob } = await import('../server/lib/growth-engine.js');
const { soundcloudClient } = await import('../server/lib/soundcloud-client.js');
const { disconnectUser } = await import('../server/lib/account-lifecycle.js');

const originalFetch = global.fetch;
afterAll(() => { global.fetch = originalFetch; });

// Regression guard, now passing. Before the fix: the follow re-sent after the 429 backoff goes out
// after disconnectUser has returned.
test('a follow waiting in 429 backoff is not re-sent after disconnect', async () => {
  const writes = [];
  const state = { teardownDone: false, putCount: 0 };
  let first429Seen;
  const saw429 = new Promise((r) => { first429Seen = r; });

  global.fetch = jest.fn(async (url, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    if (method === 'PUT') {
      state.putCount += 1;
      writes.push({ url: String(url), afterTeardown: state.teardownDone });
      if (state.putCount === 1) {
        first429Seen();
        return new Response('', { status: 429, headers: { 'Retry-After': '1' } });
      }
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });

  let settledResolve;
  const settled = new Promise((r) => { settledResolve = r; });
  const job = startEngagementJob(new GrowthEngine(soundcloudClient), {
    prisma: prismaMock,
    userId: 'user-429',
    accessToken: 'closure-access',
    refreshToken: 'closure-refresh',
    targets: [{ userId: 201 }, { userId: 202 }],
    likeTracks: false,
    sessionLabel: 't',
    inspirationIds: [],
    inspirationNames: [],
    onSettled: settledResolve,
  });

  await saw429;                                       // the PUT is now in backoff
  await disconnectUser('user-429', { reason: 'revoked' });
  state.teardownDone = true;
  await settled;

  expect(job.status).toBe('cancelled');
  expect(writes.filter((w) => w.afterTeardown)).toEqual([]);
}, 10_000);
