import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Per-item errors in bulk responses used to be `err.message`: whatever the
 * thrown thing said went to the page. The errors below stand for any text a
 * thrower might carry.
 *
 * The client gets a fixed phrase chosen from the error's status/code. The
 * server log gets one line per run that had a failure, describing the first
 * one by name, code, status and (for the client's own fixed messages only)
 * message: see `safeErrorBrief`. The operation log's errorMessage keeps the
 * first raw message when no item succeeded, as before.
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
    req.accessToken = 'ACCESS-TOKEN-VALUE';
    req.refreshToken = 'REFRESH-TOKEN-VALUE';
    next();
  },
}));

const { default: apiRoutes } = await import('../../server/routes/api.js');
const { invalidationMarkCount, __resetCacheCoordinationForTests } = await import('../../server/lib/social-cache.js');

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

let warned;
/** Every console.warn line of the test, flattened to text. */
const warnings = () => warned.map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));

beforeEach(() => {
  logOperation.mockClear();
  for (const fn of [unlikeTrack, unfollowUser, likeTrack, deleteRepost, resolveAny, resolvePublic, getPlaylistWithTracks, addTracksToPlaylist]) {
    fn.mockReset();
  }
  warned = [];
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation((...args) => { warned.push(args); });
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

  test('it records it when no item succeeded, which includes a run whose other items were skipped', async () => {
    failInOrder(likeTrack, [() => scError(429)]);

    const res = await request(app).post('/api/likes/tracks/bulk-like').send({ trackIds: [1, 2, 3] });

    expect(res.body.results.map((r) => r.status)).toEqual(['error', 'skipped', 'skipped']);
    expect(logged('bulk-like').errorCode).toBe('RATE_LIMITED');
    expect(logged('bulk-like').errorMessage).toBe('API request failed: 429');
  });

  test('and the first failure\'s message, not a later one\'s', async () => {
    failInOrder(likeTrack, [() => scError(403), () => scError(500)]);

    await request(app).post('/api/likes/tracks/bulk-like').send({ trackIds: [1, 2] });

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
    failInOrder(deleteRepost, [() => scError(403), () => scError(500)]);

    await request(app).post('/api/reposts/bulk-remove').send({ items: items.slice(0, 2) });

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

  test('a failed target write is logged with the playlist and the error\'s code, not its text', async () => {
    addTracksToPlaylist.mockRejectedValueOnce(dbDown());

    await move();

    const lines = warned.filter((args) => args[0] === '[WARN] [playlist-transfer] target update failed');
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toEqual({ targetPlaylistId: '2', error: { name: 'Error', code: 'P1001' } });
    expect(warnings().join(' ')).not.toMatch(/db\.internal|5432/);
  });

  test('a failed source write is logged with both playlists and the error\'s status', async () => {
    addTracksToPlaylist.mockResolvedValueOnce({}).mockRejectedValueOnce(scError(500));

    await move();

    const lines = warned.filter((args) => args[0] === '[WARN] [playlist-transfer] source update failed after target update');
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toEqual({
      sourcePlaylistId: '1',
      targetPlaylistId: '2',
      error: { name: 'Error', status: '500', message: 'API request failed: 500' },
    });
    expect(warned.filter((args) => args[0] === '[WARN] [playlist-transfer] target update failed')).toEqual([]);
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

describe('a run with a failed item leaves a description of the first one in the server log', () => {
  // The operation log records a message only when no item succeeded, and the
  // response now carries fixed text, so without this line a run in which some
  // items failed would leave the reason nowhere.
  const RUNS = [
    { name: 'bulk-unlike', fn: unlikeTrack, send: () => request(app).post('/api/likes/tracks/bulk-unlike').send({ trackIds: [1, 2, 3] }) },
    { name: 'bulk-unfollow', fn: unfollowUser, send: () => request(app).post('/api/followings/bulk-unfollow').send({ userIds: [1, 2, 3] }) },
    { name: 'bulk-like', fn: likeTrack, send: () => request(app).post('/api/likes/tracks/bulk-like').send({ trackIds: [1, 2, 3] }) },
    {
      name: 'bulk-remove-reposts',
      fn: deleteRepost,
      send: () => request(app).post('/api/reposts/bulk-remove').send({ items: [1, 2, 3].map((id) => ({ id, resourceType: 'track' })) }),
    },
    { name: 'sort-likes-unlike', fn: unlikeTrack, send: () => request(app).post('/api/sort/unlike').send({ trackIds: [1, 2, 3] }) },
  ];

  test.each(RUNS)('$name: one line, with the first error and the count, and no token', async ({ name, fn, send }) => {
    failInOrder(fn, [null, () => scError(403), () => scError(500)]);

    const res = await send();

    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => r.status)).toEqual(['ok', 'error', 'error']);
    // One item succeeded, so the operation log has no message.
    expect(logged(name).errorMessage).toBeUndefined();
    const lines = warnings().filter((line) => /: items failed/.test(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('API request failed: 403');   // the first failure,
    expect(lines[0]).not.toContain('500');                   // not the last
    expect(lines[0]).toMatch(/"failed":"?2"?[,}]/);   // the logger prints numbers as text
    expect(lines[0]).not.toMatch(/ACCESS-TOKEN|REFRESH-TOKEN/);
    expect(warnings().filter((line) => line.includes('API request failed'))).toHaveLength(1);
  });

  test.each(RUNS)('$name: the line says which run it was', async ({ name, fn, send }) => {
    failInOrder(fn, [() => scError(403)]);

    await send();

    const what = {
      'bulk-unlike': 'Bulk unlike', 'bulk-unfollow': 'Bulk unfollow', 'bulk-like': 'Bulk like',
      'bulk-remove-reposts': 'Repost removal', 'sort-likes-unlike': 'Sort unlike',
    }[name];
    expect(warned.filter((args) => args[0] === `[WARN] ${what}: items failed`)).toHaveLength(1);
  });

  test.each(RUNS)('$name: nothing the thrower wrote is in the line', async ({ fn, send }) => {
    failInOrder(fn, [
      () => new TypeError('Headers.append: "OAuth 2-AB\0CDTOKEN" is an invalid header value.'),
      dbDown,
      netDown,
    ]);

    const res = await send();

    expect(res.status).toBe(200);
    const lines = warnings().filter((line) => /: items failed/.test(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('TypeError');
    for (const line of warnings()) expect(line).not.toMatch(/2-AB|CDTOKEN|OAuth|Headers\.append|db\.internal|soundcloud\.com|ENOTFOUND/);
  });

  test.each(RUNS)('$name: nothing is logged when every item succeeds', async ({ fn, send }) => {
    failInOrder(fn, []);

    await send();

    expect(warnings().filter((line) => /: items failed/.test(line))).toEqual([]);
  });

  test.each(RUNS)('$name: a thrown non-error is one failed item, not a 500', async ({ fn, send }) => {
    failInOrder(fn, [() => null]);

    const res = await send();

    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => r.status)).toEqual(['error', 'ok', 'ok']);
  });
});

describe('the summary line can neither fail the request nor skip what follows it', () => {
  const explode = () => { throw new Error('GETTER-TEXT'); };
  const HOSTILE = [
    ['an object with no prototype', () => Object.create(null)],
    ['throwing getters', () => Object.defineProperties({}, {
      name: { get: explode }, message: { get: explode }, code: { get: explode },
      status: { get: explode }, cause: { get: explode }, stack: { get: explode },
    })],
    ['a throwing toString', () => ({ toString: explode, valueOf: explode, [Symbol.toPrimitive]: explode })],
    ['a proxy that throws on every read', () => new Proxy({}, { get: explode, has: explode })],
  ];
  const RUNS = [
    { name: 'bulk-unlike', fn: unlikeTrack, mark: 'likes', send: () => request(app).post('/api/likes/tracks/bulk-unlike').send({ trackIds: [1, 2] }) },
    { name: 'bulk-unfollow', fn: unfollowUser, mark: 'followings', send: () => request(app).post('/api/followings/bulk-unfollow').send({ userIds: [1, 2] }) },
    { name: 'bulk-like', fn: likeTrack, mark: 'likes', send: () => request(app).post('/api/likes/tracks/bulk-like').send({ trackIds: [1, 2] }) },
    {
      name: 'bulk-remove-reposts',
      fn: deleteRepost,
      mark: 'reposts',
      send: () => request(app).post('/api/reposts/bulk-remove').send({ items: [1, 2].map((id) => ({ id, resourceType: 'track' })) }),
    },
    { name: 'sort-likes-unlike', fn: unlikeTrack, mark: 'likes', send: () => request(app).post('/api/sort/unlike').send({ trackIds: [1, 2] }) },
  ];
  const CASES = RUNS.flatMap((run) => HOSTILE.map(([what, make]) => ({ ...run, what, make })));

  let unhandled;
  const onUnhandled = (reason) => { unhandled.push(reason); };
  beforeEach(async () => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    await __resetCacheCoordinationForTests();
  });
  afterEach(() => process.off('unhandledRejection', onUnhandled));
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

  test.each(CASES)('$name, $what: 200, the operation logged, the cache invalidated', async ({ name, fn, make, send }) => {
    failInOrder(fn, [make]);

    const res = await send();
    await settle();

    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => r.status)).toEqual(['error', 'ok']);
    expect(logged(name)).toBeDefined();
    expect(logged(name).status).toBe('success');
    expect(invalidationMarkCount()).toBeGreaterThan(0);
    expect(warnings().filter((line) => /: items failed/.test(line))).toHaveLength(1);
    expect(warnings().join(' ')).not.toContain('GETTER-TEXT');
    expect(unhandled).toEqual([]);
  });

  test.each(CASES)('$name, $what, every item: the operation log gets the fallback text', async ({ name, fn, make, send }) => {
    failInOrder(fn, [make, make]);

    const res = await send();
    await settle();

    expect(res.status).toBe(200);
    expect(logged(name).status).toBe('error');
    if (name !== 'sort-likes-unlike') expect(logged(name).errorMessage).toMatch(/^(Unlike|Unfollow|Like|Remove) failed$/);
    expect(unhandled).toEqual([]);
  });

  test('repost removal: bookkeeping that throws after the response is logged, and is not a second response', async () => {
    failInOrder(deleteRepost, []);
    logOperation.mockImplementationOnce(() => { throw new Error('analytics down'); });
    const errors = [];
    console.error.mockImplementation((...args) => { errors.push(args); });

    const res = await request(app).post('/api/reposts/bulk-remove').send({ items: [{ id: 1, resourceType: 'track' }] });
    await settle();

    expect(res.status).toBe(200);
    expect(errors.filter((args) => args[0] === '[ERROR] Bulk unrepost error:')).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });

  test.each(RUNS)('$name: a console that throws changes nothing', async ({ name, fn, send }) => {
    failInOrder(fn, [() => scError(403)]);
    console.warn.mockImplementation(() => { throw new Error('EPIPE'); });

    const res = await send();
    await settle();

    expect(res.status).toBe(200);
    expect(logged(name)).toBeDefined();
    expect(invalidationMarkCount()).toBeGreaterThan(0);
    expect(unhandled).toEqual([]);
  });
});
