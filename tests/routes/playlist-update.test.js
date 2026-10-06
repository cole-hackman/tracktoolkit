import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const getPlaylistWithTracks = jest.fn();
const addTracksToPlaylist = jest.fn();
const getFollowings = jest.fn();
const createPlaylist = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: { getPlaylistWithTracks, addTracksToPlaylist, getFollowings, createPlaylist },
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

/**
 * A playlist the way SoundCloud serves it: `access` defaults to
 * playable,preview, so blocked tracks are left out of `tracks` while
 * `track_count` still counts them. `unreadable` entries never come back at
 * any access level (deleted/private).
 */
function installPlaylists(defs) {
  getPlaylistWithTracks.mockImplementation(async (at, rt, id, opts = {}) => {
    const def = defs[id];
    if (!def) throw new Error(`no playlist ${id}`);
    const all = def.tracks;
    const visible = all.filter((tr) => {
      if (tr.unreadable) return false;
      if (tr.access === 'blocked') return Boolean(opts.allAccess);
      return true;
    });
    return {
      id,
      title: def.title || `P${id}`,
      track_count: all.length,
      tracks: visible.map(({ id: tid }) => ({ id: tid })),
    };
  });
}

const t = (id, access = 'playable') => ({ id, access });

beforeEach(() => {
  requestCache.invalidateUser('user-a');
  getPlaylistWithTracks.mockReset();
  addTracksToPlaylist.mockReset().mockResolvedValue({ id: 1, title: 'ok' });
  getFollowings.mockReset();
  createPlaylist.mockReset();
});

describe('PUT /api/playlists/:id', () => {
  const steve = () => installPlaylists({
    1: { tracks: [t(10), t(11), t(12), t(13, 'preview'), t(14, 'blocked')] },
  });

  test("Steve's case: a playlist with a blocked track can be rewritten once the removals are declared", async () => {
    steve();
    const res = await request(app).put('/api/playlists/1').send({ tracks: [10, 11, 12], remove: [13, 14] });

    expect(res.status).toBe(200);
    expect(addTracksToPlaylist).toHaveBeenCalledTimes(1);
    expect(addTracksToPlaylist.mock.calls[0][2]).toBe(1);
    expect(addTracksToPlaylist.mock.calls[0][3]).toEqual([10, 11, 12]);
  });

  test('reads the playlist with all access levels', async () => {
    steve();
    await request(app).put('/api/playlists/1').send({ tracks: [10, 11, 12], remove: [13, 14] });
    expect(getPlaylistWithTracks.mock.calls[0][3]).toEqual({ allAccess: true });
  });

  test('a genuinely short read (a deleted track) is refused with PLAYLIST_READ_INCOMPLETE and nothing is written', async () => {
    installPlaylists({ 1: { tracks: [t(10), t(11), t(12), t(13), { id: 14, unreadable: true }] } });
    const res = await request(app).put('/api/playlists/1').send({ tracks: [10, 11, 12, 13] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAYLIST_READ_INCOMPLETE');
    expect(res.body.seen).toBe(4);
    expect(res.body.expected).toBe(5);
    expect(typeof res.body.error).toBe('string');
    expect(addTracksToPlaylist).not.toHaveBeenCalled();
  });

  test('dropping a track the client never named is refused with PLAYLIST_OUT_OF_SYNC', async () => {
    steve();
    const res = await request(app).put('/api/playlists/1').send({ tracks: [10, 11, 12, 13] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAYLIST_OUT_OF_SYNC');
    expect(res.body.undeclared).toBe(1);
    expect(addTracksToPlaylist).not.toHaveBeenCalled();
  });

  test('appending new ids is allowed without a remove list', async () => {
    steve();
    const res = await request(app).put('/api/playlists/1').send({ tracks: [10, 11, 12, 13, 14, 99] });

    expect(res.status).toBe(200);
    expect(addTracksToPlaylist.mock.calls[0][3]).toEqual([10, 11, 12, 13, 14, 99]);
  });

  test('ids in remove that the server never read are ignored', async () => {
    steve();
    const res = await request(app).put('/api/playlists/1').send({ tracks: [10, 11, 12], remove: [13, 14, 555] });
    expect(res.status).toBe(200);
  });

  test('an id in both tracks and remove is a 400', async () => {
    steve();
    const res = await request(app).put('/api/playlists/1').send({ tracks: [10, 11], remove: [11] });
    expect(res.status).toBe(400);
    expect(getPlaylistWithTracks).not.toHaveBeenCalled();
  });

  test.each([
    ['a string', 'nope'],
    ['an object', { 0: 13 }],
    ['non-integers', [1.5]],
    ['non-positive ids', [0]],
  ])('remove as %s is a 400', async (_label, remove) => {
    steve();
    const res = await request(app).put('/api/playlists/1').send({ tracks: [10, 11], remove });
    expect(res.status).toBe(400);
  });

  test('more than 500 ids in remove is a 400', async () => {
    steve();
    const remove = Array.from({ length: 501 }, (_, i) => 1000 + i);
    const res = await request(app).put('/api/playlists/1').send({ tracks: [10], remove });
    expect(res.status).toBe(400);
  });

  test('a form-encoded body fails closed with a 400 and touches nothing', async () => {
    steve();
    const res = await request(app)
      .put('/api/playlists/1')
      .type('form')
      .send({ tracks: '10', remove: '13' });
    expect(res.status).toBe(400);
    expect(addTracksToPlaylist).not.toHaveBeenCalled();
  });
});

describe('GET /api/playlists/:id', () => {
  test('?access=all reads with all access levels', async () => {
    installPlaylists({ 1: { tracks: [t(10), t(14, 'blocked')] } });
    const res = await request(app).get('/api/playlists/1?access=all');
    expect(res.status).toBe(200);
    expect(res.body.tracks.map((x) => x.id)).toEqual([10, 14]);
    expect(getPlaylistWithTracks.mock.calls[0][3]).toEqual({ allAccess: true });
  });

  test('without the parameter the read and response are unchanged', async () => {
    installPlaylists({ 1: { tracks: [t(10), t(14, 'blocked')] } });
    const res = await request(app).get('/api/playlists/1');
    expect(res.status).toBe(200);
    expect(res.body.tracks.map((x) => x.id)).toEqual([10]);
    const opts = getPlaylistWithTracks.mock.calls[0][3];
    expect(opts?.allAccess).toBeFalsy();
  });

  test('an unknown access value is a 400', async () => {
    installPlaylists({ 1: { tracks: [t(10)] } });
    const res = await request(app).get('/api/playlists/1?access=everything');
    expect(res.status).toBe(400);
  });
});

// The three writers that PUT a target's full list used to read it at the
// default access and silently delete its blocked tracks on every append.
describe('writers that append to an existing target keep its blocked tracks', () => {
  const target = () => ({ tracks: [t(10), t(11), t(14, 'blocked')], title: 'Target' });
  const shortTarget = () => ({ tracks: [t(10), t(11), { id: 14, unreadable: true }], title: 'Target' });

  const lastWrite = () => addTracksToPlaylist.mock.calls.at(-1);

  describe('POST /api/playlists/merge into an existing target', () => {
    const body = { sourcePlaylistIds: [2, 3], targetPlaylistId: 1 };
    const sources = { 2: { tracks: [t(20)] }, 3: { tracks: [t(21)] } };

    test('the write keeps the blocked track', async () => {
      installPlaylists({ 1: target(), ...sources });
      const res = await request(app).post('/api/playlists/merge').send(body);
      expect(res.status).toBe(200);
      expect(lastWrite()[2]).toBe(1);
      expect(lastWrite()[3]).toEqual([10, 11, 14, 20, 21]);
    });

    test('a short target read is a 409 and nothing is written', async () => {
      installPlaylists({ 1: shortTarget(), ...sources });
      const res = await request(app).post('/api/playlists/merge').send(body);
      expect(res.status).toBe(409);
      expect(typeof res.body.error).toBe('string');
      expect(addTracksToPlaylist).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/playlists/from-likes into an existing target', () => {
    const body = { trackIds: [30, 31], targetPlaylistId: 1 };

    test('the write keeps the blocked track', async () => {
      installPlaylists({ 1: target() });
      const res = await request(app).post('/api/playlists/from-likes').send(body);
      expect(res.status).toBe(200);
      expect(lastWrite()[3]).toEqual([10, 11, 14, 30, 31]);
    });

    test('a short target read is a 409 and nothing is written', async () => {
      installPlaylists({ 1: shortTarget() });
      const res = await request(app).post('/api/playlists/from-likes').send(body);
      expect(res.status).toBe(409);
      expect(addTracksToPlaylist).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/followings/:userId/likes/playlist into an existing target (createOrAppendTrackIds)', () => {
    const body = { mode: 'selected', trackIds: [40, 41], targetPlaylistId: 1 };

    beforeEach(() => {
      getFollowings.mockResolvedValue([{ id: 999, username: 'friend' }]);
    });

    test('the write keeps the blocked track', async () => {
      installPlaylists({ 1: target() });
      const res = await request(app).post('/api/followings/999/likes/playlist').send(body);
      expect(res.status).toBe(200);
      expect(lastWrite()[3]).toEqual([10, 11, 14, 40, 41]);
    });

    test('a short target read reaches the client as a 409 and nothing is written', async () => {
      installPlaylists({ 1: shortTarget() });
      const res = await request(app).post('/api/followings/999/likes/playlist').send(body);
      expect(res.status).toBe(409);
      expect(typeof res.body.error).toBe('string');
      expect(addTracksToPlaylist).not.toHaveBeenCalled();
    });
  });
});
