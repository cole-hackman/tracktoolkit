import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * ADVERSARIAL (independent verifier). Playlist ids in a request body reach SoundCloud paths
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
const deleteRepost = jest.fn();

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
    deleteRepost,
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

function expectNoUpstreamCall() {
  expect(getPlaylistWithTracks).not.toHaveBeenCalled();
  expect(addTracksToPlaylist).not.toHaveBeenCalled();
  expect(createPlaylist).not.toHaveBeenCalled();
  expect(deletePlaylist).not.toHaveBeenCalled();
}

// Every value here must be refused as a playlist id.
const BAD_IDS = [
  ['leading space', ' 2'],
  ['trailing space', '2 '],
  ['newline-wrapped', '\n2\n'],
  ['exponent string', '2e3'],
  ['hex string', '0x10'],
  ['decimal-looking integer', '1.0'],
  ['arabic-indic digit', '٢'],
  ['fullwidth digit', '２'],
  ['MAX_SAFE_INTEGER+1 as number', Number.MAX_SAFE_INTEGER + 1],
  ['MAX_SAFE_INTEGER+2 as string', '9007199254740993'],
  ['negative zero string', '-0'],
  ['nested array', [[2]]],
  ['array of one', [2]],
  ['object with toString key', { toString: '2' }],
  ['object with valueOf key', { valueOf: 2 }],
  ['true', true],
  ['false', false],
  ['null', null],
  ['empty string', ''],
  ['encoded slash', '2%2F..%2Fme'],
  ['query smuggle', '2?x=1'],
  ['fragment', '2#x'],
];

describe('merge: sourcePlaylistIds elements', () => {
  test.each(BAD_IDS)('%s is refused with 400 and nothing reaches SoundCloud', async (_n, bad) => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: [bad, 3], title: 'Merged' });
    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test('a bad id in the LAST slot is refused too (not only the first)', async () => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: [3, 4, '5/../../me'], title: 'Merged' });
    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test('sourcePlaylistIds as a non-array (string / object) is refused', async () => {
    for (const v of ['2,3', { 0: 2, 1: 3, length: 2 }, 23]) {
      const res = await request(app).post('/api/playlists/merge').send({ sourcePlaylistIds: v, title: 'M' });
      expect(res.status).toBe(400);
    }
    expectNoUpstreamCall();
  });

  test('"+2" is accepted but normalised: SoundCloud sees the number 2', async () => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: ['+2', 3], title: 'Merged' });
    // Either outcome is safe, as long as the raw "+2" never reaches a path.
    if (res.status === 200) {
      expect(getPlaylistWithTracks.mock.calls.map((c) => c[2]).slice(0, 2)).toEqual([2, 3]);
    } else {
      expect(res.status).toBe(400);
      expectNoUpstreamCall();
    }
  });

  test('MAX_SAFE_INTEGER itself is accepted as a number', async () => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: [String(Number.MAX_SAFE_INTEGER), 3], title: 'Merged' });
    expect(res.status).toBe(200);
    expect(getPlaylistWithTracks.mock.calls[0][2]).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('every id handed to the client is a number, never a string', async () => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: ['2', '3'], targetPlaylistId: '1', deleteAfterMerge: true });
    expect(res.status).toBe(200);
    for (const fn of [getPlaylistWithTracks, addTracksToPlaylist, deletePlaylist]) {
      for (const c of fn.mock.calls) expect(typeof c[2]).toBe('number');
    }
  });
});

describe('merge: targetPlaylistId', () => {
  test.each(BAD_IDS)('%s is refused with 400 and nothing is deleted', async (_n, bad) => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: [2, 3], targetPlaylistId: bad, deleteAfterMerge: true });
    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test('target "+1" equal to a source 1 is still recognised as the same playlist', async () => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: [1, 2], targetPlaylistId: '+1', deleteAfterMerge: true });
    expect(res.status).toBe(400);
    expect(deletePlaylist).not.toHaveBeenCalled();
  });

  test('target "1" with sources ["+1", 2] is refused (both sides normalised)', async () => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: ['+1', 2], targetPlaylistId: '1', deleteAfterMerge: true });
    expect(res.status).toBe(400);
    expect(deletePlaylist).not.toHaveBeenCalled();
  });

  test('duplicate sources equal to the target never cause the target to be deleted', async () => {
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: [2, 2, 3], targetPlaylistId: 2, deleteAfterMerge: true });
    expect(res.status).toBe(400);
    expect(deletePlaylist).not.toHaveBeenCalled();
  });
});

describe('from-likes and followed-likes: targetPlaylistId', () => {
  test.each(BAD_IDS)('from-likes refuses %s', async (_n, bad) => {
    const res = await request(app).post('/api/playlists/from-likes')
      .send({ trackIds: [5, 6], targetPlaylistId: bad });
    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test.each(BAD_IDS)('followed-likes refuses %s', async (_n, bad) => {
    const res = await request(app).post('/api/followings/77/likes/playlist')
      .send({ mode: 'all', targetPlaylistId: bad });
    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test('omitting targetPlaylistId still creates a new playlist (optional still optional)', async () => {
    const res = await request(app).post('/api/playlists/from-likes')
      .send({ trackIds: [5, 6], title: 'New' });
    expect(res.status).toBe(200);
    expect(createPlaylist).toHaveBeenCalled();
  });
});

describe('POST /api/reposts/bulk-remove — item ids reach /reposts/playlists/${id}', () => {
  beforeEach(() => { deleteRepost.mockReset().mockResolvedValue({}); });

  test('a traversal id is refused', async () => {
    const res = await request(app).post('/api/reposts/bulk-remove')
      .send({ items: [{ id: '2/../../me', resourceType: 'playlist' }] });
    expect(res.status).toBe(400);
    expect(deleteRepost).not.toHaveBeenCalled();
  });

  // DEFECT (outside the brief's listed validators, inside its "any sibling"
  // clause): items.*.id uses a bare .isInt(), which express-validator applies
  // element-wise, so an ARRAY id passes and reaches deleteRepost, which then
  // interpolates it raw (`/reposts/playlists/5,6`). Not a traversal (each
  // element is digits), but the same whole-value hole the branch closed for
  // targetPlaylistId. Expected to FAIL until fixed.
  test('an array id is refused as a whole value', async () => {
    const res = await request(app).post('/api/reposts/bulk-remove')
      .send({ items: [{ id: [5, 6], resourceType: 'playlist' }] });
    expect(res.status).toBe(400);
    expect(deleteRepost).not.toHaveBeenCalled();
  });
});
