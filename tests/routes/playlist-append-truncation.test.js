import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * SoundCloud's PUT replaces a playlist's whole track list. The three writers
 * that append to an EXISTING target used to grow it with prefix writes that
 * started at 100 (or 200) tracks, so a 450-track target was cut to that prefix
 * by the first PUT, and a failure on the second PUT left it there for good.
 *
 * The invariant pinned here: no PUT to the target is ever shorter than the
 * target's existing track list.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const getPlaylistWithTracks = jest.fn();
const addTracksToPlaylist = jest.fn();
const getFollowings = jest.fn();
const getUserLikedTracks = jest.fn();
const createPlaylist = jest.fn();

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
  soundcloudClient: { getPlaylistWithTracks, addTracksToPlaylist, getFollowings, getUserLikedTracks, createPlaylist },
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

const EXISTING = 450;
const APPENDED = 30;
const TARGET = 1;

const existingIds = Array.from({ length: EXISTING }, (_, i) => i + 1);
const newIds = Array.from({ length: APPENDED }, (_, i) => 10000 + i);

const toTracks = (ids) => ids.map((id) => ({ id, streamable: true }));

function installPlaylists() {
  getPlaylistWithTracks.mockImplementation(async (at, rt, id) => {
    if (id === TARGET) {
      return { id, title: 'Big target', track_count: EXISTING, tracks: toTracks(existingIds) };
    }
    if (id === 2) return { id, title: 'Src A', track_count: APPENDED, tracks: toTracks(newIds) };
    if (id === 3) return { id, title: 'Src B', track_count: 1, tracks: toTracks([10000]) };
    throw new Error(`no playlist ${id}`);
  });
}

const targetWrites = () => addTracksToPlaylist.mock.calls
  .filter((c) => c[2] === TARGET)
  .map((c) => c[3]);

/** Every PUT keeps the whole existing list, in its original order. */
function expectNeverShorterThanExisting() {
  const writes = targetWrites();
  expect(writes.length).toBeGreaterThan(0);
  for (const w of writes) {
    expect(w.length).toBeGreaterThanOrEqual(EXISTING);
    expect(w.slice(0, EXISTING)).toEqual(existingIds);
  }
}

beforeEach(() => {
  requestCache.invalidateUser('user-a');
  getPlaylistWithTracks.mockReset();
  addTracksToPlaylist.mockReset().mockResolvedValue({ id: TARGET, title: 'ok' });
  getFollowings.mockReset().mockResolvedValue([{ id: 77, username: 'friend' }]);
  getUserLikedTracks.mockReset().mockResolvedValue(toTracks(newIds));
  createPlaylist.mockReset();
  installPlaylists();
});

/** Make the second PUT to the target fail the way a 429-after-retries does. */
function failSecondTargetWrite() {
  let n = 0;
  addTracksToPlaylist.mockImplementation(async (at, rt, id) => {
    if (id === TARGET) {
      n += 1;
      if (n === 2) throw Object.assign(new Error('rate limited'), { status: 429 });
    }
    return { id, title: 'ok' };
  });
}

const writers = [
  {
    name: 'merge into an existing target',
    send: () => request(app).post('/api/playlists/merge')
      .send({ sourcePlaylistIds: [2, 3], targetPlaylistId: TARGET }),
  },
  {
    name: 'from-likes into an existing target',
    send: () => request(app).post('/api/playlists/from-likes')
      .send({ trackIds: newIds, targetPlaylistId: TARGET }),
  },
  {
    name: 'followed likes into an existing target (createOrAppendTrackIds)',
    send: () => request(app).post('/api/followings/77/likes/playlist')
      .send({ mode: 'all', targetPlaylistId: TARGET }),
  },
];

describe.each(writers)('$name', ({ send }) => {
  test('appending 30 to a 450-track target never PUTs fewer than 450 tracks', async () => {
    const res = await send();

    expect(res.status).toBe(200);
    expectNeverShorterThanExisting();
    const writes = targetWrites();
    expect(writes[writes.length - 1]).toHaveLength(EXISTING + APPENDED);
  });

  test('a failing second PUT leaves nothing shorter than 450 and does not report success', async () => {
    failSecondTargetWrite();
    const res = await send();

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.playlist).toBeUndefined();
    expect(res.body.totalTracks).toBeUndefined();
    expect(typeof res.body.error).toBe('string');
    expectNeverShorterThanExisting();
  });
});
