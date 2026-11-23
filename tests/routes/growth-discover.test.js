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

const { GrowthEngine } = await import('../../server/lib/growth-engine.js');
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

describe('POST /api/growth/discover inspirationUserIds', () => {
  // The ids are interpolated into /users/${id}/followers and friends. A lax
  // parseInt check let the leading digits vouch for the rest of the string.
  test('a path-traversal id is refused with 400 before reaching the engine', async () => {
    const res = await request(app)
      .post('/api/growth/discover')
      .send({ inspirationUserIds: ['2/../../me/followings/777?'] });

    expect(res.status).toBe(400);
    expect(discoverSuggestions).not.toHaveBeenCalled();
  });

  test.each([
    ['a leading-zero id', '02'],
    ['zero', 0],
    ['an array', [2]],
    ['a decimal', '2.5'],
  ])('%s is refused with 400', async (_name, bad) => {
    const res = await request(app)
      .post('/api/growth/discover')
      .send({ inspirationUserIds: [bad] });

    expect(res.status).toBe(400);
    expect(discoverSuggestions).not.toHaveBeenCalled();
  });

  test('numeric strings still work and reach the engine as numbers', async () => {
    const res = await request(app)
      .post('/api/growth/discover')
      .send({ inspirationUserIds: ['5', 6] });

    expect(res.status).toBe(200);
    expect(discoverSuggestions.mock.calls[0][0].inspirationUserIds).toEqual([5, 6]);
  });

  test('the 1-5 length limit is unchanged', async () => {
    const empty = await request(app).post('/api/growth/discover').send({ inspirationUserIds: [] });
    const six = await request(app).post('/api/growth/discover').send({ inspirationUserIds: [1, 2, 3, 4, 5, 6] });

    expect(empty.status).toBe(400);
    expect(six.status).toBe(400);
    expect(discoverSuggestions).not.toHaveBeenCalled();
  });
});
