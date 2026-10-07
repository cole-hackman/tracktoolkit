import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const ORIGINAL = { NODE_ENV: process.env.NODE_ENV, ADMIN_IDS: process.env.ADMIN_IDS };
process.env.NODE_ENV = 'development';
process.env.ADMIN_IDS = '111';

const queryRaw = jest.fn();
let currentUser = { id: 'user-a', soundcloudId: 111 };

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: { $queryRaw: queryRaw } }));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: {},
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
}));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = currentUser;
    next();
  },
}));

const { default: apiRoutes } = await import('../../server/routes/api.js');
const app = express();
app.use(express.json());
app.use('/api', apiRoutes);

afterAll(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  currentUser = { id: 'user-a', soundcloudId: 111 };
  queryRaw.mockReset();
});

describe('GET /api/downloads/history', () => {
  test('is admin-only: anyone else gets 403 and the database is never asked', async () => {
    currentUser = { id: 'user-b', soundcloudId: 222 };
    const res = await request(app).get('/api/downloads/history');
    expect(res.status).toBe(403);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  test("reads only the caller's successful download rows and returns one entry per track", async () => {
    queryRaw.mockResolvedValue([
      { track_id: 100n, first_at: new Date('2026-10-01T10:00:00Z'), last_at: new Date('2026-10-03T09:00:00Z'), times: 2 },
      { track_id: 200n, first_at: new Date('2026-10-02T12:00:00Z'), last_at: new Date('2026-10-02T12:00:00Z'), times: 1 },
    ]);
    const res = await request(app).get('/api/downloads/history');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tracks: [
        { trackId: 100, firstAt: '2026-10-01T10:00:00.000Z', lastAt: '2026-10-03T09:00:00.000Z', times: 2 },
        { trackId: 200, firstAt: '2026-10-02T12:00:00.000Z', lastAt: '2026-10-02T12:00:00.000Z', times: 1 },
      ],
      retentionDays: 365,
    });

    // The query is scoped to the caller and to successful download actions.
    // (Checked against Postgres 17 with seeded rows when written: errors,
    // other actions, other users and non-array trackIds are all excluded.)
    const [strings, ...values] = queryRaw.mock.calls[0];
    const sql = strings.join('?');
    expect(values).toEqual(['user-a']);
    expect(sql).toMatch(/"userId" = \?/);
    expect(sql).toMatch(/action IN \('proxy-download', 'download-links'\)/);
    expect(sql).toMatch(/status IN \('success', 'partial'\)/);
    expect(sql).toMatch(/jsonb_typeof\(metadata->'trackIds'\) = 'array'/);
  });

  test('a database failure is a 500, not a crash', async () => {
    queryRaw.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/api/downloads/history');
    expect(res.status).toBe(500);
  });
});
