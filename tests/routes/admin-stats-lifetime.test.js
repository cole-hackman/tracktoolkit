import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * The README badges and the admin console's all-time tiles must show one
 * number. They disagreed (3,425 / 3,139,340 against 4,736 / 3,133,985)
 * because each computed its own: the badge read the retention job's running
 * totals, the dashboard counted live rows. Now both read the same two
 * `metrics` rows, and this file is what fails if one of them stops.
 */
const metricFindMany = jest.fn();
const userCount = jest.fn();
const aggregate = jest.fn();
const queryRaw = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
  default: {
    metric: { findMany: metricFindMany },
    user: { count: userCount },
    operationLog: { aggregate, groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    $queryRaw: queryRaw,
  },
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation: jest.fn(),
  getAnalyticsWriteHealth: () => ({ failures: 0 }),
}));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = { id: 'admin-1', soundcloudId: 111 };
    next();
  },
}));

const { default: adminRoutes } = await import('../../server/routes/admin.js');
const { default: statsRoutes } = await import('../../server/routes/stats.js');
const { USERS_METRIC_KEY, TRACKS_METRIC_KEY } = await import('../../server/lib/retention.js');

const app = express();
app.use('/api/admin', adminRoutes);
app.use('/api/stats', statsRoutes);

const ORIGINAL_ADMIN_IDS = process.env.ADMIN_IDS;
const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

const METRICS = [
  { key: USERS_METRIC_KEY, value: 4736n, updatedAt: new Date('2026-11-10T19:22:00Z') },
  { key: TRACKS_METRIC_KEY, value: 3139340n, updatedAt: new Date('2026-11-10T19:22:00Z') },
];

beforeEach(() => {
  process.env.ADMIN_IDS = '111';
  metricFindMany.mockReset().mockResolvedValue(METRICS);
  // What a live count and a live sum say: fewer accounts and fewer tracks,
  // because the deleted accounts' rows are gone.
  userCount.mockReset().mockResolvedValue(4100);
  aggregate.mockReset().mockResolvedValue({
    _count: { id: 10 },
    _sum: { trackCount: 3133985 },
    _avg: { trackCount: 5, durationMs: 100 },
  });
  queryRaw.mockReset().mockResolvedValue([]);
  errorSpy.mockClear();
});
afterAll(() => {
  errorSpy.mockRestore();
  if (ORIGINAL_ADMIN_IDS === undefined) delete process.env.ADMIN_IDS;
  else process.env.ADMIN_IDS = ORIGINAL_ADMIN_IDS;
});

describe('GET /api/admin/stats all-time figures', () => {
  test('all-time users and tracks are exactly what the public badges serve', async () => {
    const admin = await request(app).get('/api/admin/stats?period=all');
    const publicStats = await request(app).get('/api/stats/public');

    expect(admin.status).toBe(200);
    expect(admin.body.totalUsers).toBe(publicStats.body.lifetimeUsers);
    expect(admin.body.tracksProcessed).toBe(publicStats.body.tracksProcessed);
    expect(admin.body.totalUsers).toBe(4736);
    expect(admin.body.tracksProcessed).toBe(3139340);
  });

  test('the users figure does not depend on the period', async () => {
    const res = await request(app).get('/api/admin/stats?period=7d');
    expect(res.body.totalUsers).toBe(4736);
    expect(res.body.lifetimeUsers).toBe(4736);
  });

  test('a bounded period still sums its own live rows for tracks', async () => {
    const res = await request(app).get('/api/admin/stats?period=30d');
    expect(res.body.tracksProcessed).toBe(3133985);
  });

  test('before the retention job has run, both fall back to the live figures', async () => {
    metricFindMany.mockResolvedValue([]);

    const res = await request(app).get('/api/admin/stats?period=all');

    expect(res.status).toBe(200);
    expect(res.body.totalUsers).toBe(4100);
    expect(res.body.lifetimeUsers).toBeNull();
    expect(res.body.tracksProcessed).toBe(3133985);
  });

  test('a missing metrics table does not 500 the dashboard', async () => {
    metricFindMany.mockRejectedValue(new Error('relation "metrics" does not exist'));

    const res = await request(app).get('/api/admin/stats?period=all');

    expect(res.status).toBe(200);
    expect(res.body.totalUsers).toBe(4100);
  });
});
