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

const TARGET = 1;
const range = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i);
const toTracks = (ids) => ids.map((id) => ({ id, streamable: true }));

// The scenario under test; set per test by scenario().
let existing = [];
let fresh = [];

function scenario(existingIds, freshIds) {
  existing = existingIds;
  fresh = freshIds;
  getPlaylistWithTracks.mockImplementation(async (at, rt, id) => {
    if (id === TARGET) return { id, title: 'Big target', track_count: existing.length, tracks: toTracks(existing) };
    if (id === 2) return { id, title: 'Src A', track_count: fresh.length, tracks: toTracks(fresh) };
    if (id === 3) return { id, title: 'Src B', track_count: 1, tracks: toTracks([fresh[0]]) };
    throw new Error(`no playlist ${id}`);
  });
  getUserLikedTracks.mockResolvedValue(toTracks(fresh));
}

const targetWrites = () => addTracksToPlaylist.mock.calls
  .filter((c) => c[2] === TARGET)
  .map((c) => c[3]);

/** Every PUT to the target, including a failed one, keeps the whole existing list as its prefix. */
function expectExistingIsPrefixOfEveryWrite() {
  for (const w of targetWrites()) {
    expect(w.length).toBeGreaterThanOrEqual(existing.length);
    expect(w.slice(0, existing.length)).toEqual(existing);
  }
}

beforeEach(() => {
  requestCache.invalidateUser('user-a');
  getPlaylistWithTracks.mockReset();
  addTracksToPlaylist.mockReset().mockResolvedValue({ id: TARGET, title: 'ok' });
  getFollowings.mockReset().mockResolvedValue([{ id: 77, username: 'friend' }]);
  getUserLikedTracks.mockReset();
  createPlaylist.mockReset().mockResolvedValue({ id: 99, permalink_url: 'x' });
});

/** Make the nth PUT to the target fail the way a 429-after-retries does. */
function failNthTargetWrite(nth) {
  let n = 0;
  addTracksToPlaylist.mockImplementation(async (at, rt, id) => {
    if (id === TARGET) {
      n += 1;
      if (n === nth) throw Object.assign(new Error('rate limited'), { status: 429 });
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
      .send({ trackIds: fresh, targetPlaylistId: TARGET }),
  },
  {
    name: 'followed likes into an existing target (createOrAppendTrackIds)',
    send: () => request(app).post('/api/followings/77/likes/playlist')
      .send({ mode: 'all', targetPlaylistId: TARGET }),
  },
];

describe.each(writers)('$name', ({ send }) => {
  test('appending 30 to a 450-track target never PUTs fewer than 450 tracks', async () => {
    scenario(range(450), range(30, 10000));
    const res = await send();

    expect(res.status).toBe(200);
    expectExistingIsPrefixOfEveryWrite();
    const writes = targetWrites();
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[writes.length - 1]).toHaveLength(480);
  });

  test.each([1, 2, 3])('a failure on PUT %i (50 existing + 300 new) keeps the existing list in every write and reports no success', async (nth) => {
    scenario(range(50), range(300, 10000));
    failNthTargetWrite(nth);
    const res = await send();

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.playlist).toBeUndefined();
    expect(res.body.totalTracks).toBeUndefined();
    expect(typeof res.body.error).toBe('string');
    expect(targetWrites()).toHaveLength(nth);
    expectExistingIsPrefixOfEveryWrite();
  });

  test('duplicate existing ids and new ids that overlap the target', async () => {
    const dupes = [...range(40), ...range(10)]; // 50 entries, ids 1-10 twice
    scenario(dupes, [...range(10), ...range(200, 10000)]); // 10 overlap, 200 new
    const res = await send();

    expect(res.status).toBe(200);
    expectExistingIsPrefixOfEveryWrite();
    const writes = targetWrites();
    expect(writes[writes.length - 1]).toEqual([...dupes, ...range(200, 10000)]);
  });

  test('a merged list over 500 fills the target to 500 and creates an overflow playlist for the rest', async () => {
    scenario(range(450), range(100, 10000));
    const res = await send();

    expect(res.status).toBe(200);
    expectExistingIsPrefixOfEveryWrite();
    const writes = targetWrites();
    expect(writes[writes.length - 1]).toHaveLength(500);
    expect(createPlaylist).toHaveBeenCalledTimes(1);
    expect(createPlaylist.mock.calls[0][4]).toEqual(range(50, 10050));
    expect(res.body.overflowPlaylists).toHaveLength(1);
    expect(res.body.overflowPlaylists[0].trackCount).toBe(50);
  });

  test('a target already over 500 tracks is refused with 409 before any write', async () => {
    scenario(range(520), range(5, 10000));
    const res = await send();

    expect(res.status).toBe(409);
    expect(typeof res.body.error).toBe('string');
    expect(addTracksToPlaylist).not.toHaveBeenCalled();
    expect(createPlaylist).not.toHaveBeenCalled();
  });
});
