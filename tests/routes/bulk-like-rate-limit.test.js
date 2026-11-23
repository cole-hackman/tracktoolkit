import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Incident 2026-09-22: once SoundCloud started answering the like POSTs with
// 429, each 100-track batch kept going — three retries per track — for ~460s
// and liked nothing, and one user had eight of those running at once. These
// tests pin the two guards: stop the batch on the first exhausted 429, and
// allow one bulk-like per user at a time.

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';

const likeTrack = jest.fn();
const logOperation = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: { likeTrack },
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

const rateLimited = () => Object.assign(new Error('API request failed: 429'), { status: 429 });
const bulkLikeCall = () => logOperation.mock.calls.map((c) => c[0]).find((a) => a.action === 'bulk-like');

afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

beforeEach(() => {
  likeTrack.mockReset();
  logOperation.mockClear();
});

describe('bulk-like stops at SoundCloud\'s rate limit', () => {
  test('the first exhausted 429 ends the batch; the rest are skipped, not attempted', async () => {
    likeTrack
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(rateLimited());

    const res = await request(app)
      .post('/api/likes/tracks/bulk-like')
      .send({ trackIds: [1, 2, 3, 4] });

    expect(res.status).toBe(200);
    expect(likeTrack).toHaveBeenCalledTimes(2);
    expect(res.body.rateLimited).toBe(true);
    expect(res.body.results).toEqual([
      { trackId: 1, status: 'ok' },
      { trackId: 2, status: 'error', error: 'API request failed: 429' },
      { trackId: 3, status: 'skipped' },
      { trackId: 4, status: 'skipped' },
    ]);

    const logged = bulkLikeCall();
    expect(logged.status).toBe('success');
    expect(logged.metadata).toEqual({ total: 4, succeeded: 1, failed: 1, skipped: 2, rateLimited: true });
  }, 30000);

  test('a batch that is rate-limited from the first track is logged as RATE_LIMITED', async () => {
    likeTrack.mockRejectedValue(rateLimited());

    const res = await request(app)
      .post('/api/likes/tracks/bulk-like')
      .send({ trackIds: [1, 2, 3] });

    expect(res.status).toBe(200);
    expect(likeTrack).toHaveBeenCalledTimes(1);
    expect(res.body.rateLimited).toBe(true);

    const logged = bulkLikeCall();
    expect(logged.status).toBe('error');
    expect(logged.errorCode).toBe('RATE_LIMITED');
    expect(logged.metadata).toMatchObject({ succeeded: 0, failed: 1, skipped: 2 });
  }, 30000);

  test('a non-429 failure does not stop the batch', async () => {
    likeTrack
      .mockRejectedValueOnce(Object.assign(new Error('API request failed: 404'), { status: 404 }))
      .mockResolvedValueOnce({});

    const res = await request(app)
      .post('/api/likes/tracks/bulk-like')
      .send({ trackIds: [1, 2] });

    expect(likeTrack).toHaveBeenCalledTimes(2);
    expect(res.body.rateLimited).toBe(false);
    expect(res.body.results.map((r) => r.status)).toEqual(['error', 'ok']);
  }, 30000);
});

describe('one bulk-like at a time per user', () => {
  test('a second request while the first is running gets 409 and likes nothing', async () => {
    let release;
    likeTrack.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

    const first = request(app).post('/api/likes/tracks/bulk-like').send({ trackIds: [1] }).then((r) => r);
    // Wait until the first request is inside its loop.
    while (likeTrack.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 5));

    const second = await request(app).post('/api/likes/tracks/bulk-like').send({ trackIds: [2] });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already running/i);
    expect(likeTrack).toHaveBeenCalledTimes(1);

    release({});
    expect((await first).status).toBe(200);
  }, 30000);

  test('the lock is per user — another account is not blocked', async () => {
    let release;
    likeTrack
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValueOnce({});

    const first = request(app).post('/api/likes/tracks/bulk-like').send({ trackIds: [1] }).then((r) => r);
    while (likeTrack.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 5));

    const other = await request(app)
      .post('/api/likes/tracks/bulk-like')
      .set('x-test-user', 'user-b')
      .send({ trackIds: [2] });
    expect(other.status).toBe(200);

    release({});
    await first;
  }, 30000);

  test('the lock is released when the run finishes, including after a throw', async () => {
    likeTrack.mockResolvedValueOnce({});
    expect((await request(app).post('/api/likes/tracks/bulk-like').send({ trackIds: [1] })).status).toBe(200);

    // logOperation runs after the response is sent; its throwing drops the
    // handler into its catch path, which must still release the lock.
    logOperation.mockImplementationOnce(() => { throw new Error('boom'); });
    likeTrack.mockResolvedValueOnce({});
    expect((await request(app).post('/api/likes/tracks/bulk-like').send({ trackIds: [1] })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    likeTrack.mockResolvedValueOnce({});
    expect((await request(app).post('/api/likes/tracks/bulk-like').send({ trackIds: [1] })).status).toBe(200);
  }, 30000);

  test('a client that disconnects stops the run instead of leaving it working unseen', async () => {
    // 127.0.0.1, not the wildcard default: see tests/setup-loopback.js.
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    let calls = 0;
    likeTrack.mockImplementation(async () => { calls += 1; await new Promise((r) => setTimeout(r, 50)); return {}; });

    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/api/likes/tracks/bulk-like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackIds: Array.from({ length: 50 }, (_, i) => i + 1) }),
      signal: controller.signal,
    }).catch(() => null);

    while (calls < 2) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await pending;

    // Give the loop time to notice and finish the in-flight track.
    await new Promise((r) => setTimeout(r, 600));
    const callsAtStop = calls;
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(callsAtStop);
    expect(calls).toBeLessThan(50);

    const logged = bulkLikeCall();
    expect(logged.metadata).toMatchObject({ clientDisconnected: true });
    server.close();
  }, 30000);
});
