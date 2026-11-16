import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Sort Likes: POST /api/sort/apply (file one destination), POST
// /api/sort/unlike (unlike filed tracks), GET /api/tracks/:id/stream (the
// preview player's link). The invariants that matter:
//  - a track is reported as filed only once a write that holds it succeeded;
//  - an existing playlist is never written shorter than it was, never past
//    500, and one already over 500 is refused before any write;
//  - what does not fit goes to "<title> (2)", "(3)", …;
//  - validators run before the limiters (CSRF fail-closed, budget not spent).

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // pass-through limiters

const getPlaylistWithTracks = jest.fn();
const createPlaylist = jest.fn();
const addTracksToPlaylist = jest.fn();
const unlikeTrack = jest.fn();
const getStreamLink = jest.fn();
const logOperation = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: { getPlaylistWithTracks, createPlaylist, addTracksToPlaylist, unlikeTrack, getStreamLink },
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation,
  startOperationTimer: () => () => 42,
  extractClientInfo: () => ({}),
  getAnalyticsWriteHealth: () => ({ status: 'ok' }),
  instrumentRead: () => function instrumentedRead(req, res, next) { next(); },
}));
jest.unstable_mockModule('../../server/lib/catalog.js', () => ({ harvestTracks: jest.fn(), harvestPlaylists: jest.fn() }));
jest.unstable_mockModule('../../server/lib/enrichment.js', () => ({ piggybackEnrichment: jest.fn() }));
jest.unstable_mockModule('../../server/lib/snapshot-cache.js', () => ({
  readSnapshot: jest.fn().mockResolvedValue(null),
  writeSnapshot: jest.fn().mockResolvedValue({ pages: 1, items: 1 }),
  invalidateSnapshot: jest.fn().mockResolvedValue({ count: 0 }),
  dropSnapshots: jest.fn(),
  SNAPSHOT_RESOURCES: ['likes', 'playlists', 'followings', 'followers', 'reposts'],
}));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: function authenticateUser(req, res, next) {
    req.user = { id: 'user-a', soundcloudId: 111 };
    req.accessToken = 'at';
    req.refreshToken = 'rt';
    next();
  },
}));

const { default: apiRoutes } = await import('../../server/routes/api.js');
const { sortCommitLimiter, trackStreamLimiter } = await import('../../server/middleware/rateLimiter.js');
const { planSortApply, sortOverflowTitle } = await import('../../server/lib/sort-likes.js');

const app = express();
app.use(express.json()); // prod's only body parser
app.use(express.urlencoded({ extended: false })); // NOT in prod — here only to prove a form post still fails
app.use('/api', apiRoutes);

afterAll(() => { process.env.NODE_ENV = ORIGINAL_NODE_ENV; });

let nextPlaylistId = 900;
beforeEach(() => {
  for (const fn of [getPlaylistWithTracks, createPlaylist, addTracksToPlaylist, unlikeTrack, getStreamLink, logOperation]) fn.mockReset();
  nextPlaylistId = 900;
  createPlaylist.mockImplementation(async (_at, _rt, title) => {
    nextPlaylistId += 1;
    return { id: nextPlaylistId, permalink_url: `https://soundcloud.com/me/sets/${nextPlaylistId}`, title };
  });
  addTracksToPlaylist.mockResolvedValue({});
});

const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);
const playlistWith = (id, ids, extra = {}) => ({
  id, title: 'Tech House', permalink_url: `https://soundcloud.com/me/sets/${id}`,
  track_count: ids.length, tracks: ids.map((t) => ({ id: t })), ...extra,
});

describe('middleware order', () => {
  test.each([
    ['/sort/apply', 'post', () => sortCommitLimiter],
    ['/sort/unlike', 'post', () => sortCommitLimiter],
    ['/tracks/:id/stream', 'get', () => trackStreamLimiter],
  ])('%s: authenticateUser first, validator before the per-user limiter', (path, method, limiter) => {
    const layer = apiRoutes.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
    expect(layer).toBeDefined();
    const handles = layer.route.stack.map((s) => s.handle);
    expect(handles[0].name).toBe('authenticateUser');
    const validatorEnd = handles.findIndex((h) => h.name === 'handleValidationErrors');
    const limiterAt = handles.indexOf(limiter());
    expect(validatorEnd).toBeGreaterThan(-1);
    expect(limiterAt).toBeGreaterThan(validatorEnd);
  });
});

describe('planSortApply', () => {
  test('splits into already present, fits, and overflow chunks of 500', () => {
    const plan = planSortApply({ existingIds: range(1, 498), trackIds: [5, 1000, 1001, 1002, 1000] });
    expect(plan.alreadyPresent).toEqual([5]);
    expect(plan.intoTarget).toEqual([1000, 1001]);
    expect(plan.overflowChunks).toEqual([[1002]]);
  });

  test('a new playlist is the empty-existing case', () => {
    const plan = planSortApply({ existingIds: [], trackIds: range(1, 1200) });
    expect(plan.intoTarget).toHaveLength(500);
    expect(plan.overflowChunks.map((c) => c.length)).toEqual([500, 200]);
  });

  test('overflow titles start at (2)', () => {
    expect(sortOverflowTitle('Tech House', 0)).toBe('Tech House (2)');
    expect(sortOverflowTitle('Tech House', 1)).toBe('Tech House (3)');
  });
});

describe('POST /api/sort/apply — validation', () => {
  test('a cross-site form post parses to strings/empty and fails at the validator', async () => {
    const res = await request(app).post('/api/sort/apply').type('form').send('title=x&trackIds=1');
    expect(res.status).toBe(400);
    expect(createPlaylist).not.toHaveBeenCalled();
  });

  test('an empty body is refused', async () => {
    const res = await request(app).post('/api/sort/apply').send({});
    expect(res.status).toBe(400);
  });

  test('playlistId and title together are refused', async () => {
    const res = await request(app).post('/api/sort/apply').send({ playlistId: 5, title: 'x', trackIds: [1] });
    expect(res.status).toBe(400);
  });

  test('an array title is refused (express-validator applies element-wise)', async () => {
    const res = await request(app).post('/api/sort/apply').send({ title: ['Tech House'], trackIds: [1] });
    expect(res.status).toBe(400);
    expect(createPlaylist).not.toHaveBeenCalled();
  });

  test('title text is stored plain, not HTML-escaped', async () => {
    const res = await request(app).post('/api/sort/apply').send({ title: 'Drum & Bass <rollers>', trackIds: [1] });
    expect(res.status).toBe(200);
    expect(createPlaylist.mock.calls[0][2]).toBe('Drum & Bass <rollers>');
  });
});

describe('POST /api/sort/apply — new playlist', () => {
  test('creates it with the note as description and reports every track filed', async () => {
    const res = await request(app).post('/api/sort/apply').send({ title: 'Pop Remix', description: 'Warm-up only', trackIds: [3, 1, 2, 1] });
    expect(res.status).toBe(200);
    const [, , title, description, ids] = createPlaylist.mock.calls[0];
    expect(title).toBe('Pop Remix');
    expect(description).toContain('Warm-up only');
    expect(ids).toEqual([3, 1, 2]);
    expect(res.body.filedTrackIds).toEqual([3, 1, 2]);
    expect(res.body.playlists).toEqual([expect.objectContaining({ title: 'Pop Remix', trackCount: 3, created: true })]);
    expect(logOperation).toHaveBeenCalledWith(expect.objectContaining({ action: 'sort-likes-apply', status: 'success' }));
  });

  test('over 500 overflows into "<title> (2)"', async () => {
    const res = await request(app).post('/api/sort/apply').send({ title: 'Big', trackIds: range(1, 600) });
    expect(res.status).toBe(200);
    expect(createPlaylist.mock.calls.map((c) => c[2])).toEqual(['Big', 'Big (2)']);
    expect(res.body.playlists.map((p) => p.trackCount)).toEqual([500, 100]);
    expect(res.body.filedTrackIds).toHaveLength(600);
  }, 15000);
});

describe('POST /api/sort/apply — existing playlist', () => {
  test('appends only new tracks after the whole existing list; present ones count as filed', async () => {
    getPlaylistWithTracks.mockResolvedValueOnce(playlistWith(77, [10, 11, 10]));
    const res = await request(app).post('/api/sort/apply').send({ playlistId: 77, trackIds: [11, 12] });
    expect(res.status).toBe(200);
    expect(getPlaylistWithTracks).toHaveBeenCalledWith('at', 'rt', 77, { allAccess: true });
    expect(addTracksToPlaylist).toHaveBeenCalledTimes(1);
    expect(addTracksToPlaylist.mock.calls[0][3]).toEqual([10, 11, 10, 12]);
    expect(res.body).toEqual(expect.objectContaining({ added: 1, alreadyPresent: 1 }));
    expect(new Set(res.body.filedTrackIds)).toEqual(new Set([11, 12]));
  });

  test('nothing new: no write at all, still filed', async () => {
    getPlaylistWithTracks.mockResolvedValueOnce(playlistWith(77, [10, 11]));
    const res = await request(app).post('/api/sort/apply').send({ playlistId: 77, trackIds: [10] });
    expect(res.status).toBe(200);
    expect(addTracksToPlaylist).not.toHaveBeenCalled();
    expect(createPlaylist).not.toHaveBeenCalled();
    expect(res.body.filedTrackIds).toEqual([10]);
  });

  test('fills to 500, then overflows into "<title> (2)"', async () => {
    getPlaylistWithTracks.mockResolvedValueOnce(playlistWith(77, range(1, 498)));
    const res = await request(app).post('/api/sort/apply').send({ playlistId: 77, trackIds: [1000, 1001, 1002] });
    expect(res.status).toBe(200);
    const lastWrite = addTracksToPlaylist.mock.calls.at(-1)[3];
    expect(lastWrite).toHaveLength(500);
    expect(lastWrite.slice(0, 498)).toEqual(range(1, 498));
    expect(createPlaylist.mock.calls[0][2]).toBe('Tech House (2)');
    expect(createPlaylist.mock.calls[0][4]).toEqual([1002]);
    expect(res.body.filedTrackIds.sort()).toEqual([1000, 1001, 1002]);
  });

  test('a playlist already over 500 is refused before any write', async () => {
    getPlaylistWithTracks.mockResolvedValueOnce(playlistWith(77, range(1, 501)));
    const res = await request(app).post('/api/sort/apply').send({ playlistId: 77, trackIds: [9999] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAYLIST_TOO_LARGE');
    expect(addTracksToPlaylist).not.toHaveBeenCalled();
    expect(createPlaylist).not.toHaveBeenCalled();
  });

  test('a short read is refused before any write', async () => {
    getPlaylistWithTracks.mockResolvedValueOnce(playlistWith(77, [1, 2], { track_count: 3 }));
    const res = await request(app).post('/api/sort/apply').send({ playlistId: 77, trackIds: [9] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAYLIST_READ_INCOMPLETE');
    expect(addTracksToPlaylist).not.toHaveBeenCalled();
  });

  test('an overflow that fails after the target was written reports only what was written as filed', async () => {
    getPlaylistWithTracks.mockResolvedValueOnce(playlistWith(77, range(1, 499)));
    createPlaylist.mockRejectedValueOnce(Object.assign(new Error('SoundCloud API error: 503'), { status: 503 }));
    const res = await request(app).post('/api/sort/apply').send({ playlistId: 77, trackIds: [1000, 1001] });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('PARTIAL_APPLY');
    expect(res.body.filedTrackIds).toEqual([1000]);
    expect(res.body.playlists).toEqual([expect.objectContaining({ id: 77, trackCount: 1 })]);
  });

  test('a failed target write files nothing', async () => {
    getPlaylistWithTracks.mockResolvedValueOnce(playlistWith(77, [1]));
    addTracksToPlaylist.mockRejectedValueOnce(Object.assign(new Error('SoundCloud API error: 503'), { status: 503 }));
    const res = await request(app).post('/api/sort/apply').send({ playlistId: 77, trackIds: [2] });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.filedTrackIds).toBeUndefined();
  });
});

describe('POST /api/sort/unlike', () => {
  test('unlikes in order and stops at the first 429, returning the rest as skipped', async () => {
    unlikeTrack
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error('SoundCloud API error: 429'), { status: 429 }));
    const res = await request(app).post('/api/sort/unlike').send({ trackIds: [1, 2, 3, 4] });
    expect(res.status).toBe(200);
    expect(res.body.rateLimited).toBe(true);
    expect(res.body.results.map((r) => r.status)).toEqual(['ok', 'error', 'skipped', 'skipped']);
    expect(unlikeTrack).toHaveBeenCalledTimes(2);
    expect(unlikeTrack).toHaveBeenCalledWith('at', 'rt', 1);
  });

  test('more than 100 ids is refused', async () => {
    const res = await request(app).post('/api/sort/unlike').send({ trackIds: range(1, 101) });
    expect(res.status).toBe(400);
    expect(unlikeTrack).not.toHaveBeenCalled();
  });

  test('a form post fails closed', async () => {
    const res = await request(app).post('/api/sort/unlike').type('form').send('trackIds=1');
    expect(res.status).toBe(400);
    expect(unlikeTrack).not.toHaveBeenCalled();
  });
});

describe('GET /api/tracks/:id/stream', () => {
  test('returns the link, uncached', async () => {
    getStreamLink.mockResolvedValueOnce({ url: 'https://cf-media.sndcdn.com/a.mp3?Policy=x', format: 'mp3', preview: false });
    const res = await request(app).get('/api/tracks/42/stream');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.format).toBe('mp3');
    expect(getStreamLink).toHaveBeenCalledWith('at', 'rt', 42);
  });

  test('no stream is a 404 with a code the page can show', async () => {
    getStreamLink.mockRejectedValueOnce(Object.assign(new Error('none'), { code: 'NO_STREAM' }));
    const res = await request(app).get('/api/tracks/42/stream');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NO_STREAM');
  });

  test('a non-numeric id is refused', async () => {
    const res = await request(app).get('/api/tracks/abc/stream');
    expect(res.status).toBe(400);
    expect(getStreamLink).not.toHaveBeenCalled();
  });
});
