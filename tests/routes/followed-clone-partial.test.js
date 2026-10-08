import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * POST /api/followings/:userId/playlists/clone used to swallow every per-item
 * failure as "could not be cloned. It may be private or unavailable", even
 * when a create had landed and a later PUT failed (a half-filled playlist the
 * response never mentioned), and answered 400 "nothing to clone" with no cache
 * invalidation when every item failed. These tests pin the honest outcomes.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const getPlaylistWithTracks = jest.fn();
const addTracksToPlaylist = jest.fn();
const createPlaylist = jest.fn();
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
  soundcloudClient: { getPlaylistWithTracks, addTracksToPlaylist, createPlaylist, getFollowings },
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

const scError = (status) => Object.assign(new Error(`API request failed: ${status}`), { status });
const range = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i);
const toTracks = (ids) => ids.map((id) => ({ id, streamable: true }));

/** map: { [playlistId]: trackCount | Error } */
function sources(map) {
  getPlaylistWithTracks.mockImplementation(async (at, rt, id) => {
    const v = map[id];
    if (v instanceof Error) throw v;
    return { id, title: `Src ${id}`, permalink_url: `https://sc/src/${id}`, tracks: toTracks(range(v, id * 10000)) };
  });
}

/** createPlaylist hands out ids 90, 91, ...; `failPut(id, n)` decides if the nth PUT to a playlist fails. */
function playlistsApi({ failPut = () => false } = {}) {
  let next = 90;
  const puts = {};
  createPlaylist.mockImplementation(async (at, rt, title) => {
    const id = next++;
    return { id, title, permalink_url: `https://sc/${id}` };
  });
  addTracksToPlaylist.mockImplementation(async (at, rt, id) => {
    puts[id] = (puts[id] || 0) + 1;
    if (failPut(id, puts[id])) throw scError(502);
    return { id };
  });
}

const clone = (playlistIds) => request(app).post('/api/followings/999/playlists/clone').send({ playlistIds });

beforeEach(() => {
  requestCache.invalidateUser('user-a');
  getPlaylistWithTracks.mockReset();
  addTracksToPlaylist.mockReset().mockResolvedValue({ id: 99 });
  createPlaylist.mockReset().mockResolvedValue({ id: 99, title: 'New', permalink_url: 'https://sc/99' });
  getFollowings.mockReset().mockResolvedValue([{ id: 999, username: 'friend' }]);
  logOperation.mockClear();
  invalidatePlaylistState.mockClear();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('followed clone: partly created playlists are reported', () => {
  test('250 tracks, the second PUT fails: 502 naming the half-filled playlist at 200 of 250', async () => {
    sources({ 5: 250 });
    // PUT 1 writes the first 200, PUT 2 would write all 250.
    playlistsApi({ failPut: (id, n) => n === 2 });
    const res = await clone([5]);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SOUNDCLOUD_UNAVAILABLE');
    expect(res.body.error).toBe('Some copies may have been partly created — check your playlists before trying again.');
    expect(res.body.partialPlaylists).toEqual([{
      id: 90,
      title: 'Clone of Src 5',
      permalink_url: 'https://sc/90',
      tracksWritten: 200,
      intendedTrackCount: 250,
      sourcePlaylistId: 5,
    }]);
    expect(res.body.errors).toEqual([{
      id: 5,
      partialPlaylistId: 90,
      error: 'A copy was created but only partly filled (at least 200 of 250 tracks). Check it on SoundCloud.',
    }]);
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
    expect(logOperation).toHaveBeenCalledWith(expect.objectContaining({ action: 'followed-playlist-clone', status: 'error' }));
  });

  test('the first PUT failing leaves the initial 100 tracks written', async () => {
    sources({ 5: 250 });
    playlistsApi({ failPut: (id, n) => n === 1 });
    const res = await clone([5]);

    expect(res.status).toBe(502);
    expect(res.body.partialPlaylists[0].tracksWritten).toBe(100);
    expect(res.body.errors[0].error).toMatch(/at least 100 of 250 tracks/);
  });

  test('a non-upstream failure on the PUT is a 500 with the same body shape', async () => {
    sources({ 5: 250 });
    addTracksToPlaylist.mockRejectedValue(Object.assign(new Error('boom'), { status: 400 }));
    const res = await clone([5]);

    expect(res.status).toBe(500);
    expect(res.body.code).toBeUndefined();
    expect(res.body.partialPlaylists).toHaveLength(1);
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
  });

  test('two sources, the second partial: 207 with the first in playlists and the second in partialPlaylists', async () => {
    sources({ 5: 50, 6: 250 });
    playlistsApi({ failPut: (id) => id === 91 });
    const res = await clone([5, 6]);

    expect(res.status).toBe(207);
    expect(res.body.playlists).toHaveLength(1);
    expect(res.body.playlists[0]).toMatchObject({ id: 90, sourcePlaylistId: 5, trackCount: 50 });
    expect(res.body.partialPlaylists).toHaveLength(1);
    expect(res.body.partialPlaylists[0]).toMatchObject({ id: 91, sourcePlaylistId: 6, tracksWritten: 100, intendedTrackCount: 250 });
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatchObject({ id: 6, partialPlaylistId: 91 });
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
  });

  test('multi-chunk source: chunk 1 stays in playlists, chunk 2 is the partial one', async () => {
    sources({ 5: 700 }); // chunks of 500 and 200
    playlistsApi({ failPut: (id) => id === 91 });
    const res = await clone([5]);

    expect(res.status).toBe(207);
    expect(res.body.playlists).toHaveLength(1);
    expect(res.body.playlists[0]).toMatchObject({ id: 90, trackCount: 500, sourcePlaylistId: 5 });
    expect(res.body.partialPlaylists).toEqual([expect.objectContaining({
      id: 91, tracksWritten: 100, intendedTrackCount: 200, sourcePlaylistId: 5,
    })]);
    expect(res.body.errors[0]).toMatchObject({ id: 5, partialPlaylistId: 91 });
    expect(res.body.errors[0].error).not.toMatch(/private or unavailable/);
  });

  test('a fully successful clone is unchanged: 200, no partialPlaylists key', async () => {
    sources({ 5: 120 });
    playlistsApi();
    const res = await clone([5]);

    expect(res.status).toBe(200);
    expect(res.body.playlists).toHaveLength(1);
    expect('partialPlaylists' in res.body).toBe(false);
    expect(res.body.errors).toBeUndefined();
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
  });
});

describe('followed clone: a create that itself failed', () => {
  test('a 502 on create: 502, "may not have been created" wording, cache invalidated', async () => {
    sources({ 5: 50 });
    createPlaylist.mockRejectedValue(scError(502));
    const res = await clone([5]);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SOUNDCLOUD_UNAVAILABLE');
    expect(res.body.errors).toEqual([{
      id: 5,
      error: 'Copy may not have been created — check your playlists before trying again.',
    }]);
    expect(res.body.error).not.toMatch(/nothing was changed/i);
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
    expect(logOperation).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  test('a non-upstream create failure is a 500, still invalidating', async () => {
    sources({ 5: 50 });
    createPlaylist.mockRejectedValue(new Error('boom'));
    const res = await clone([5]);

    expect(res.status).toBe(500);
    expect(res.body.errors[0].error).toMatch(/may not have been created/);
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
  });
});

describe('followed clone: nothing was written', () => {
  test('every source has no streamable tracks: the existing 400, no invalidation', async () => {
    getPlaylistWithTracks.mockResolvedValue({ id: 5, title: 'Empty', tracks: [{ id: 1, streamable: false }] });
    const res = await clone([5]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No selected playlists had public streamable tracks to clone.');
    expect(res.body.errors).toEqual([{ id: 5, error: 'Playlist has no public streamable tracks to clone.' }]);
    expect(createPlaylist).not.toHaveBeenCalled();
    expect(invalidatePlaylistState).not.toHaveBeenCalled();
  });

  test('read 404 only: 400 "None of the selected playlists could be cloned." with the per-item reason', async () => {
    sources({ 5: scError(404) });
    const res = await clone([5]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('None of the selected playlists could be cloned.');
    expect(res.body.errors).toEqual([{ id: 5, error: 'This playlist no longer exists or is private.' }]);
    expect(createPlaylist).not.toHaveBeenCalled();
    expect(invalidatePlaylistState).not.toHaveBeenCalled();
    expect(logOperation).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  test('read 502 only: 502 "Nothing was changed", no invalidation', async () => {
    sources({ 5: scError(502) });
    const res = await clone([5]);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SOUNDCLOUD_UNAVAILABLE');
    expect(res.body.error).toMatch(/nothing was changed/i);
    expect(res.body.errors).toEqual([{ id: 5, error: 'SoundCloud did not respond for this playlist.' }]);
    expect(createPlaylist).not.toHaveBeenCalled();
    expect(invalidatePlaylistState).not.toHaveBeenCalled();
  });

  test('read timeout is treated like a 502', async () => {
    sources({ 5: Object.assign(new Error('aborted'), { code: 'SC_TIMEOUT', status: 504 }) });
    const res = await clone([5]);
    expect(res.status).toBe(502);
  });

  test('an unclassified read failure keeps the generic text and a 400', async () => {
    sources({ 5: new Error('boom') });
    const res = await clone([5]);

    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([{ id: 5, error: 'Playlist could not be cloned. It may be private or unavailable.' }]);
  });

  test('a read failure after a created playlist keeps the 207 and uses the specific reason', async () => {
    sources({ 5: 50, 6: scError(404) });
    playlistsApi();
    const res = await clone([5, 6]);

    expect(res.status).toBe(207);
    expect(res.body.playlists).toHaveLength(1);
    expect(res.body.errors).toEqual([{ id: 6, error: 'This playlist no longer exists or is private.' }]);
  });

  test('a null read body (empty 2xx) is a per-item read failure, not an escape to the outer catch', async () => {
    getPlaylistWithTracks.mockImplementation(async (at, rt, id) => (
      id === 6 ? null : { id, title: 'Src 5', tracks: toTracks(range(50)) }
    ));
    playlistsApi();
    const res = await clone([5, 6]);

    expect(res.status).toBe(207);
    expect(res.body.playlists).toHaveLength(1);
    expect(res.body.errors).toEqual([{ id: 6, error: 'Playlist could not be cloned. It may be private or unavailable.' }]);
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
  });

  test('a null read body on its own is a 400 with the per-item reason', async () => {
    getPlaylistWithTracks.mockResolvedValue(null);
    const res = await clone([5]);

    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveLength(1);
  });

  test('a multi-chunk failure says how many parts were not attempted', async () => {
    sources({ 5: 1200 }); // chunks 500, 500, 200
    playlistsApi({ failPut: (id) => id === 90 });
    const res = await clone([5]);

    expect(res.body.errors[0].error).toMatch(/at least 100 of 500 tracks/);
    expect(res.body.errors[0].error).toMatch(/2 more parts were not attempted\.$/);
    expect(createPlaylist).toHaveBeenCalledTimes(1);
  });

  test('one part left untried is singular', async () => {
    sources({ 5: 501 }); // chunks 500, 1
    playlistsApi();
    createPlaylist.mockRejectedValueOnce(scError(502));
    const res = await clone([5]);

    expect(res.body.errors[0].error).toMatch(/1 more part was not attempted\.$/);
    expect(createPlaylist).toHaveBeenCalledTimes(1);
  });

  test('a throw that reaches the outer catch after a write never says nothing changed', async () => {
    // The real logOperation cannot throw; this pins the outer catch, which
    // must report the write it knows was attempted and refresh the list.
    sources({ 5: 50 });
    playlistsApi();
    logOperation.mockImplementationOnce(() => {
      throw Object.assign(new Error('boom'), { status: 503 });
    });
    const res = await clone([5]);

    expect(createPlaylist).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Some changes may have been made/);
    expect(res.body.error).not.toMatch(/Nothing was changed/);
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
  });

  test('NOT_FOLLOWED is still the 403, ahead of everything', async () => {
    getFollowings.mockResolvedValue([{ id: 222 }]);
    const res = await clone([5]);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Choose a user you follow to clone their public playlists.');
    expect(getPlaylistWithTracks).not.toHaveBeenCalled();
  });
});

describe('createPlaylistFromTrackIds stays byte-identical for other callers', () => {
  test('followed-likes overflow PUT failure: same status and body, no partialPlaylist leaking', async () => {
    getFollowings.mockResolvedValue([{ id: 999, username: 'friend' }]);
    const existing = range(450);
    getPlaylistWithTracks.mockResolvedValue({ id: 1, title: 'Target', track_count: existing.length, tracks: toTracks(existing) });
    createPlaylist.mockResolvedValue({ id: 99, title: 'Target (overflow 1)', permalink_url: 'x' });
    addTracksToPlaylist.mockImplementation(async (at, rt, id) => {
      if (id === 99) throw scError(502);
      return { id };
    });
    const res = await request(app)
      .post('/api/followings/999/likes/playlist')
      .send({ mode: 'selected', trackIds: range(260, 10000), targetPlaylistId: 1 });

    // Today's behaviour: this route has no upstream mapping, so a generic 500.
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to create playlist from followed user likes' });
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
    expect(JSON.stringify(res.body)).not.toMatch(/partial/i);
  });

  // The overflow playlist of an append is created by the same helper. Its
  // failure response must not grow a partialPlaylist or change wording.
  test('from-likes overflow PUT failure keeps today\'s response', async () => {
    const existing = range(450);
    const fresh = range(260, 10000);
    getPlaylistWithTracks.mockResolvedValue({ id: 1, title: 'Target', track_count: existing.length, tracks: toTracks(existing) });
    createPlaylist.mockResolvedValue({ id: 99, title: 'Target (overflow 1)', permalink_url: 'x' });
    addTracksToPlaylist.mockImplementation(async (at, rt, id) => {
      if (id === 99) throw scError(502);
      return { id };
    });
    const res = await request(app)
      .post('/api/playlists/from-likes')
      .send({ title: 'Likes', trackIds: fresh, targetPlaylistId: 1 });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      code: 'SOUNDCLOUD_UNAVAILABLE',
      error: 'SoundCloud stopped responding partway through. Some changes may have been made — check your playlists before trying again.',
    });
    expect(invalidatePlaylistState).toHaveBeenCalledWith('user-a');
  });
});
