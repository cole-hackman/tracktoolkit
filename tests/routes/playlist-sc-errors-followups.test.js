import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Follow-up to playlist-sc-errors.test.js (#70): the same upstream conditions
 * on compare, clone, followed clone and from-likes. A vanished playlist is a
 * 404/409 the client can act on, an outage is a 502 whose wording depends on
 * whether a write may have landed, everything else stays a 500.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const getPlaylistWithTracks = jest.fn();
const addTracksToPlaylist = jest.fn();
const createPlaylist = jest.fn();
const resolveAny = jest.fn();
const resolvePublic = jest.fn();
const getFollowings = jest.fn();
const logOperation = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../server/lib/pacing.js', () => ({
  SC_WRITE_PACING_MS: 0,
  SC_PLAYLIST_PACING_MS: 0,
  SC_BULK_PACING_MS: 0,
  SC_READ_CONCURRENCY: 5,
  sleep: jest.fn(async () => {}),
  mapWithConcurrency: async (items, _l, fn) => Promise.all(items.map(fn)),
}));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: {
    getPlaylistWithTracks, addTracksToPlaylist, createPlaylist, resolveAny, resolvePublic, getFollowings,
  },
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
    req.user = { id: 'user-a', soundcloudId: 111 };
    req.accessToken = 'at';
    req.refreshToken = 'rt';
    next();
  },
}));

const actualSocialCache = await import('../../server/lib/social-cache.js');
const invalidatePlaylistState = jest.fn(actualSocialCache.invalidatePlaylistState);
jest.unstable_mockModule('../../server/lib/social-cache.js', () => ({
  ...actualSocialCache,
  invalidatePlaylistState,
}));
const { default: apiRoutes } = await import('../../server/routes/api.js');
const { requestCache } = await import('../../server/lib/request-cache.js');

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);

afterAll(() => { process.env.NODE_ENV = ORIGINAL_NODE_ENV; });

const scError = (status, extra = {}) => Object.assign(new Error(`API request failed: ${status}`), { status, ...extra });
const timeoutError = () => Object.assign(new Error('The operation was aborted.'), { code: 'SC_TIMEOUT', status: 504 });
const range = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i);
const toTracks = (ids) => ids.map((id) => ({ id, streamable: true }));
const SOURCE_URL = 'https://soundcloud.com/someone/sets/mix';

beforeEach(() => {
  requestCache.invalidateUser('user-a');
  getPlaylistWithTracks.mockReset();
  addTracksToPlaylist.mockReset().mockResolvedValue({ id: 99 });
  createPlaylist.mockReset().mockResolvedValue({ id: 99, title: 'New', permalink_url: 'https://sc/99' });
  resolveAny.mockReset().mockResolvedValue({ kind: 'playlist', id: 7 });
  resolvePublic.mockReset().mockResolvedValue({ kind: 'playlist', id: 7 });
  getFollowings.mockReset().mockResolvedValue([{ id: 999, username: 'friend' }]);
  logOperation.mockClear();
  invalidatePlaylistState.mockClear();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('POST /api/playlists/compare', () => {
  const compare = () => request(app).post('/api/playlists/compare').send({ playlistAId: 2, playlistBId: 3 });
  const playlists = (failing = {}) => getPlaylistWithTracks.mockImplementation(async (at, rt, id) => {
    if (failing[id]) throw failing[id];
    return { id, title: `P${id}`, track_count: 2, tracks: toTracks([id * 10, 5]) };
  });

  test.each([[2], [3]])('playlist %i 404s: 404 PLAYLIST_NOT_FOUND naming it, list invalidated', async (id) => {
    playlists({ [id]: scError(404) });
    const res = await compare();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PLAYLIST_NOT_FOUND');
    expect(res.body.playlistId).toBe(id);
    expect(res.body.error).toBe('One of these playlists no longer exists on SoundCloud. Your playlist list has been refreshed — pick again.');
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
  });

  test('a 502 is a 502 SOUNDCLOUD_UNAVAILABLE that does not talk about changes', async () => {
    playlists({ 2: scError(502) });
    const res = await compare();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SOUNDCLOUD_UNAVAILABLE');
    expect(res.body.error).toBe('SoundCloud is having trouble right now — try again in a minute.');
    expect(res.body.error).not.toMatch(/changes|changed/i);
  });

  test('a timeout is a 502', async () => {
    playlists({ 3: timeoutError() });
    expect((await compare()).status).toBe(502);
  });

  test('anything else stays a 500 with the existing body', async () => {
    playlists({ 2: new Error('boom') });
    const res = await compare();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to compare playlists' });
  });

  test('a 429 stays a 500', async () => {
    playlists({ 2: scError(429) });
    expect((await compare()).status).toBe(500);
  });
});

describe('POST /api/playlists/clone', () => {
  const clone = () => request(app).post('/api/playlists/clone').send({ url: SOURCE_URL });
  const source = (n = 3) => getPlaylistWithTracks.mockResolvedValue({ id: 7, title: 'Src', tracks: toTracks(range(n)) });

  test('a source-read 404 is a 404 with the old text plus a code', async () => {
    getPlaylistWithTracks.mockRejectedValue(scError(404));
    const res = await clone();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'PLAYLIST_NOT_FOUND', error: 'Source playlist not found or private.' });
    expect(createPlaylist).not.toHaveBeenCalled();
  });

  test('a resolve-step 404 (no status on the error) is still a 404 with the old text', async () => {
    resolveAny.mockRejectedValue(new Error('Resolve error: 404'));
    const res = await clone();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Source playlist not found or private.');
    expect(res.body.code).toBe('PLAYLIST_NOT_FOUND');
  });

  test('the resolve 401 fallback to the public resolver is unchanged', async () => {
    resolveAny.mockRejectedValue(new Error('Resolve error: 401'));
    source();
    const res = await clone();
    expect(resolvePublic).toHaveBeenCalledWith(SOURCE_URL);
    expect(res.status).toBe(200);
  });

  test('a 404 from the public fallback resolver is still a 404', async () => {
    resolveAny.mockRejectedValue(new Error('Resolve error: 401'));
    resolvePublic.mockRejectedValue(new Error('Resolve error: 404'));
    expect((await clone()).status).toBe(404);
  });

  test('a 404 on a PUT after the create is NOT "source not found": 500, create happened', async () => {
    source(150);
    addTracksToPlaylist.mockRejectedValue(scError(404));
    const res = await clone();
    expect(createPlaylist).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to clone playlist' });
  });

  test('a 404 on the create itself is a 500, not "source not found"', async () => {
    source();
    createPlaylist.mockRejectedValue(new Error('API request failed: 404'));
    const res = await clone();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to clone playlist');
  });

  test('a 502 reading the source says nothing was changed', async () => {
    getPlaylistWithTracks.mockRejectedValue(scError(502));
    const res = await clone();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SOUNDCLOUD_UNAVAILABLE');
    expect(res.body.error).toMatch(/nothing was changed/i);
    expect(createPlaylist).not.toHaveBeenCalled();
  });

  test('a 502 at the resolve step says nothing was changed', async () => {
    resolveAny.mockRejectedValue(new Error('Resolve error: 502'));
    const res = await clone();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/nothing was changed/i);
  });

  test('a 502 on the create says some changes may have been made', async () => {
    source();
    createPlaylist.mockRejectedValue(scError(502));
    const res = await clone();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SOUNDCLOUD_UNAVAILABLE');
    expect(res.body.error).toMatch(/some changes may have been made/i);
    expect(res.body.error).not.toMatch(/nothing was changed/i);
  });

  test('a timeout on the create says some changes may have been made', async () => {
    source();
    createPlaylist.mockRejectedValue(timeoutError());
    const res = await clone();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/some changes may have been made/i);
  });

  test('a 502 on a later PUT (single path) says some changes may have been made', async () => {
    source(250);
    addTracksToPlaylist.mockRejectedValue(scError(502));
    const res = await clone();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/some changes may have been made/i);
  });

  test('a 502 on a split-path (>500 tracks) create says some changes may have been made', async () => {
    source(600);
    createPlaylist.mockRejectedValue(scError(502));
    const res = await clone();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/some changes may have been made/i);
  });

  test('a 502 on the second split playlist says some changes may have been made', async () => {
    source(600);
    createPlaylist.mockResolvedValueOnce({ id: 98 }).mockRejectedValue(scError(502));
    const res = await clone();
    expect(createPlaylist).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/some changes may have been made/i);
  });

  test('a generic error is a 500', async () => {
    getPlaylistWithTracks.mockRejectedValue(new Error('boom'));
    const res = await clone();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to clone playlist' });
  });
});

describe('POST /api/followings/:userId/playlists/clone', () => {
  const clone = () => request(app).post('/api/followings/999/playlists/clone').send({ playlistIds: [5] });

  test('NOT_FOLLOWED is still the 403', async () => {
    getFollowings.mockResolvedValue([{ id: 222 }]);
    const res = await clone();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Choose a user you follow to clone their public playlists.');
  });

  test('an upstream 502 reaching the outer catch is a 502 saying nothing was changed', async () => {
    getFollowings.mockRejectedValue(scError(502));
    const res = await clone();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SOUNDCLOUD_UNAVAILABLE');
    expect(res.body.error).toMatch(/nothing was changed/i);
    expect(createPlaylist).not.toHaveBeenCalled();
  });

  test('a timeout in the outer path is a 502', async () => {
    getFollowings.mockRejectedValue(timeoutError());
    expect((await clone()).status).toBe(502);
  });

  test('a generic outer error is a 500', async () => {
    getFollowings.mockRejectedValue(new Error('boom'));
    const res = await clone();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to clone followed user playlists');
  });

  test('a per-item failure is still swallowed per item (400 when nothing cloned)', async () => {
    getPlaylistWithTracks.mockRejectedValue(scError(502));
    const res = await clone();
    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveLength(1);
  });
});

describe('POST /api/playlists/from-likes', () => {
  const fromLikes = (body = {}) => request(app).post('/api/playlists/from-likes').send({ title: 'Likes', trackIds: [1, 2, 3], ...body });
  const target = (ids, extra = {}) => getPlaylistWithTracks.mockResolvedValue({ id: 50, title: 'T', track_count: ids.length, tracks: toTracks(ids), ...extra });

  test('a target read 404 is a 409 PLAYLIST_NOT_FOUND naming it; nothing written, cache invalidated', async () => {
    getPlaylistWithTracks.mockRejectedValue(scError(404));
    const res = await fromLikes({ targetPlaylistId: 50 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: 'PLAYLIST_NOT_FOUND',
      playlistId: 50,
      error: 'The playlist you chose no longer exists on SoundCloud. Your playlist list has been refreshed — pick again. Nothing was changed.',
    });
    expect(addTracksToPlaylist).not.toHaveBeenCalled();
    expect(createPlaylist).not.toHaveBeenCalled();
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
  });

  test('a 502 on the target read says nothing was changed', async () => {
    getPlaylistWithTracks.mockRejectedValue(scError(502));
    const res = await fromLikes({ targetPlaylistId: 50 });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SOUNDCLOUD_UNAVAILABLE');
    expect(res.body.error).toMatch(/nothing was changed/i);
    expect(addTracksToPlaylist).not.toHaveBeenCalled();
  });

  test('a 502 on a fresh create says some changes may have been made', async () => {
    createPlaylist.mockRejectedValue(scError(502));
    const res = await fromLikes();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SOUNDCLOUD_UNAVAILABLE');
    expect(res.body.error).toMatch(/some changes may have been made/i);
    expect(res.body.error).not.toMatch(/nothing was changed/i);
  });

  test('a timeout on a fresh create says some changes may have been made', async () => {
    createPlaylist.mockRejectedValue(timeoutError());
    const res = await fromLikes();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/some changes may have been made/i);
  });

  test('a 502 on a split (>500) create says some changes may have been made', async () => {
    createPlaylist.mockRejectedValue(scError(502));
    const res = await fromLikes({ trackIds: range(600) });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/some changes may have been made/i);
  });

  test('a 502 on the PUT to an existing target says some changes may have been made', async () => {
    target([100]);
    addTracksToPlaylist.mockRejectedValue(scError(502));
    const res = await fromLikes({ targetPlaylistId: 50 });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/some changes may have been made/i);
  });

  test('a 502 on the overflow create says some changes may have been made', async () => {
    target(range(450, 1000));
    createPlaylist.mockRejectedValue(scError(502));
    const res = await fromLikes({ targetPlaylistId: 50, trackIds: range(100, 2000) });
    expect(createPlaylist).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/some changes may have been made/i);
  });

  test('a 404 on a write is not "playlist gone": stays 500', async () => {
    target([100]);
    addTracksToPlaylist.mockRejectedValue(scError(404));
    const res = await fromLikes({ targetPlaylistId: 50 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to create playlist from likes' });
  });

  test('a 404 on a fresh create stays 500', async () => {
    createPlaylist.mockRejectedValue(scError(404));
    expect((await fromLikes()).status).toBe(500);
  });

  test('the short-read 409 is unchanged', async () => {
    target([1], { track_count: 3 });
    const res = await fromLikes({ targetPlaylistId: 50 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only 1 of the 3 tracks/);
    expect(res.body.code).toBeUndefined();
  });

  test('the too-large 409 is unchanged', async () => {
    target(range(501, 1000), { track_count: 501 });
    const res = await fromLikes({ targetPlaylistId: 50 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBeUndefined();
    expect(addTracksToPlaylist).not.toHaveBeenCalled();
  });

  test('a generic error is a 500', async () => {
    createPlaylist.mockRejectedValue(new Error('boom'));
    const res = await fromLikes();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to create playlist from likes' });
  });
});
