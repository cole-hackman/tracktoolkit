import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// POST /api/growth/reverse paces each write with SC_WRITE_PACING_MS. That
// constant was used without being imported, so the first pause threw a
// ReferenceError outside the per-action try: the first follow was undone on
// SoundCloud and every reversal request answered 500. Nothing exercised the
// route, which is how it shipped.

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const findMany = jest.fn();
const update = jest.fn().mockResolvedValue({});

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
  default: { growthAction: { findMany, update } },
}));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = { id: 'user-a', soundcloudId: 111 };
    req.accessToken = 'at';
    req.refreshToken = 'rt';
    next();
  },
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation: jest.fn(),
}));

const { soundcloudClient } = await import('../../server/lib/soundcloud-client.js');
const { default: growthRoutes } = await import('../../server/routes/growth.js');

const app = express();
app.use(express.json());
app.use('/api', growthRoutes);

afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

beforeEach(() => {
  findMany.mockReset();
  update.mockClear();
  jest.restoreAllMocks();
});

test('reverses every selected action instead of failing after the first', async () => {
  findMany.mockResolvedValue([
    { id: 'ga-1', actionType: 'follow', targetId: 501 },
    { id: 'ga-2', actionType: 'like', targetId: 902 },
  ]);
  const unfollow = jest.spyOn(soundcloudClient, 'unfollowUser').mockResolvedValue({});
  const unlike = jest.spyOn(soundcloudClient, 'unlikeTrack').mockResolvedValue({});

  const res = await request(app)
    .post('/api/growth/reverse')
    .send({ actionIds: ['ga-1', 'ga-2'] });

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ reversed: 2, failed: 0 });
  expect(unfollow).toHaveBeenCalledWith('at', 'rt', 501);
  expect(unlike).toHaveBeenCalledWith('at', 'rt', 902);
  expect(update).toHaveBeenCalledTimes(2);
});
