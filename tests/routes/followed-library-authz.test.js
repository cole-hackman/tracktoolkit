import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const getFollowings = jest.fn();
const getUserLikedTracksPage = jest.fn();
const getUserPlaylistsPage = jest.fn();
const getUserLikedPlaylistsPage = jest.fn();
const getUserLikedTracks = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: {
    getFollowings,
    getUserLikedTracksPage,
    getUserPlaylistsPage,
    getUserLikedPlaylistsPage,
    getUserLikedTracks,
  },
  // routes/api.js imports this alongside soundcloudClient for the oEmbed
  // supplement; the mock must provide it or the module fails to link.
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
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
// Not mocked: the authorization check reads the real per-user cache, so each
// test has to start from a cold one or it inherits the previous test's answer.
const { requestCache } = await import('../../server/lib/request-cache.js');

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);

const PAGED_ROUTES = [
  ['/api/followings/999/likes/paged', 'getUserLikedTracksPage'],
  ['/api/followings/999/playlists/paged', 'getUserPlaylistsPage'],
  ['/api/followings/999/liked-playlists/paged', 'getUserLikedPlaylistsPage'],
];

beforeEach(() => {
  requestCache.invalidateUser('user-a');
  getFollowings.mockClear();
  getUserLikedTracksPage.mockClear().mockResolvedValue({ collection: [], next_href: null });
  getUserPlaylistsPage.mockClear().mockResolvedValue({ collection: [], next_href: null });
  getUserLikedPlaylistsPage.mockClear().mockResolvedValue({ collection: [], next_href: null });
});

afterAll(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

const clients = { getUserLikedTracksPage, getUserPlaylistsPage, getUserLikedPlaylistsPage };

describe('followed-user library pages are gated on an actual following edge', () => {
  test.each(PAGED_ROUTES)(
    '%s returns 403 and never calls SoundCloud when the target is not followed',
    async (route, clientMethod) => {
      getFollowings.mockResolvedValue([{ id: 222 }, { id: 333 }]); // 999 absent
      const res = await request(app).get(route);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/user you follow/i);
      // the authorization check runs BEFORE any data fetch
      expect(clients[clientMethod]).not.toHaveBeenCalled();
    }
  );

  test.each(PAGED_ROUTES)(
    '%s returns 200 when the target IS followed',
    async (route, clientMethod) => {
      getFollowings.mockResolvedValue([{ id: 999, username: 'friend' }]);
      const res = await request(app).get(route);

      expect(res.status).toBe(200);
      expect(clients[clientMethod]).toHaveBeenCalledTimes(1);
      expect(res.body.user).toMatchObject({ id: 999 });
    }
  );

  test('an empty followings list authorizes nobody', async () => {
    getFollowings.mockResolvedValue([]);
    const res = await request(app).get('/api/followings/999/likes/paged');
    expect(res.status).toBe(403);
  });

  test('a string/number id mismatch still authorizes correctly (Number() coercion)', async () => {
    getFollowings.mockResolvedValue([{ id: '999', username: 'friend' }]);
    const res = await request(app).get('/api/followings/999/likes/paged');
    expect(res.status).toBe(200);
  });

  test('the followings list is fetched once and reused across page requests', async () => {
    // The reason this check is cached at all: it runs before every page fetch,
    // and an uncached crawl costs ceil(followings/200) SoundCloud calls to
    // authorize a request that returns 50 items.
    getFollowings.mockResolvedValue([{ id: 999, username: 'friend' }]);

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).get('/api/followings/999/likes/paged');
      expect(res.status).toBe(200);
    }

    expect(getFollowings).toHaveBeenCalledTimes(1);
    expect(getUserLikedTracksPage).toHaveBeenCalledTimes(3);
  });

  test('invalidating the followings cache re-checks against SoundCloud', async () => {
    // Bulk-unfollow and growth-reverse both call invalidateUserNamespaces with
    // 'followings'; this asserts that revoking access actually takes effect
    // rather than waiting out the TTL.
    getFollowings.mockResolvedValue([{ id: 999, username: 'friend' }]);
    expect((await request(app).get('/api/followings/999/likes/paged')).status).toBe(200);

    requestCache.invalidateUser('user-a');
    getFollowings.mockResolvedValue([]); // unfollowed

    expect((await request(app).get('/api/followings/999/likes/paged')).status).toBe(403);
    expect(getFollowings).toHaveBeenCalledTimes(2);
  });

  // Every upstream SoundCloud failure now carries `status`, so a real upstream
  // 403 (private likes, say) must not be mistaken for "you don't follow this
  // user". Only assertFollowedUser's own NOT_FOLLOWED code means that.
  test.each(PAGED_ROUTES)(
    '%s: an upstream 403 for a FOLLOWED user is a 500, not the not-followed 403',
    async (route, clientMethod) => {
      getFollowings.mockResolvedValue([{ id: 999, username: 'friend' }]);
      clients[clientMethod].mockRejectedValue(
        Object.assign(new Error('API request failed: 403'), { status: 403 }),
      );
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(app).get(route);

      expect(res.status).toBe(500);
      expect(res.body.error).not.toMatch(/user you follow/i);
    }
  );

  test('create-from-likes: an upstream 403 for a followed user is a 500 with the failure body', async () => {
    getFollowings.mockResolvedValue([{ id: 999, username: 'friend' }]);
    getUserLikedTracks.mockRejectedValue(
      Object.assign(new Error('API request failed: 403'), { status: 403 }),
    );
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)
      .post('/api/followings/999/likes/playlist')
      .send({ mode: 'all', title: 'Their likes' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to create playlist from followed user likes');
  });

  test('create-from-likes: a genuinely unfollowed user is still the 403', async () => {
    getFollowings.mockResolvedValue([{ id: 222 }]);
    const res = await request(app)
      .post('/api/followings/999/likes/playlist')
      .send({ mode: 'all', title: 'Their likes' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Choose a user you follow to create from their public likes.');
  });

  test('clone-followed: a genuinely unfollowed user is still the 403', async () => {
    getFollowings.mockResolvedValue([{ id: 222 }]);
    const res = await request(app)
      .post('/api/followings/999/playlists/clone')
      .send({ playlistIds: [5] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Choose a user you follow to clone their public playlists.');
  });

  test('clone-followed: an upstream 403 (here, while loading followings) is a 500 with the failure body', async () => {
    getFollowings.mockRejectedValue(
      Object.assign(new Error('API request failed: 403'), { status: 403 }),
    );
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)
      .post('/api/followings/999/playlists/clone')
      .send({ playlistIds: [5] });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to clone followed user playlists');
  });
});
