import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const findMany = jest.fn().mockResolvedValue([]);

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
  default: { growthAction: { findMany } },
}));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = { id: 'user-a', soundcloudId: 111 };
    req.accessToken = 'at';
    req.refreshToken = 'rt';
    next();
  },
}));

// The preload would otherwise try real SoundCloud calls (with retry backoff).
const socialCache = await import('../../server/lib/social-cache.js');
jest.unstable_mockModule('../../server/lib/social-cache.js', () => ({
  ...socialCache,
  loadCachedFollowings: jest.fn().mockResolvedValue(null),
  loadCachedFollowers: jest.fn().mockResolvedValue(null),
}));

const { GrowthEngine } =await import('../../server/lib/growth-engine.js');
const discoverSuggestions = jest
  .spyOn(GrowthEngine.prototype, 'discoverSuggestions')
  .mockResolvedValue({ suggestions: [], stats: {} });
const { default: growthRoutes } = await import('../../server/routes/growth.js');

const app = express();
app.use(express.json());
app.use('/api', growthRoutes);

afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

beforeEach(() => {
  discoverSuggestions.mockClear();
});

describe('POST /api/growth/discover genre focus', () => {
  test('passes a valid genre through to the engine', async () => {
    const res = await request(app)
      .post('/api/growth/discover')
      .send({ inspirationUserIds: [1], genre: 'house' });

    expect(res.status).toBe(200);
    expect(discoverSuggestions).toHaveBeenCalledTimes(1);
    expect(discoverSuggestions.mock.calls[0][0]).toMatchObject({ genre: 'house' });
  });

  test('an array genre is refused with 400 before reaching the engine', async () => {
    const res = await request(app)
      .post('/api/growth/discover')
      .send({ inspirationUserIds: [1], genre: ['house'] });

    expect(res.status).toBe(400);
    expect(discoverSuggestions).not.toHaveBeenCalled();
  });
});
