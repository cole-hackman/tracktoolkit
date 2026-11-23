import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Playlist ids in a request body reach SoundCloud paths
 * (`/playlists/${id}`, including a DELETE), so they must be whole positive
 * integers, nothing else.
 *
 * Two holes this pins shut:
 * - `sourcePlaylistIds` were checked with `parseInt`, which reads the leading
 *   digits and ignores the rest, so `"2/../../me/followings/777?"` passed and
 *   was interpolated into the path raw.
 * - `targetPlaylistId` used `.isInt()`, which express-validator applies
 *   element-wise to an array, so `[1]` passed. The merge's "never delete the
 *   target" filter compares with `!==`, which an array never equals, so with
 *   `deleteAfterMerge` the target was deleted.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const getPlaylistWithTracks = jest.fn();
const addTracksToPlaylist = jest.fn();
const getFollowings = jest.fn();
const getUserLikedTracks = jest.fn();
const createPlaylist = jest.fn();
const deletePlaylist = jest.fn();

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
    getPlaylistWithTracks, addTracksToPlaylist, getFollowings, getUserLikedTracks, createPlaylist, deletePlaylist,
  },
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation: jest.fn(),
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

const { default: apiRoutes } = await import('../../server/routes/api.js');
const { requestCache } = await import('../../server/lib/request-cache.js');

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);

afterAll(() => { process.env.NODE_ENV = ORIGINAL_NODE_ENV; });

const TRAVERSAL = '2/../../me/followings/777?';
const toTracks = (ids) => ids.map((id) => ({ id, streamable: true }));

beforeEach(() => {
  requestCache.invalidateUser('user-a');
  getPlaylistWithTracks.mockReset().mockImplementation(async (at, rt, id) => ({
    id, title: `pl ${id}`, track_count: 1, tracks: toTracks([Number(id) * 100]),
  }));
  addTracksToPlaylist.mockReset().mockResolvedValue({ id: 1, title: 'ok' });
  getFollowings.mockReset().mockResolvedValue([{ id: 77, username: 'friend' }]);
  getUserLikedTracks.mockReset().mockResolvedValue(toTracks([5, 6]));
  createPlaylist.mockReset().mockResolvedValue({ id: 99, permalink_url: 'x' });
  deletePlaylist.mockReset().mockResolvedValue({});
});

/** No SoundCloud call of any kind was made. */
function expectNoUpstreamCall() {
  expect(getPlaylistWithTracks).not.toHaveBeenCalled();
  expect(addTracksToPlaylist).not.toHaveBeenCalled();
  expect(createPlaylist).not.toHaveBeenCalled();
  expect(deletePlaylist).not.toHaveBeenCalled();
}

describe('POST /api/playlists/merge — sourcePlaylistIds', () => {
  test('a path-traversal source id is refused with 400 before any SoundCloud call', async () => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: [TRAVERSAL, 3], title: 'Merged' });

    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test.each([
    ['a leading-zero id', '02'],
    ['a decimal', '2.5'],
    ['zero', 0],
    ['a negative id', -2],
    ['an unsafe integer', '9007199254740993'],
    ['an array', [2]],
    ['an object', { id: 2 }],
  ])('%s is refused with 400', async (_name, bad) => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: [bad, 3], title: 'Merged' });

    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test('numeric strings still work and reach the client as numbers', async () => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: ['2', '3'], title: 'Merged' });

    expect(res.status).toBe(200);
    const readIds = getPlaylistWithTracks.mock.calls.slice(0, 2).map((c) => c[2]);
    expect(readIds).toEqual([2, 3]);
  });

  test('the array length limits are unchanged', async () => {
    const one = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: [2], title: 'Merged' });
    const tooMany = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: Array.from({ length: 21 }, (_, i) => i + 2), title: 'Merged' });

    expect(one.status).toBe(400);
    expect(tooMany.status).toBe(400);
    expectNoUpstreamCall();
  });
});

describe('POST /api/playlists/merge — targetPlaylistId', () => {
  test('an array target is refused with 400, so deleteAfterMerge cannot reach the target', async () => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: [1, 2], targetPlaylistId: [1], deleteAfterMerge: true });

    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test('a numeric-string source equal to a numeric target is refused', async () => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: ['1', 2], targetPlaylistId: 1, deleteAfterMerge: true });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/must not be one of the sourcePlaylistIds/);
    expectNoUpstreamCall();
  });

  test('a numeric source equal to a numeric-string target is refused', async () => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: [1, 2], targetPlaylistId: '1', deleteAfterMerge: true });

    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test('deleteAfterMerge with string ids deletes the sources as numbers and never the target', async () => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: ['2', '3'], targetPlaylistId: '1', deleteAfterMerge: true });

    expect(res.status).toBe(200);
    expect(deletePlaylist.mock.calls.map((c) => c[2])).toEqual([2, 3]);
    expect(addTracksToPlaylist.mock.calls.every((c) => c[2] === 1)).toBe(true);
  });
});

describe('targetPlaylistId is checked as a whole value on the other appenders', () => {
  test('from-likes refuses an array target with 400', async () => {
    const res = await request(app).post('/api/playlists/from-likes')
      .send({ trackIds: [5, 6], targetPlaylistId: [1] });

    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test('followed-likes refuses an array target with 400', async () => {
    const res = await request(app).post('/api/followings/77/likes/playlist')
      .send({ mode: 'all', targetPlaylistId: [1] });

    expect(res.status).toBe(400);
    expectNoUpstreamCall();
    expect(getUserLikedTracks).not.toHaveBeenCalled();
  });

  test('from-likes still accepts a numeric-string target', async () => {
    getPlaylistWithTracks.mockImplementation(async (at, rt, id) => ({ id, title: 't', track_count: 0, tracks: [] }));
    const res = await request(app).post('/api/playlists/from-likes')
      .send({ trackIds: [5, 6], targetPlaylistId: '1' });

    expect(res.status).toBe(200);
    expect(getPlaylistWithTracks.mock.calls[0][2]).toBe(1);
  });

  test('followed-likes still accepts a numeric-string target', async () => {
    getPlaylistWithTracks.mockImplementation(async (at, rt, id) => ({ id, title: 't', track_count: 0, tracks: [] }));
    const res = await request(app).post('/api/followings/77/likes/playlist')
      .send({ mode: 'all', targetPlaylistId: '1' });

    expect(res.status).toBe(200);
    expect(getPlaylistWithTracks.mock.calls[0][2]).toBe(1);
  });
});

describe('targetPlaylistId is a whole value on bulk-add and transfer-track too', () => {
  const emptyTarget = async (at, rt, id) => ({ id, title: 't', track_count: 0, tracks: [] });

  test('bulk-add refuses an array target with 400', async () => {
    const res = await request(app).post('/api/playlists/tracks/bulk-add')
      .send({ targetPlaylistId: [1], trackIds: [5] });

    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test('bulk-add still accepts a numeric-string target', async () => {
    getPlaylistWithTracks.mockImplementation(emptyTarget);
    const res = await request(app).post('/api/playlists/tracks/bulk-add')
      .send({ targetPlaylistId: '1', trackIds: [5] });

    expect(res.status).toBe(200);
    expect(getPlaylistWithTracks.mock.calls[0][2]).toBe(1);
    expect(addTracksToPlaylist.mock.calls[0][2]).toBe(1);
  });

  test('transfer-track refuses an array target with 400', async () => {
    const res = await request(app).post('/api/playlists/transfer-track')
      .send({ action: 'duplicate', trackId: 5, targetPlaylistId: [1] });

    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test('transfer-track still accepts a numeric-string target', async () => {
    getPlaylistWithTracks.mockImplementation(emptyTarget);
    const res = await request(app).post('/api/playlists/transfer-track')
      .send({ action: 'duplicate', trackId: 5, targetPlaylistId: '1' });

    expect(res.status).toBe(200);
    expect(addTracksToPlaylist.mock.calls[0][2]).toBe(1);
  });
});

describe('other scalar playlist ids found in the sweep are whole values', () => {
  test('bulk-remove refuses an array items[].playlistId with 400', async () => {
    const res = await request(app).post('/api/playlists/tracks/bulk-remove')
      .send({ items: [{ playlistId: [1], trackIds: [5] }] });

    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test('search-tracks refuses a repeated playlistId query parameter with 400', async () => {
    const res = await request(app).get('/api/playlists/search-tracks?q=house&playlistId=1&playlistId=2');

    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });
});
