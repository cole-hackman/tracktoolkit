import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// operation_logs, 2026-11-09..16: seven 100-track unlike runs spent 5-7.7
// minutes each retrying 429s and removed nothing, and one account ran the same
// unlike twice at once, so the second copy got 404 for every track and was
// reported as a failure. These pin the guards on both DELETE loops: stop at
// the first exhausted 429, count a 404 as already done, one run per user.

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';

const unlikeTrack = jest.fn();
const unfollowUser = jest.fn();
const logOperation = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: { unlikeTrack, unfollowUser },
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation,
  startOperationTimer: () => () => 42,
  extractClientInfo: () => ({}),
  getAnalyticsWriteHealth: () => ({ status: 'ok' }),
  instrumentRead: () => (req, res, next) => next(),
}));
jest.unstable_mockModule('../../server/lib/enrichment.js', () => ({
  piggybackEnrichment: jest.fn(),
}));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = { id: req.get('x-test-user') || 'user-a', soundcloudId: 111 };
    req.accessToken = 'at';
    req.refreshToken = 'rt';
    next();
  },
}));

const { default: apiRoutes } = await import('../../server/routes/api.js');

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);

const scError = (status) => Object.assign(new Error(`API request failed: ${status}`), { status });
const logged = (action) => logOperation.mock.calls.map((c) => c[0]).find((a) => a.action === action);

const ROUTES = [
  { name: 'bulk-unlike', path: '/api/likes/tracks/bulk-unlike', body: (ids) => ({ trackIds: ids }), idKey: 'trackId', fn: unlikeTrack },
  { name: 'bulk-unfollow', path: '/api/followings/bulk-unfollow', body: (ids) => ({ userIds: ids }), idKey: 'userId', fn: unfollowUser },
];

afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

beforeEach(() => {
  unlikeTrack.mockReset();
  unfollowUser.mockReset();
  logOperation.mockClear();
});

describe.each(ROUTES)('$name', ({ name, path, body, idKey, fn }) => {
  test('the first exhausted 429 ends the batch; the rest are skipped, not attempted', async () => {
    fn.mockResolvedValueOnce({}).mockRejectedValueOnce(scError(429));

    const res = await request(app).post(path).send(body([1, 2, 3, 4]));

    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(res.body.rateLimited).toBe(true);
    expect(res.body.results).toEqual([
      { [idKey]: 1, status: 'ok' },
      { [idKey]: 2, status: 'error', error: 'API request failed: 429' },
      { [idKey]: 3, status: 'skipped' },
      { [idKey]: 4, status: 'skipped' },
    ]);
    expect(logged(name).metadata).toEqual({ total: 4, succeeded: 1, failed: 1, skipped: 2, rateLimited: true });
  });

  test('rate-limited from the first item is logged as RATE_LIMITED', async () => {
    fn.mockRejectedValue(scError(429));

    const res = await request(app).post(path).send(body([1, 2, 3]));

    expect(fn).toHaveBeenCalledTimes(1);
    expect(res.body.rateLimited).toBe(true);
    expect(logged(name).status).toBe('error');
    expect(logged(name).errorCode).toBe('RATE_LIMITED');
  });

  test('a 404 counts as already done, not as a failure', async () => {
    fn.mockRejectedValueOnce(scError(404)).mockResolvedValueOnce({});

    const res = await request(app).post(path).send(body([1, 2]));

    expect(res.body.rateLimited).toBe(false);
    expect(res.body.results).toEqual([
      { [idKey]: 1, status: 'ok', alreadyGone: true },
      { [idKey]: 2, status: 'ok' },
    ]);
    const entry = logged(name);
    expect(entry.status).toBe('success');
    expect(entry.metadata).toEqual({ total: 2, succeeded: 2, failed: 0, alreadyGone: 1 });
  });

  test('another error is reported but does not stop the batch', async () => {
    fn.mockRejectedValueOnce(scError(422)).mockResolvedValueOnce({});

    const res = await request(app).post(path).send(body([1, 2]));

    expect(fn).toHaveBeenCalledTimes(2);
    expect(res.body.results.map((r) => r.status)).toEqual(['error', 'ok']);
  });

  test('a second run for the same user gets 409; another user is not blocked', async () => {
    let release;
    fn.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValueOnce({});

    const first = request(app).post(path).send(body([1])).then((r) => r);
    while (fn.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 5));

    const second = await request(app).post(path).send(body([2]));
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already running/i);

    const other = await request(app).post(path).set('x-test-user', 'user-b').send(body([3]));
    expect(other.status).toBe(200);

    release({});
    expect((await first).status).toBe(200);
    // The lock is released once the run ends.
    fn.mockResolvedValueOnce({});
    expect((await request(app).post(path).send(body([4]))).status).toBe(200);
  });
});
