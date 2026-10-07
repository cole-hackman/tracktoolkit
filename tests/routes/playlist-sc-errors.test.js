import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * A SoundCloud failure used to become a generic 500 "Failed to merge playlists"
 * (or "Failed to get playlist"), whatever went wrong upstream. These pin the
 * mapping: a vanished playlist is a 409/404 the client can act on, a SoundCloud
 * outage is a 502 whose wording depends on whether a write already landed, and
 * everything else is still a 500.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const getPlaylistWithTracks = jest.fn();
const addTracksToPlaylist = jest.fn();
const createPlaylist = jest.fn();
const deletePlaylist = jest.fn();
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
  soundcloudClient: { getPlaylistWithTracks, addTracksToPlaylist, createPlaylist, deletePlaylist },
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
const range = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i);
const toTracks = (ids) => ids.map((id) => ({ id, streamable: true }));

/** Playlists 2 and 3 hold the given tracks; anything in `failing` rejects instead. */
function sources({ failing = {}, tracksA = [10, 11], tracksB = [11, 12], target } = {}) {
  getPlaylistWithTracks.mockImplementation(async (at, rt, id) => {
    if (failing[id]) throw failing[id];
    if (id === 2) return { id, title: 'A', track_count: tracksA.length, tracks: toTracks(tracksA) };
    if (id === 3) return { id, title: 'B', track_count: tracksB.length, tracks: toTracks(tracksB) };
    if (id === 1 && target) return { id, title: 'T', track_count: target.length, tracks: toTracks(target) };
    throw new Error(`no playlist ${id}`);
  });
}

beforeEach(() => {
  requestCache.invalidateUser('user-a');
  getPlaylistWithTracks.mockReset();
  addTracksToPlaylist.mockReset().mockResolvedValue({ id: 99 });
  createPlaylist.mockReset().mockResolvedValue({ id: 99, title: 'Merged' });
  deletePlaylist.mockReset().mockResolvedValue({});
  logOperation.mockClear();
  invalidatePlaylistState.mockClear();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('POST /api/playlists/merge — SoundCloud failures', () => {
  const merge = (body = {}) => request(app).post('/api/playlists/merge').send({ sourcePlaylistIds: [2, 3], title: 'Merged', ...body });

  test('a source that 404s is a 409 PLAYLIST_NOT_FOUND naming it; nothing written, cache invalidated', async () => {
    sources({ failing: { 3: scError(404) } });
    const res = await merge();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAYLIST_NOT_FOUND');
    expect(res.body.playlistId).toBe(3);
    expect(res.body.error).toMatch(/no longer exists/i);
    expect(res.body.error).toMatch(/nothing was changed/i);
    expect(createPlaylist).not.toHaveBeenCalled();
    expect(addTracksToPlaylist).not.toHaveBeenCalled();
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
    expect(logOperation).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', errorCode: 'PLAYLIST_NOT_FOUND' }));
  });

  test('a merge-into-existing target that 404s is a 409 PLAYLIST_NOT_FOUND naming the target', async () => {
    sources({ failing: { 1: scError(404) } });
    const res = await merge({ targetPlaylistId: 1 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAYLIST_NOT_FOUND');
    expect(res.body.playlistId).toBe(1);
    expect(addTracksToPlaylist).not.toHaveBeenCalled();
    expect(createPlaylist).not.toHaveBeenCalled();
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
  });

  test('a 502 on a read before any write is a 502 SOUNDCLOUD_UNAVAILABLE saying nothing was changed', async () => {
    sources({ failing: { 2: scError(502) } });
    const res = await merge();

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SOUNDCLOUD_UNAVAILABLE');
    expect(res.body.error).toMatch(/nothing was changed/i);
    expect(createPlaylist).not.toHaveBeenCalled();
    expect(logOperation).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', errorCode: 'SOUNDCLOUD_UNAVAILABLE' }));
  });

  test('a timeout is treated like a 502', async () => {
    sources({ failing: { 2: Object.assign(new Error('The operation was aborted.'), { code: 'SC_TIMEOUT', status: 504 }) } });
    const res = await merge();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SOUNDCLOUD_UNAVAILABLE');
  });

  test('a 502 after the playlist was created says some changes may have been made', async () => {
    sources({ tracksA: range(150), tracksB: [1] });
    addTracksToPlaylist.mockRejectedValue(scError(502));
    const res = await merge();

    expect(createPlaylist).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SOUNDCLOUD_UNAVAILABLE');
    expect(res.body.error).toMatch(/some changes may have been made/i);
    expect(res.body.error).not.toMatch(/nothing was changed/i);
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
  });

  test('a 502 on the very first write may have landed upstream, so it says some changes may have been made', async () => {
    sources();
    createPlaylist.mockRejectedValue(scError(502));
    const res = await merge();

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/some changes may have been made/i);
    expect(res.body.error).not.toMatch(/nothing was changed/i);
  });

  test('a timeout on the create (it may still have landed) says some changes may have been made', async () => {
    sources();
    createPlaylist.mockRejectedValue(
      Object.assign(new Error('The operation was aborted.'), { code: 'SC_TIMEOUT', status: 504 }),
    );
    const res = await merge();

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SOUNDCLOUD_UNAVAILABLE');
    expect(res.body.error).toMatch(/some changes may have been made/i);
  });

  test('a 502 on the first PUT to an existing target says some changes may have been made', async () => {
    sources({ target: [100], tracksA: [200], tracksB: [1] });
    addTracksToPlaylist.mockRejectedValue(scError(502));
    const res = await merge({ targetPlaylistId: 1 });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/some changes may have been made/i);
  });

  test('a 502 on a split-mode (>500 tracks) create says some changes may have been made', async () => {
    sources({ tracksA: range(300), tracksB: range(300, 301) });
    createPlaylist.mockRejectedValue(scError(502));
    const res = await merge();

    expect(createPlaylist).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/some changes may have been made/i);
  });

  test('a 502 on an overflow create (into-existing) says some changes may have been made', async () => {
    // 450 existing + 100 new = 550 > 500, so the target PUT succeeds and the
    // overflow playlist is created next.
    sources({ target: range(450, 1000), tracksA: range(100, 2000), tracksB: [1] });
    createPlaylist.mockRejectedValue(scError(502));
    const res = await merge({ targetPlaylistId: 1 });

    expect(createPlaylist).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/some changes may have been made/i);
  });

  test('a 502 partway through merge-into-existing says some changes may have been made', async () => {
    sources({ target: [100], tracksA: range(250, 200), tracksB: [1] });
    addTracksToPlaylist.mockResolvedValueOnce({ id: 1 }).mockRejectedValue(scError(502));
    const res = await merge({ targetPlaylistId: 1 });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/some changes may have been made/i);
  });

  test('a 429 is unchanged: 500 Failed to merge playlists', async () => {
    sources({ failing: { 2: scError(429) } });
    const res = await merge();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to merge playlists');
  });

  test('a generic error is still a 500', async () => {
    sources({ failing: { 2: new Error('boom') } });
    const res = await merge();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to merge playlists');
  });

  test('a 404 on a WRITE is not misread as a missing source: stays 500', async () => {
    sources();
    createPlaylist.mockRejectedValue(scError(404));
    const res = await merge();
    expect(res.status).toBe(500);
  });

  test('the existing 409 for a short read still wins and keeps its text', async () => {
    getPlaylistWithTracks.mockImplementation(async (at, rt, id) => {
      if (id === 1) return { id, title: 'T', track_count: 3, tracks: toTracks([1]) };
      return { id, title: 'S', track_count: 1, tracks: toTracks([50]) };
    });
    const res = await merge({ targetPlaylistId: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only 1 of the 3 tracks/);
    expect(res.body.code).toBeUndefined();
  });
});

describe('GET /api/playlists/:id — SoundCloud failures', () => {
  test('an upstream 404 is a 404 PLAYLIST_NOT_FOUND and invalidates the playlist list', async () => {
    getPlaylistWithTracks.mockRejectedValue(scError(404));
    const res = await request(app).get('/api/playlists/5');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PLAYLIST_NOT_FOUND');
    expect(res.body.error).toBe('This playlist no longer exists on SoundCloud.');
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
  });

  test('an upstream 502 is a 502 SOUNDCLOUD_UNAVAILABLE', async () => {
    getPlaylistWithTracks.mockRejectedValue(scError(502));
    const res = await request(app).get('/api/playlists/5');

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SOUNDCLOUD_UNAVAILABLE');
    expect(typeof res.body.error).toBe('string');
    expect(invalidatePlaylistState).not.toHaveBeenCalled();
  });

  test('a timeout is a 502', async () => {
    getPlaylistWithTracks.mockRejectedValue(Object.assign(new Error('The operation was aborted.'), { code: 'SC_TIMEOUT', status: 504 }));
    const res = await request(app).get('/api/playlists/5');
    expect(res.status).toBe(502);
  });

  test('anything else stays a 500', async () => {
    getPlaylistWithTracks.mockRejectedValue(scError(500));
    const res = await request(app).get('/api/playlists/5');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to get playlist');
  });

  test('a 429 stays a 500', async () => {
    getPlaylistWithTracks.mockRejectedValue(scError(429));
    const res = await request(app).get('/api/playlists/5');
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/playlists/:id — upstream statuses pass through', () => {
  test.each([404, 403, 502, 503, 504])('an upstream %i is returned as that status', async (status) => {
    deletePlaylist.mockRejectedValue(scError(status));
    const res = await request(app).delete('/api/playlists/5');
    expect(res.status).toBe(status);
    expect(res.body.error).toBe('Failed to delete playlist');
  });

  test('a timeout is a 504', async () => {
    deletePlaylist.mockRejectedValue(
      Object.assign(new Error('The operation was aborted.'), { code: 'SC_TIMEOUT', status: 504 }),
    );
    const res = await request(app).delete('/api/playlists/5');
    expect(res.status).toBe(504);
  });

  test('an error with no status is a 500', async () => {
    deletePlaylist.mockRejectedValue(new Error('boom'));
    const res = await request(app).delete('/api/playlists/5');
    expect(res.status).toBe(500);
  });
});
