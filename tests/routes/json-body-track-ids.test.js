import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Track ids that only ever reach SoundCloud inside a JSON body, as
 * `soundcloud:tracks:<id>` URNs: `PUT /api/playlists/:id` (`tracks`,
 * `remove`) and `POST /api/playlists/from-likes` (`trackIds`). They cannot
 * change which endpoint is called, which is why they were left on the old
 * `parseInt` check when the path ids were tightened. Two things were still
 * wrong with that check:
 *
 * - from-likes passed the caller's values through untouched. `"5"` did not
 *   match the `5` already in the playlist, so it was appended as a duplicate,
 *   and `"12abc"` went upstream as the URN `soundcloud:tracks:12abc`.
 * - `parseInt` reads the leading digits, so `"12abc"`, `"1e3"` and `" 12"`
 *   were each accepted as some other number than the one written.
 *
 * Both validators now take a whole positive safe integer (a JSON number or a
 * digits-only string) and nothing else, and from-likes hands the route numbers.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const getPlaylistWithTracks = jest.fn();
const addTracksToPlaylist = jest.fn();
const createPlaylist = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../server/lib/catalog.js', () => ({
  harvestTracks: jest.fn(),
  harvestPlaylists: jest.fn(),
}));
jest.unstable_mockModule('../../server/lib/pacing.js', () => ({
  SC_WRITE_PACING_MS: 0,
  SC_PLAYLIST_PACING_MS: 0,
  SC_BULK_PACING_MS: 0,
  SC_READ_CONCURRENCY: 5,
  sleep: jest.fn(async () => {}),
  mapWithConcurrency: async (items, _l, fn) => Promise.all(items.map(fn)),
}));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: { getPlaylistWithTracks, addTracksToPlaylist, createPlaylist },
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation: jest.fn(),
  startOperationTimer: () => () => 0,
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

const playlist = (ids) => ({ id: 1, title: 'Mix', track_count: ids.length, tracks: ids.map((id) => ({ id })) });

beforeEach(() => {
  requestCache.invalidateUser('user-a');
  getPlaylistWithTracks.mockReset().mockResolvedValue(playlist([5, 6]));
  addTracksToPlaylist.mockReset().mockResolvedValue({ id: 1, title: 'Mix' });
  createPlaylist.mockReset().mockResolvedValue({ id: 99, permalink_url: 'x' });
});

function expectNoUpstreamCall() {
  expect(getPlaylistWithTracks).not.toHaveBeenCalled();
  expect(addTracksToPlaylist).not.toHaveBeenCalled();
  expect(createPlaylist).not.toHaveBeenCalled();
}

// Not a whole positive safe integer, each in its own way.
const BAD_TRACK_IDS = [
  ['digits then letters', '12abc'],
  ['a path', '12/../../me'],
  ['exponent string', '1e3'],
  ['leading space', ' 12'],
  ['trailing space', '12 '],
  ['leading plus', '+12'],
  ['leading zero', '012'],
  ['decimal string', '12.0'],
  ['hex string', '0x10'],
  ['fullwidth digit', '１２'],
  ['fraction', 12.5],
  ['beyond the safe range', 1e21],
  ['zero', 0],
  ['negative', -3],
  ['array of one', [12]],
  ['object', { id: 12 }],
  ['true', true],
  ['null', null],
  ['empty string', ''],
];

describe('POST /api/playlists/from-likes: trackIds', () => {
  test.each(BAD_TRACK_IDS)('refuses %s', async (_name, bad) => {
    const res = await request(app).post('/api/playlists/from-likes')
      .send({ trackIds: [7, bad], title: 'New' });

    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test('a digits-only string is the number it spells: already present, so not added again', async () => {
    const res = await request(app).post('/api/playlists/from-likes')
      .send({ trackIds: ['5', '7'], targetPlaylistId: 1 });

    expect(res.status).toBe(200);
    expect(addTracksToPlaylist).toHaveBeenCalledTimes(1);
    expect(addTracksToPlaylist.mock.calls[0][3]).toEqual([5, 6, 7]);
  });

  test('a new playlist is created from numbers, whatever the caller sent', async () => {
    const res = await request(app).post('/api/playlists/from-likes')
      .send({ trackIds: ['8', 9], title: 'New' });

    expect(res.status).toBe(200);
    const sent = createPlaylist.mock.calls[0].find((arg) => Array.isArray(arg));
    expect(sent).toEqual([8, 9]);
  });

  test('5000 ids are still accepted', async () => {
    const res = await request(app).post('/api/playlists/from-likes')
      .send({ trackIds: Array.from({ length: 5000 }, (_, i) => i + 1), title: 'Big' });

    expect(res.status).toBe(200);
  });
});

describe('PUT /api/playlists/:id: tracks and remove', () => {
  test.each(BAD_TRACK_IDS)('tracks refuses %s', async (_name, bad) => {
    const res = await request(app).put('/api/playlists/1').send({ tracks: [5, 6, bad] });

    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test.each(BAD_TRACK_IDS)('remove refuses %s', async (_name, bad) => {
    const res = await request(app).put('/api/playlists/1').send({ tracks: [5], remove: [6, bad] });

    expect(res.status).toBe(400);
    expectNoUpstreamCall();
  });

  test('digits-only strings still work, and still count as the same id in both lists', async () => {
    const kept = await request(app).put('/api/playlists/1').send({ tracks: ['5'], remove: ['6'] });
    expect(kept.status).toBe(200);
    expect(addTracksToPlaylist.mock.calls[0][3]).toEqual([5]);

    const both = await request(app).put('/api/playlists/1').send({ tracks: ['5', 6], remove: [5] });
    expect(both.status).toBe(400);
  });

  test('an id the page did not declare is still refused with 409', async () => {
    const res = await request(app).put('/api/playlists/1').send({ tracks: [5] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAYLIST_OUT_OF_SYNC');
    expect(addTracksToPlaylist).not.toHaveBeenCalled();
  });
});
