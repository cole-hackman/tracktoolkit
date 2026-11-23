import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Per-item errors in bulk responses used to be `err.message`. Every one of
 * these writes runs through scRequest, whose 401 path refreshes and persists
 * tokens, so a database failure there reaches the catch as a Prisma message
 * naming the database host and port, and a network failure names the upstream
 * URL. The client gets a fixed phrase chosen from the error's status/code; the
 * raw text stays in the server log and in the operation log's errorMessage.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ADMIN_IDS = process.env.ADMIN_IDS;
process.env.NODE_ENV = 'development'; // disables rate limiters
process.env.ADMIN_IDS = '111'; // /sort/unlike is admin-only

const unlikeTrack = jest.fn();
const unfollowUser = jest.fn();
const likeTrack = jest.fn();
const deleteRepost = jest.fn();
const resolveAny = jest.fn();
const resolvePublic = jest.fn();
const getPlaylistWithTracks = jest.fn();
const addTracksToPlaylist = jest.fn();
const logOperation = jest.fn();

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
  soundcloudClient: {
    unlikeTrack, unfollowUser, likeTrack, deleteRepost, resolveAny, resolvePublic,
    getPlaylistWithTracks, addTracksToPlaylist,
  },
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation,
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

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);

afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_ADMIN_IDS === undefined) delete process.env.ADMIN_IDS;
  else process.env.ADMIN_IDS = ORIGINAL_ADMIN_IDS;
});

const DB_DOWN = "Can't reach database server at `db.internal:5432`";
const NET_DOWN = 'request to https://api.soundcloud.com/likes/tracks/7?secret=abc failed, reason: getaddrinfo ENOTFOUND';
const LEAK = /db\.internal|5432|P1001|api\.soundcloud\.com|ENOTFOUND|secret|abc|API request failed|Resolve error|aborted/;

const dbDown = () => Object.assign(new Error(DB_DOWN), { code: 'P1001' });
const netDown = () => new Error(NET_DOWN);
const scError = (status) => Object.assign(new Error(`API request failed: ${status}`), { status });
const timeout = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError', code: 'SC_TIMEOUT', status: 504 });

const RATE_LIMITED = 'SoundCloud rate limit reached — try again later';
const NO_ANSWER = 'SoundCloud did not respond — try again later';
const NOT_FOUND = 'Not found on SoundCloud';

/** The n-th call rejects with errors[n]; a missing entry resolves. */
const failInOrder = (fn, errors) => {
  let call = 0;
  fn.mockReset().mockImplementation(async () => {
    const make = errors[call];
    call += 1;
    if (make) throw make();
    return {};
  });
};

const logged = (action) => logOperation.mock.calls.map((c) => c[0]).find((a) => a.action === action);

beforeEach(() => {
  logOperation.mockClear();
  for (const fn of [unlikeTrack, unfollowUser, likeTrack, deleteRepost, resolveAny, resolvePublic, getPlaylistWithTracks, addTracksToPlaylist]) {
    fn.mockReset();
  }
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe.each([
  { name: 'bulk-unlike', path: '/api/likes/tracks/bulk-unlike', body: (ids) => ({ trackIds: ids }), idKey: 'trackId', fn: unlikeTrack, label: 'Unlike failed' },
  { name: 'bulk-unfollow', path: '/api/followings/bulk-unfollow', body: (ids) => ({ userIds: ids }), idKey: 'userId', fn: unfollowUser, label: 'Unfollow failed' },
])('$name (runBulkDelete)', ({ name, path, body, idKey, fn, label }) => {
  test('each failed item carries fixed text, never the raw error message', async () => {
    failInOrder(fn, [dbDown, netDown, () => scError(403), timeout, () => scError(429)]);

    const res = await request(app).post(path).send(body([1, 2, 3, 4, 5]));

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { [idKey]: 1, status: 'error', error: label },
      { [idKey]: 2, status: 'error', error: label },
      { [idKey]: 3, status: 'error', error: label },
      { [idKey]: 4, status: 'error', error: NO_ANSWER },
      { [idKey]: 5, status: 'error', error: RATE_LIMITED },
    ]);
    expect(res.body.rateLimited).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
  });

  test('the operation log still records the first raw message', async () => {
    failInOrder(fn, [() => scError(403), () => scError(500)]);

    await request(app).post(path).send(body([1, 2]));

    expect(logged(name).errorCode).toBe('ALL_ITEMS_FAILED');
    expect(logged(name).errorMessage).toBe('API request failed: 403');
  });
});

describe('POST /api/likes/tracks/bulk-like', () => {
  test('each failed item carries fixed text, never the raw error message', async () => {
    failInOrder(likeTrack, [dbDown, netDown, () => scError(404), timeout, () => scError(429)]);

    const res = await request(app).post('/api/likes/tracks/bulk-like').send({ trackIds: [1, 2, 3, 4, 5, 6] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { trackId: 1, status: 'error', error: 'Like failed' },
      { trackId: 2, status: 'error', error: 'Like failed' },
      { trackId: 3, status: 'error', error: NOT_FOUND },
      { trackId: 4, status: 'error', error: NO_ANSWER },
      { trackId: 5, status: 'error', error: RATE_LIMITED },
      { trackId: 6, status: 'skipped' },
    ]);
    expect(res.body.rateLimited).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
  });

  test('the operation log still records the first raw message', async () => {
    failInOrder(likeTrack, [() => scError(403)]);

    await request(app).post('/api/likes/tracks/bulk-like').send({ trackIds: [1] });

    expect(logged('bulk-like').errorMessage).toBe('API request failed: 403');
  });
});

describe('POST /api/reposts/bulk-remove', () => {
  const items = [1, 2, 3, 4, 5].map((id) => ({ id, resourceType: 'track' }));

  test('each failed item carries fixed text, never the raw error message', async () => {
    failInOrder(deleteRepost, [dbDown, netDown, () => scError(404), timeout, () => scError(429)]);

    const res = await request(app).post('/api/reposts/bulk-remove').send({ items });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { id: 1, resourceType: 'track', status: 'error', error: 'Remove failed' },
      { id: 2, resourceType: 'track', status: 'error', error: 'Remove failed' },
      { id: 3, resourceType: 'track', status: 'error', error: NOT_FOUND },
      { id: 4, resourceType: 'track', status: 'error', error: NO_ANSWER },
      { id: 5, resourceType: 'track', status: 'error', error: RATE_LIMITED },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
  });

  test('the operation log still records the first raw message', async () => {
    failInOrder(deleteRepost, [() => scError(403)]);

    await request(app).post('/api/reposts/bulk-remove').send({ items: items.slice(0, 1) });

    expect(logged('bulk-remove-reposts').errorMessage).toBe('API request failed: 403');
  });
});

describe('POST /api/sort/unlike', () => {
  test('each failed item carries fixed text, never the raw error message', async () => {
    failInOrder(unlikeTrack, [dbDown, netDown, () => scError(404), timeout, () => scError(429)]);

    const res = await request(app).post('/api/sort/unlike').send({ trackIds: [1, 2, 3, 4, 5, 6] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { trackId: 1, status: 'error', error: 'Unlike failed' },
      { trackId: 2, status: 'error', error: 'Unlike failed' },
      { trackId: 3, status: 'error', error: NOT_FOUND },
      { trackId: 4, status: 'error', error: NO_ANSWER },
      { trackId: 5, status: 'error', error: RATE_LIMITED },
      { trackId: 6, status: 'skipped' },
    ]);
    expect(res.body.rateLimited).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
  });
});

describe('POST /api/resolve/batch', () => {
  const URLS = ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => `https://soundcloud.com/artist/${s}`);
  const byUrl = {
    [URLS[0]]: dbDown,
    [URLS[1]]: netDown,
    [URLS[2]]: () => new Error('Resolve error: 404'),
    [URLS[3]]: () => new Error('Resolve follow error: 403'),
    [URLS[4]]: () => new Error('Resolve error: 429'),
    [URLS[5]]: timeout,
  };
  const expected = [
    'Resolve failed',
    'Resolve failed',
    'Not found on SoundCloud, or private',
    'SoundCloud refused this link. It may be private',
    RATE_LIMITED,
    NO_ANSWER,
  ];

  beforeEach(() => {
    resolveAny.mockImplementation(async (_a, _r, url) => { throw byUrl[url](); });
    resolvePublic.mockImplementation(async (url) => { throw byUrl[url](); });
  });

  test.each([['v1', ''], ['v2', '?v=2']])('%s: each failed item carries fixed text', async (_v, query) => {
    const res = await request(app).post(`/api/resolve/batch${query}`).send({ urls: URLS });

    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => [r.url, r.status, r.error])).toEqual(
      URLS.map((url, i) => [url, 'error', expected[i]]),
    );
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
  });

  test('the operation log still records the first raw message', async () => {
    await request(app).post('/api/resolve/batch').send({ urls: [URLS[2]] });

    expect(logged('batch-resolve').errorCode).toBe('ALL_ITEMS_FAILED');
    expect(logged('batch-resolve').errorMessage).toBe('Resolve error: 404');
  });
});

describe('POST /api/playlists/transfer-track (move)', () => {
  const playlists = {
    1: { id: 1, title: 'Source', track_count: 2, tracks: [{ id: 10 }, { id: 11 }] },
    2: { id: 2, title: 'Target', track_count: 1, tracks: [{ id: 20 }] },
  };
  const move = () => request(app).post('/api/playlists/transfer-track').send({
    action: 'move', trackId: 10, sourcePlaylistId: 1, targetPlaylistId: 2,
  });

  beforeEach(() => {
    getPlaylistWithTracks.mockImplementation(async (_a, _r, id) => playlists[id]);
  });

  test('a failed target write answers fixed text', async () => {
    addTracksToPlaylist.mockRejectedValueOnce(dbDown());

    const res = await move();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'Failed to update target playlist', stage: 'target_update' });
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
  });

  test('a rate-limited target write says so in fixed text', async () => {
    addTracksToPlaylist.mockRejectedValueOnce(scError(429));

    const res = await move();

    expect(res.body.error).toBe(RATE_LIMITED);
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
  });

  test('a failed source write (partial move) answers fixed text and keeps its fields', async () => {
    addTracksToPlaylist.mockResolvedValueOnce({}).mockRejectedValueOnce(netDown());

    const res = await move();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      partial: true,
      stage: 'source_update',
      targetUpdated: true,
      trackId: 10,
      error: 'Failed to remove track from source playlist',
    });
    expect(res.body.message).toMatch(/could not be removed from the source playlist/);
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
  });
});
