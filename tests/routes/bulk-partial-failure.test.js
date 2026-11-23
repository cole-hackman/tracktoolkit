import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';

const likeTrack = jest.fn();
const logOperation = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: { likeTrack },
  // routes/api.js imports this alongside soundcloudClient for the oEmbed
  // supplement; the mock must provide it or the module fails to link.
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation,
  startOperationTimer: () => () => 42,
  extractClientInfo: () => ({}),
  getAnalyticsWriteHealth: () => ({ status: 'ok' }),
  // Pass-through: read instrumentation must not alter routing behaviour.
  instrumentRead: () => (req, res, next) => next(),
}));
jest.unstable_mockModule('../../server/lib/enrichment.js', () => ({
  piggybackEnrichment: jest.fn(),
}));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = { id: 'user-a', soundcloudId: 111 };
    req.accessToken = 'at';
    req.refreshToken = 'rt';
    next();
  },
}));

const { default: apiRoutes } = await import('../../server/routes/api.js');

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);

const bulkLikeCall = () => logOperation.mock.calls.map((c) => c[0]).find((a) => a.action === 'bulk-like');

afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

beforeEach(() => {
  likeTrack.mockReset();
  logOperation.mockClear();
});

// The bulk-like route sleeps 150ms between tracks (real timers, deliberately
// not faked). Under a full parallel suite run those sleeps can slip well past
// Jest's 5s default, so every test here gets explicit headroom.
describe('bulk-like reports per-item outcomes instead of silently succeeding', () => {
  test('a partial failure is visible in the response AND in the operation log', async () => {
    likeTrack
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('403 Forbidden'))
      .mockResolvedValueOnce({});

    const res = await request(app)
      .post('/api/likes/tracks/bulk-like')
      .send({ trackIds: [1, 2, 3] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { trackId: 1, status: 'ok' },
      // fixed text: the raw message ('403 Forbidden') is not sent
      { trackId: 2, status: 'error', error: 'Like failed' },
      { trackId: 3, status: 'ok' },
    ]);

    const logged = bulkLikeCall();
    expect(logged.metadata).toEqual({ total: 3, succeeded: 2, failed: 1 });
    // only the tracks that actually landed are recorded as liked
    expect(logged.trackIds).toEqual([1, 3]);
    expect(logged.trackCount).toBe(2);
  }, 30000);

  test('an all-items-failed run is logged as an error, not a success', async () => {
    likeTrack.mockRejectedValue(new Error('429 Too Many Requests'));

    const res = await request(app)
      .post('/api/likes/tracks/bulk-like')
      .send({ trackIds: [1, 2] });

    expect(res.status).toBe(200);
    const logged = bulkLikeCall();
    expect(logged.status).toBe('error');
    expect(logged.errorCode).toBe('ALL_ITEMS_FAILED');
    expect(logged.trackCount).toBe(0);
    expect(logged.metadata).toEqual({ total: 2, succeeded: 0, failed: 2 });
  }, 30000);

  test('a fully successful run is logged as success with every track recorded', async () => {
    likeTrack.mockResolvedValue({});

    await request(app).post('/api/likes/tracks/bulk-like').send({ trackIds: [1, 2] });

    const logged = bulkLikeCall();
    expect(logged.status).toBe('success');
    expect(logged.errorCode).toBeUndefined();
    expect(logged.metadata).toEqual({ total: 2, succeeded: 2, failed: 0 });
  }, 30000);
});
