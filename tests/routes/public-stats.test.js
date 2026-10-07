import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const findMany = jest.fn();
jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
  default: { metric: { findMany } },
}));

const { default: statsRoutes } = await import('../../server/routes/stats.js');
const { LIFETIME_METRIC_KEY, TRACKS_METRIC_KEY } = await import('../../server/lib/retention.js');

const app = express();
app.use('/api/stats', statsRoutes);

const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
afterAll(() => errorSpy.mockRestore());

beforeEach(() => {
  findMany.mockReset();
  errorSpy.mockClear();
});

describe('GET /api/stats/public', () => {
  test('serves both counters from the metrics table, raw and grouped', async () => {
    findMany.mockResolvedValue([
      { key: LIFETIME_METRIC_KEY, value: 3570n, updatedAt: new Date('2026-10-06T12:10:00Z') },
      { key: TRACKS_METRIC_KEY, value: 2032233n, updatedAt: new Date('2026-10-06T12:10:01Z') },
    ]);

    const res = await request(app).get('/api/stats/public');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      lifetimeUsers: 3570,
      tracksProcessed: 2032233,
      updatedAt: '2026-10-06T12:10:01.000Z',
      formatted: { lifetimeUsers: '3,570', tracksProcessed: '2,032,233' },
    });
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
  });

  test('reads only the two public keys — never the tracks cursor or anything else', async () => {
    findMany.mockResolvedValue([]);
    await request(app).get('/api/stats/public');

    expect(findMany).toHaveBeenCalledWith({
      where: { key: { in: [LIFETIME_METRIC_KEY, TRACKS_METRIC_KEY] } },
    });
  });

  test('needs no session', async () => {
    // The router is mounted bare here, with no auth middleware in front of it;
    // a 200 with no cookie is the contract the README badges depend on.
    findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/stats/public');
    expect(res.status).toBe(200);
  });

  test('a counter the retention job has not written yet is null, not 0', async () => {
    findMany.mockResolvedValue([
      { key: LIFETIME_METRIC_KEY, value: 12n, updatedAt: new Date('2026-10-06T12:10:00Z') },
    ]);

    const res = await request(app).get('/api/stats/public');

    expect(res.body.tracksProcessed).toBeNull();
    expect(res.body.formatted.tracksProcessed).toBe('n/a');
    expect(res.body.lifetimeUsers).toBe(12);
  });

  test('a database failure is a 503 that is not cached', async () => {
    findMany.mockRejectedValue(new Error('connection refused'));

    const res = await request(app).get('/api/stats/public');

    expect(res.status).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ error: 'Stats unavailable' });
  });
});
