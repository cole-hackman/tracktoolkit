import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Second independent pass over fix/input-abuse-rules. What the earlier suites
 * (playlist-id-validation, playlist-id-adversarial) do not reach:
 *
 * - transfer-track's OTHER scalar ids. Only targetPlaylistId moved to
 *   scalarIdField; sourcePlaylistId and trackId are still a bare `.isInt()`,
 *   which express-validator applies element-wise, so `[1]` passes. On a
 *   `move` the route's "source and target must differ" guard is `===`, so
 *   `sourcePlaylistId: [1], targetPlaylistId: 1` slips past it. Against the
 *   real client pathId() throws (no data loss, but a 500, not a 400); the
 *   validator is the line that should have refused it.
 * - nested arrays one level down (`[[2], 3]`) on every `.*` field.
 * - `null` / boolean targets.
 * - the `.toInt()` type change on bulk-unrepost: string ids now become
 *   numbers, so the cached-repost harvest (`processedIds.has(r.id)` against
 *   numeric cached ids), the response and OperationLog all see numbers.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const getPlaylistWithTracks = jest.fn();
const addTracksToPlaylist = jest.fn();
const createPlaylist = jest.fn();
const deletePlaylist = jest.fn();
const deleteRepost = jest.fn();
const getUserLikedTracks = jest.fn();
const getFollowings = jest.fn();
const harvestTracks = jest.fn();
const harvestPlaylists = jest.fn();
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
    getPlaylistWithTracks, addTracksToPlaylist, createPlaylist, deletePlaylist, deleteRepost,
    getUserLikedTracks, getFollowings,
  },
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
}));
jest.unstable_mockModule('../../server/lib/catalog.js', () => ({
  harvestTracks, harvestPlaylists,
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
    req.user = { id: 'user-g', soundcloudId: 222 };
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

const playlistWith = (ids) => async (at, rt, id) => ({
  id, title: `pl ${id}`, track_count: ids.length, tracks: ids.map((t) => ({ id: t, streamable: true })),
});

beforeEach(() => {
  requestCache.invalidateUser('user-g');
  getPlaylistWithTracks.mockReset().mockImplementation(playlistWith([5]));
  addTracksToPlaylist.mockReset().mockResolvedValue({ id: 1 });
  createPlaylist.mockReset().mockResolvedValue({ id: 99, permalink_url: 'x' });
  deletePlaylist.mockReset().mockResolvedValue({});
  deleteRepost.mockReset().mockResolvedValue({});
  getUserLikedTracks.mockReset().mockResolvedValue([]);
  getFollowings.mockReset().mockResolvedValue([]);
  harvestTracks.mockReset();
  harvestPlaylists.mockReset();
  logOperation.mockReset();
});

function expectNoUpstreamWrite() {
  expect(addTracksToPlaylist).not.toHaveBeenCalled();
  expect(deletePlaylist).not.toHaveBeenCalled();
  expect(createPlaylist).not.toHaveBeenCalled();
}

describe('transfer-track: the other scalar ids', () => {
  // DEFECT: sourcePlaylistId is still a bare .isInt(); `[1]` passes
  // element-wise and is not `===` the target 1, so the "must differ" guard in
  // moveTrackBetweenPlaylists is skipped. With a mocked client the move then
  // rewrites playlist 1 twice (add, then remove the track from "source" 1).
  test('move with sourcePlaylistId [1] and targetPlaylistId 1 is refused with 400', async () => {
    const res = await request(app).post('/api/playlists/transfer-track')
      .send({ action: 'move', trackId: 5, sourcePlaylistId: [1], targetPlaylistId: 1 });

    expect(res.status).toBe(400);
    expect(getPlaylistWithTracks).not.toHaveBeenCalled();
    expectNoUpstreamWrite();
  });

  // DEFECT (same class, lower impact): trackId `[5]` passes, never `===` an id
  // read from the playlist, and is appended as `[5]`.
  test('an array trackId is refused with 400', async () => {
    const res = await request(app).post('/api/playlists/transfer-track')
      .send({ action: 'duplicate', trackId: [5], targetPlaylistId: 1 });

    expect(res.status).toBe(400);
    expectNoUpstreamWrite();
  });

  test('move with numeric-string source and target that name the same playlist is refused', async () => {
    const res = await request(app).post('/api/playlists/transfer-track')
      .send({ action: 'move', trackId: 5, sourcePlaylistId: '1', targetPlaylistId: 1 });

    expect(res.status).toBe(400);
    expectNoUpstreamWrite();
  });
});

describe('nested and non-scalar values one level down', () => {
  test.each([
    ['merge sources [[2], 3]', '/api/playlists/merge', { sourcePlaylistIds: [[2], 3], title: 't' }],
    ['merge sources [2, [3, 4]]', '/api/playlists/merge', { sourcePlaylistIds: [2, [3, 4]], title: 't' }],
    ['merge sources with an object', '/api/playlists/merge', { sourcePlaylistIds: [2, { id: 3 }], title: 't' }],
    ['merge sources with a boolean', '/api/playlists/merge', { sourcePlaylistIds: [2, true], title: 't' }],
    ['merge sources with a leading zero', '/api/playlists/merge', { sourcePlaylistIds: ['02', 3], title: 't' }],
    ['merge sources with a float', '/api/playlists/merge', { sourcePlaylistIds: [2.5, 3], title: 't' }],
    ['merge sources with hex', '/api/playlists/merge', { sourcePlaylistIds: ['0x10', 3], title: 't' }],
    ['merge sources with exponent', '/api/playlists/merge', { sourcePlaylistIds: ['1e3', 3], title: 't' }],
    ['merge sources with whitespace', '/api/playlists/merge', { sourcePlaylistIds: [' 2', 3], title: 't' }],
    ['merge sources past MAX_SAFE_INTEGER', '/api/playlists/merge', { sourcePlaylistIds: ['9007199254740993', 3], title: 't' }],
    ['merge target null', '/api/playlists/merge', { sourcePlaylistIds: [2, 3], targetPlaylistId: null }],
    ['merge target true', '/api/playlists/merge', { sourcePlaylistIds: [2, 3], targetPlaylistId: true }],
    ['merge target object', '/api/playlists/merge', { sourcePlaylistIds: [2, 3], targetPlaylistId: { 0: 1 } }],
    ['from-likes target [[1]]', '/api/playlists/from-likes', { trackIds: [5], targetPlaylistId: [[1]] }],
    ['bulk-add target "1/../2"', '/api/playlists/tracks/bulk-add', { targetPlaylistId: '1/../2', trackIds: [5] }],
  ])('%s is refused with 400 before any SoundCloud call', async (_name, path, body) => {
    const res = await request(app).post(path).send(body);
    expect(res.status).toBe(400);
    expect(getPlaylistWithTracks).not.toHaveBeenCalled();
    expectNoUpstreamWrite();
  });

  test('merge with deleteAfterMerge, target given as a numeric string, deletes only the other source', async () => {
    getPlaylistWithTracks.mockImplementation(playlistWith([]));
    const res = await request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: ['2', '3'], targetPlaylistId: '4', deleteAfterMerge: true });

    expect(res.status).toBe(200);
    const deleted = deletePlaylist.mock.calls.map((c) => c[2]);
    expect(deleted).toEqual([2, 3]);
    expect(deleted).not.toContain(4);
    for (const id of deleted) expect(typeof id).toBe('number');
  });
});

describe('bulk-unrepost: string ids become numbers, downstream sees one type', () => {
  test('string ids still harvest the matching cached reposts and come back as numbers', async () => {
    requestCache.set('reposts', 'user-g', 'default', {
      collection: [
        { id: 5, resourceType: 'track', title: 'kept' },
        { id: 7, resourceType: 'playlist', title: 'pl' },
        { id: 8, resourceType: 'track', title: 'untouched' },
      ],
    }, 60_000);

    const res = await request(app).post('/api/reposts/bulk-remove')
      .send({ items: [{ id: '5', resourceType: 'track' }, { id: '7', resourceType: 'playlist' }] });

    expect(res.status).toBe(200);
    expect(deleteRepost.mock.calls.map((c) => c[2])).toEqual([5, 7]);
    expect(res.body.results.map((r) => r.id)).toEqual([5, 7]);

    const harvestedTracks = harvestTracks.mock.calls.flatMap((c) => c[0]).map((r) => r.id);
    const harvestedPlaylists = harvestPlaylists.mock.calls.flatMap((c) => c[0]).map((r) => r.id);
    expect(harvestedTracks).toEqual([5]);
    expect(harvestedPlaylists).toEqual([7]);

    const op = logOperation.mock.calls.find((c) => c[0].action === 'bulk-remove-reposts')[0];
    expect(op.trackIds).toEqual([5]);
    expect(op.playlistIds).toEqual([7]);
  });

  test('a nested id [[5]] and a non-object item are refused', async () => {
    for (const items of [[{ id: [[5]], resourceType: 'track' }], [5], [{ resourceType: 'track' }]]) {
      const res = await request(app).post('/api/reposts/bulk-remove').send({ items });
      expect(res.status).toBe(400);
    }
    expect(deleteRepost).not.toHaveBeenCalled();
  });
});
