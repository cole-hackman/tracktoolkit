import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
// Pass-through limiters, one distinct function each, so the order test below
// can find them by identity.
process.env.NODE_ENV = 'development';

const searchTracks = jest.fn();
const resolveAny = jest.fn();
const getTracksByIds = jest.fn();
const createPlaylist = jest.fn();
const addTracksToPlaylist = jest.fn();
const logOperation = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: { searchTracks, resolveAny, getTracksByIds, createPlaylist, addTracksToPlaylist },
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation,
  startOperationTimer: () => () => 42,
  extractClientInfo: () => ({}),
  getAnalyticsWriteHealth: () => ({ status: 'ok' }),
  instrumentRead: () => function instrumentedRead(req, res, next) { next(); },
}));
jest.unstable_mockModule('../../server/lib/catalog.js', () => ({
  harvestTracks: jest.fn(),
  harvestPlaylists: jest.fn(),
}));
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
const { libraryReadRateLimiter, heavyOperationRateLimiter } = await import('../../server/middleware/rateLimiter.js');
const { SC_WRITE_PACING_MS } = await import('../../server/lib/pacing.js');

const app = express();
app.use(express.json()); // mirrors prod: express.json() is the ONLY body parser
app.use('/api', apiRoutes);

afterAll(() => { process.env.NODE_ENV = ORIGINAL_NODE_ENV; });

beforeEach(() => {
  for (const fn of [searchTracks, resolveAny, getTracksByIds, createPlaylist, addTracksToPlaylist, logOperation]) fn.mockReset();
});

const scTrack = (id, title, username = 'artist', extra = {}) => ({
  kind: 'track', id, title, user: { username }, duration: 200000, access: 'playable', permalink_url: `https://soundcloud.com/${username}/${id}`, ...extra,
});

describe('middleware order', () => {
  test.each([
    ['/setlists/match', 'libraryReadRateLimiter', () => libraryReadRateLimiter],
    ['/setlists/playlist', 'heavyOperationRateLimiter', () => heavyOperationRateLimiter],
  ])('%s validates before spending %s', (path, _name, limiter) => {
    const layer = apiRoutes.stack.find((l) => l.route && l.route.path === path && l.route.methods.post);
    expect(layer).toBeDefined();
    const handles = layer.route.stack.map((s) => s.handle);
    expect(handles[0].name).toBe('authenticateUser');
    const validatorEnd = handles.findIndex((h) => h.name === 'handleValidationErrors');
    const limiterAt = handles.indexOf(limiter());
    expect(validatorEnd).toBeGreaterThan(-1);
    expect(limiterAt).toBeGreaterThan(validatorEnd);
  });
});

describe('POST /api/setlists/match', () => {
  test('searches each query and resolves each URL, returning candidates by position', async () => {
    searchTracks.mockResolvedValueOnce({ collection: [scTrack(11, 'Strobe', 'deadmau5'), scTrack(12, 'Strobe (Dimension Remix)', 'deadmau5')] });
    resolveAny.mockResolvedValueOnce(scTrack(13, 'Love Desire', 'cassimmofficial'));

    const res = await request(app).post('/api/setlists/match').send({
      entries: [
        { position: 1, query: 'deadmau5 Strobe' },
        { position: 2, url: 'https://soundcloud.com/cassimmofficial/love-desire?utm_source=x' },
      ],
    });

    expect(res.status).toBe(200);
    expect(searchTracks).toHaveBeenCalledWith('at', 'rt', { q: 'deadmau5 Strobe', limit: 5 });
    expect(resolveAny).toHaveBeenCalledWith('at', 'rt', 'https://soundcloud.com/cassimmofficial/love-desire');
    expect(res.body.results).toEqual([
      { position: 1, candidates: [expect.objectContaining({ id: 11, access: 'playable' }), expect.objectContaining({ id: 12 })] },
      { position: 2, candidates: [expect.objectContaining({ id: 13, title: 'Love Desire', user: { username: 'cassimmofficial' } })] },
    ]);
  });

  test('a failing line reports its own error; the others still answer', async () => {
    searchTracks
      .mockRejectedValueOnce(Object.assign(new Error('SoundCloud API error: 503'), { status: 503 }))
      .mockResolvedValueOnce({ collection: [scTrack(21, 'Rova - Eyes On Me')] });
    resolveAny.mockRejectedValueOnce(Object.assign(new Error('Resolve error: 404'), { status: 404 }));

    const res = await request(app).post('/api/setlists/match').send({
      entries: [
        { position: 1, query: 'a' },
        { position: 2, query: 'Rova Eyes On Me' },
        { position: 3, url: 'https://soundcloud.com/gone/track' },
      ],
    });

    expect(res.status).toBe(200);
    const byPos = Object.fromEntries(res.body.results.map((r) => [r.position, r]));
    expect(byPos[1].error).toMatch(/did not answer/);
    expect(byPos[2].candidates.map((c) => c.id)).toEqual([21]);
    expect(byPos[3].error).toMatch(/Not found/);
  });

  test('a resolved link that is not a track is refused per line', async () => {
    resolveAny.mockResolvedValueOnce({ kind: 'playlist', id: 5 });
    const res = await request(app).post('/api/setlists/match').send({ entries: [{ position: 1, url: 'https://soundcloud.com/a/sets/b' }] });
    expect(res.body.results[0]).toEqual({ position: 1, candidates: [], error: 'That link is not a track' });
  });

  test.each([
    ['no entries', {}],
    ['too many entries', { entries: Array.from({ length: 26 }, (_, i) => ({ position: i + 1, query: 'x' })) }],
    ['neither query nor url', { entries: [{ position: 1 }] }],
    ['both query and url', { entries: [{ position: 1, query: 'x', url: 'https://soundcloud.com/a/b' }] }],
    ['query as an array', { entries: [{ position: 1, query: ['x'] }] }],
    ['a non-SoundCloud url', { entries: [{ position: 1, url: 'https://www.1001tracklists.com/tracklist/x.html' }] }],
  ])('400 for %s, with no SoundCloud call', async (_name, body) => {
    const res = await request(app).post('/api/setlists/match').send(body);
    expect(res.status).toBe(400);
    expect(searchTracks).not.toHaveBeenCalled();
    expect(resolveAny).not.toHaveBeenCalled();
  });

  test('a cross-site form post fails closed at the validator', async () => {
    const res = await request(app).post('/api/setlists/match').type('form').send('entries[0][position]=1&entries[0][query]=x');
    expect(res.status).toBe(400);
    expect(searchTracks).not.toHaveBeenCalled();
  });
});

describe('POST /api/setlists/playlist', () => {
  const body = (over = {}) => ({
    title: 'deadmau5 @ Red Rocks Night 2',
    sourceUrl: 'https://www.1001tracklists.com/tracklist/q1tg64k/x.html',
    tracks: [
      { id: 1, label: 'deadmau5 - Superliminal' },
      { id: 2, label: 'ARTBAT - Artefact' },
      { id: 1, label: 'deadmau5 - Superliminal' },
      { id: 3, label: 'De Staat - Witch Doctor' },
    ],
    ...over,
  });

  test('creates one playlist in set order; the description lists exactly what went in', async () => {
    // Track 2 was deleted between review and create.
    getTracksByIds.mockResolvedValueOnce([scTrack(1, 'Superliminal'), scTrack(3, 'Witch Doctor')]);
    createPlaylist.mockResolvedValueOnce({ id: 900, permalink_url: 'https://soundcloud.com/me/sets/x' });

    const res = await request(app).post('/api/setlists/playlist').send(body());

    expect(res.status).toBe(200);
    expect(getTracksByIds).toHaveBeenCalledWith('at', 'rt', [1, 2, 3]);
    const [, , title, description, ids] = createPlaylist.mock.calls[0];
    expect(title).toBe('deadmau5 @ Red Rocks Night 2');
    expect(ids).toEqual([1, 3]);
    expect(description).toBe(
      'deadmau5 - Superliminal\nDe Staat - Witch Doctor\n\n'
      + 'Tracklist: https://www.1001tracklists.com/tracklist/q1tg64k/x.html\n\n'
      + 'Created using Track Toolkit. Try it for free tracktoolkit.com',
    );
    expect(res.body).toEqual({
      playlist: { id: 900, title: 'deadmau5 @ Red Rocks Night 2', permalink_url: 'https://soundcloud.com/me/sets/x' },
      added: 2,
      missing: [{ id: 2, label: 'ARTBAT - Artefact' }],
      duplicates: [{ id: 1, label: 'deadmau5 - Superliminal' }],
      descriptionOmitted: 0,
    });
    expect(logOperation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'setlist-to-playlist',
      trackIds: [1, 3],
      playlistIds: [900],
      metadata: expect.objectContaining({ source: '1001tracklists', missing: 1, duplicates: 1 }),
    }));
  });

  test('a blocked track is reported, not added', async () => {
    getTracksByIds.mockResolvedValueOnce([scTrack(1, 'a'), scTrack(2, 'b', 'x', { access: 'blocked' }), scTrack(3, 'c')]);
    createPlaylist.mockResolvedValueOnce({ id: 901 });
    const res = await request(app).post('/api/setlists/playlist').send(body());
    expect(createPlaylist.mock.calls[0][4]).toEqual([1, 3]);
    expect(res.body.missing.map((m) => m.id)).toEqual([2]);
  });

  test('nothing available: 409 and no playlist', async () => {
    getTracksByIds.mockResolvedValueOnce([]);
    const res = await request(app).post('/api/setlists/playlist').send(body());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SETLIST_NOTHING_AVAILABLE');
    expect(createPlaylist).not.toHaveBeenCalled();
  });

  test('over 100 tracks: created with the first 100, then grown by a paced PUT', async () => {
    const tracks = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, label: `A${i + 1} - T` }));
    getTracksByIds.mockImplementation(async (_a, _r, ids) => ids.map((id) => scTrack(id, 'T')));
    const at = {};
    createPlaylist.mockImplementationOnce(async () => { at.create = Date.now(); return { id: 902 }; });
    addTracksToPlaylist.mockImplementationOnce(async () => { at.put = Date.now(); return {}; });

    const res = await request(app).post('/api/setlists/playlist').send(body({ tracks, sourceUrl: '' }));

    expect(res.status).toBe(200);
    expect(getTracksByIds).toHaveBeenCalledTimes(3); // 50 ids per read
    expect(createPlaylist.mock.calls[0][4]).toHaveLength(100);
    expect(addTracksToPlaylist).toHaveBeenCalledTimes(1);
    expect(addTracksToPlaylist.mock.calls[0][3]).toHaveLength(150);
    // A little slack for timer granularity.
    expect(at.put - at.create).toBeGreaterThanOrEqual(SC_WRITE_PACING_MS - 5);
    expect(res.body.added).toBe(150);
  });

  test('a failed PUT after the create says a partial playlist exists', async () => {
    const tracks = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, label: `A${i + 1} - T` }));
    getTracksByIds.mockImplementation(async (_a, _r, ids) => ids.map((id) => scTrack(id, 'T')));
    createPlaylist.mockResolvedValueOnce({ id: 903, permalink_url: 'https://soundcloud.com/me/sets/p' });
    addTracksToPlaylist.mockRejectedValueOnce(Object.assign(new Error('SoundCloud API error: 500'), { status: 500 }));

    const res = await request(app).post('/api/setlists/playlist').send(body({ tracks }));

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('PARTIAL_PLAYLIST');
    expect(res.body.partialPlaylist).toEqual(expect.objectContaining({ id: 903, tracksWritten: 100 }));
  });

  test.each([
    ['a missing title', { title: '' }],
    ['a title as an array', { title: ['x'] }],
    ['a source on another host', { sourceUrl: 'https://evil.example/tracklist' }],
    ['no tracks', { tracks: [] }],
    ['a non-numeric id', { tracks: [{ id: 'abc', label: 'A - B' }] }],
    ['a label as an array', { tracks: [{ id: 1, label: ['A - B'] }] }],
  ])('400 for %s, with no SoundCloud call', async (_name, over) => {
    const res = await request(app).post('/api/setlists/playlist').send(body(over));
    expect(res.status).toBe(400);
    expect(getTracksByIds).not.toHaveBeenCalled();
    expect(createPlaylist).not.toHaveBeenCalled();
  });

  test('labels and titles are stored as plain text, not HTML-escaped', async () => {
    getTracksByIds.mockResolvedValueOnce([scTrack(1, 'a')]);
    createPlaylist.mockResolvedValueOnce({ id: 904 });
    await request(app).post('/api/setlists/playlist').send(body({
      title: 'A & B <live>',
      sourceUrl: null,
      tracks: [{ id: 1, label: 'Secret Cinema & Egbert - Elementen' }],
    }));
    const [, , title, description] = createPlaylist.mock.calls[0];
    expect(title).toBe('A & B <live>');
    expect(description.startsWith('Secret Cinema & Egbert - Elementen\n\n')).toBe(true);
  });
});
