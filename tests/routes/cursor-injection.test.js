import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const scRequest = jest.fn();
const getFollowings = jest.fn();
const getUserLikedTracksPage = jest.fn();
const getUserPlaylistsPage = jest.fn();
const getUserLikedPlaylistsPage = jest.fn();
const getRelatedArtists = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: { scRequest, getFollowings, getUserLikedTracksPage, getUserPlaylistsPage, getUserLikedPlaylistsPage, getRelatedArtists },
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
}));
const realCatalog = await import('../../server/lib/catalog.js');
jest.unstable_mockModule('../../server/lib/catalog.js', () => ({ ...realCatalog, harvestTracks: jest.fn(), harvestPlaylists: jest.fn() }));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = { id: 'user-a', soundcloudId: 111 };
    req.accessToken = 'at';
    req.refreshToken = 'rt';
    next();
  },
}));

const { default: apiRoutes } = await import('../../server/routes/api.js');
const { requestCache } = await import('../../server/lib/request-cache.js');
const { harvestTracks } = await import('../../server/lib/catalog.js');

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);

afterAll(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

beforeEach(() => {
  requestCache.invalidateUser('user-a');
  for (const fn of [scRequest, getFollowings, getUserLikedTracksPage, getUserPlaylistsPage, getUserLikedPlaylistsPage, getRelatedArtists]) fn.mockReset();
  harvestTracks.mockClear();
  scRequest.mockResolvedValue({ collection: [], next_href: null });
  getFollowings.mockResolvedValue([{ id: 123, username: 'followed' }]);
  getUserLikedTracksPage.mockResolvedValue({ collection: [], next_href: null });
  getUserPlaylistsPage.mockResolvedValue({ collection: [], next_href: null });
  getUserLikedPlaylistsPage.mockResolvedValue({ collection: [], next_href: null });
  getRelatedArtists.mockResolvedValue([]);
});

const q = (next) => `?next=${encodeURIComponent(next)}`;

describe('own-collection cursors (/likes|followings|followers/paged)', () => {
  test('a genuine next_href continues the same collection', async () => {
    const res = await request(app).get(`/api/likes/paged${q('https://api.soundcloud.com/me/likes/tracks?cursor=abc&linked_partitioning=1&page_size=50')}`);
    expect(res.status).toBe(200);
    expect(scRequest).toHaveBeenCalledWith('/me/likes/tracks?cursor=abc&linked_partitioning=1&page_size=50', 'at', 'rt');
  });

  test.each([
    ['another endpoint', 'https://api.soundcloud.com/tracks/1/streams'],
    ["someone else's likes (would be harvested into the catalog)", 'https://api.soundcloud.com/users/999/likes/tracks?cursor=x'],
    ['another host', 'https://evil.example/me/likes/tracks'],
  ])('refuses %s with 400 and never calls SoundCloud', async (_label, next) => {
    const res = await request(app).get(`/api/likes/paged${q(next)}`);
    expect(res.status).toBe(400);
    expect(scRequest).not.toHaveBeenCalled();
    expect(harvestTracks).not.toHaveBeenCalled();
  });

  test('followers cannot be continued with a followings cursor', async () => {
    const res = await request(app).get(`/api/followers/paged${q('https://api.soundcloud.com/me/followings?cursor=x')}`);
    expect(res.status).toBe(400);
    expect(scRequest).not.toHaveBeenCalled();
  });
});

describe('followed-user cursors', () => {
  test('a cursor for the followed user is used', async () => {
    const next = 'https://api.soundcloud.com/users/123/likes/tracks?cursor=abc&linked_partitioning=1&page_size=50';
    const res = await request(app).get(`/api/followings/123/likes/paged${q(next)}`);
    expect(res.status).toBe(200);
    expect(getUserLikedTracksPage).toHaveBeenCalled();
  });

  test.each([
    ['likes', 'getUserLikedTracksPage', 'https://api.soundcloud.com/users/999/likes/tracks?cursor=x'],
    ['playlists', 'getUserPlaylistsPage', 'https://api.soundcloud.com/users/999/playlists?cursor=x'],
    ['liked-playlists', 'getUserLikedPlaylistsPage', 'https://api.soundcloud.com/users/999/likes/playlists?cursor=x'],
  ])("a %s cursor naming an unfollowed user is refused before anything is fetched", async (route, fetcher, next) => {
    const fetchers = { getUserLikedTracksPage, getUserPlaylistsPage, getUserLikedPlaylistsPage };
    const res = await request(app).get(`/api/followings/123/${route}/paged${q(next)}`);
    expect(res.status).toBe(400);
    expect(fetchers[fetcher]).not.toHaveBeenCalled();
  });

  test('a cursor to another endpoint is refused by the validator', async () => {
    const res = await request(app).get(`/api/followings/123/likes/paged${q('https://evil.example/x')}`);
    expect(res.status).toBe(400);
    expect(getUserLikedTracksPage).not.toHaveBeenCalled();
  });
});

describe('/users/:userUrn/related', () => {
  test.each(['123', 'soundcloud:users:123'])('accepts %s', async (urn) => {
    const res = await request(app).get(`/api/users/${encodeURIComponent(urn)}/related`);
    expect(res.status).toBe(200);
    expect(getRelatedArtists).toHaveBeenCalledWith(urn, 'at', 'rt');
  });

  test.each([
    '..%2Ftracks%2F1%2Fstreams%3F',
    '123%2F..%2F..%2Ftracks%2F1%2Fstreams',
    'abc',
    'soundcloud:tracks:1',
  ])('refuses %s with 400 and calls nothing', async (urn) => {
    const res = await request(app).get(`/api/users/${urn}/related`);
    expect(res.status).toBe(400);
    expect(getRelatedArtists).not.toHaveBeenCalled();
  });
});
