import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Cloning private playlists (your own, or someone else's via secret link) and
 * cloning every public like of a user. The properties pinned here:
 *  - a secret link's `s-…` token goes to SoundCloud as `secret_token` and is
 *    never written into the clone's description;
 *  - a copy of a private playlist is itself private, never public;
 *  - public clones are unchanged (same createPlaylist arguments as before);
 *  - cloning likes splits at 500 tracks the way likes-to-playlist does, and
 *    only for a profile the caller follows (or their own).
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const resolveAny = jest.fn();
const resolvePublic = jest.fn();
const getPlaylistWithTracks = jest.fn();
const getUserLikedTracks = jest.fn();
const getFollowings = jest.fn();
const addTracksToPlaylist = jest.fn();
const createPlaylist = jest.fn();
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
  soundcloudClient: { resolveAny, resolvePublic, getPlaylistWithTracks, getUserLikedTracks, addTracksToPlaylist, createPlaylist, getFollowings },
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation,
  startOperationTimer: () => () => 42,
  extractClientInfo: () => ({}),
  getAnalyticsWriteHealth: () => ({ status: 'ok' }),
  instrumentRead: () => (req, res, next) => next(),
}));
jest.unstable_mockModule('../../server/lib/enrichment.js', () => ({ piggybackEnrichment: jest.fn() }));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = { id: 'user-a', soundcloudId: 111 };
    req.accessToken = 'at';
    req.refreshToken = 'rt';
    next();
  },
}));

const actualCatalog = await import('../../server/lib/catalog.js');
const harvestTracks = jest.fn();
const harvestPlaylists = jest.fn();
jest.unstable_mockModule('../../server/lib/catalog.js', () => ({ ...actualCatalog, harvestTracks, harvestPlaylists }));

const { default: apiRoutes } = await import('../../server/routes/api.js');
const { heavyOperationRateLimiter } = await import('../../server/middleware/rateLimiter.js');
// Not mocked: the follow check reads the real per-user cache, so each test
// starts from a cold one.
const { requestCache } = await import('../../server/lib/request-cache.js');

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);

afterAll(() => { process.env.NODE_ENV = ORIGINAL_NODE_ENV; });

const range = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i);
const toTracks = (ids) => ids.map((id) => ({ id, streamable: true }));
const SECRET_URL = 'https://soundcloud.com/someone/sets/hidden-mix/s-AbC123xyz';

beforeEach(() => {
  requestCache.invalidateUser('user-a');
  // 321 is the profile the likes tests clone; following it is the default.
  getFollowings.mockReset().mockResolvedValue([{ id: 321 }]);
  resolveAny.mockReset();
  resolvePublic.mockReset();
  getPlaylistWithTracks.mockReset();
  getUserLikedTracks.mockReset();
  logOperation.mockClear();
  harvestTracks.mockClear();
  harvestPlaylists.mockClear();
  let next = 90;
  createPlaylist.mockReset().mockImplementation(async (at, rt, title) => {
    const id = next++;
    return { id, title, permalink_url: `https://sc/${id}` };
  });
  addTracksToPlaylist.mockReset().mockResolvedValue({ id: 1 });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('POST /api/playlists/clone with a secret link', () => {
  beforeEach(() => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 555 });
    getPlaylistWithTracks.mockResolvedValue({ id: 555, title: 'Hidden Mix', sharing: 'private', tracks: toTracks(range(30)) });
  });

  test('sends the token as secret_token and makes the copy private', async () => {
    const res = await request(app).post('/api/playlists/clone').send({ url: SECRET_URL });

    expect(res.status).toBe(200);
    expect(getPlaylistWithTracks).toHaveBeenCalledWith('at', 'rt', 555, { secretToken: 's-AbC123xyz' });
    expect(createPlaylist).toHaveBeenCalledTimes(1);
    const [, , title, description, initial, options] = createPlaylist.mock.calls[0];
    expect(title).toBe('Clone of Hidden Mix');
    expect(initial).toHaveLength(30);
    expect(options).toEqual({ sharing: 'private' });
    expect(res.body.stats.private).toBe(true);
  });

  test('never copies the secret token into the description', async () => {
    await request(app).post('/api/playlists/clone').send({ url: SECRET_URL });
    const description = createPlaylist.mock.calls[0][3];
    expect(description).toContain('Cloned from https://soundcloud.com/someone/sets/hidden-mix');
    expect(description).not.toContain('s-AbC123xyz');
  });

  test('a link copied from the share menu: canonical URL resolved, no token or tracking in the description', async () => {
    const shared = 'https://soundcloud.com/someone/sets/hidden-mix/s-AbC123xyz'
      + '?ref=clipboard&p=i&c=1&si=0123456789abcdef0123456789abcdef'
      + '&utm_source=clipboard&utm_medium=text&utm_campaign=social_sharing';
    const res = await request(app).post('/api/playlists/clone').send({ url: shared });

    expect(res.status).toBe(200);
    expect(resolveAny).toHaveBeenCalledWith('at', 'rt', SECRET_URL);
    expect(getPlaylistWithTracks).toHaveBeenCalledWith('at', 'rt', 555, { secretToken: 's-AbC123xyz' });
    const description = createPlaylist.mock.calls[0][3];
    expect(description).toContain('Cloned from https://soundcloud.com/someone/sets/hidden-mix');
    for (const leak of ['s-AbC123xyz', 'si=', 'utm_', 'ref=', 'clipboard', '0123456789abcdef']) {
      expect(description).not.toContain(leak);
    }
    const { req: _req, ...logged } = logOperation.mock.calls[0][0];
    expect(JSON.stringify(logged)).not.toContain('s-AbC123xyz');
  });

  test('a secret link to a 600-track playlist makes every part private', async () => {
    getPlaylistWithTracks.mockResolvedValue({ id: 555, title: 'Big', tracks: toTracks(range(600)) });
    const res = await request(app).post('/api/playlists/clone').send({ url: SECRET_URL });

    expect(res.status).toBe(200);
    expect(createPlaylist).toHaveBeenCalledTimes(2);
    for (const call of createPlaylist.mock.calls) {
      expect(call[5]).toEqual({ sharing: 'private' });
      expect(call[3]).not.toContain('s-AbC123xyz');
    }
  });
});

describe('POST /api/playlists/clone title', () => {
  beforeEach(() => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 8 });
    getPlaylistWithTracks.mockResolvedValue({ id: 8, title: 'Open', sharing: 'public', tracks: toTracks(range(3)) });
  });
  const clone = (body) => request(app).post('/api/playlists/clone').send({ url: 'https://soundcloud.com/a/sets/open', ...body });

  test('is stored as typed, not HTML-escaped, with control characters removed', async () => {
    const res = await clone({ title: '  Rock & Roll <Live>\u0007 ' });
    expect(res.status).toBe(200);
    expect(createPlaylist.mock.calls[0][2]).toBe('Rock & Roll <Live>');
  });

  test('an array, an over-long or an all-control-character title is a 400', async () => {
    expect((await clone({ title: ['x'] })).status).toBe(400);
    expect((await clone({ title: 'x'.repeat(201) })).status).toBe(400);
    expect((await clone({ title: '\u0001\u0002' })).status).toBe(400);
    expect(createPlaylist).not.toHaveBeenCalled();
  });
});

describe('POST /api/playlists/clone with an on.soundcloud.com short link', () => {
  const SHORT = 'https://on.soundcloud.com/AbCd1234';
  const resolvedWithToken = (token) => {
    const resource = { kind: 'playlist', id: 555, permalink_url: 'https://soundcloud.com/someone/sets/hidden-mix' };
    // What the client does: non-enumerable, read only by the route.
    if (token) Object.defineProperty(resource, 'secretToken', { value: token, enumerable: false });
    return resource;
  };

  test('the token found by the resolve reaches the playlist read; the copy is private', async () => {
    resolveAny.mockResolvedValue(resolvedWithToken('s-AbC123xyz'));
    getPlaylistWithTracks.mockResolvedValue({ id: 555, title: 'Hidden Mix', sharing: 'private', tracks: toTracks(range(4)) });
    const res = await request(app).post('/api/playlists/clone').send({ url: `${SHORT}?si=abc&utm_source=clipboard` });

    expect(res.status).toBe(200);
    expect(resolveAny).toHaveBeenCalledWith('at', 'rt', SHORT);
    expect(getPlaylistWithTracks).toHaveBeenCalledWith('at', 'rt', 555, { secretToken: 's-AbC123xyz' });
    const [, , , description, , options] = createPlaylist.mock.calls[0];
    expect(options).toEqual({ sharing: 'private' });
    // The short link opens the secret playlist, so it is not written either.
    expect(description).toContain('Cloned from https://soundcloud.com/someone/sets/hidden-mix');
    expect(description).not.toContain('on.soundcloud.com');
    expect(description).not.toContain('s-AbC123xyz');
  });

  test('a short link to a public playlist reads without a token', async () => {
    resolveAny.mockResolvedValue(resolvedWithToken(null));
    getPlaylistWithTracks.mockResolvedValue({ id: 555, title: 'Open', sharing: 'public', tracks: toTracks(range(2)) });
    const res = await request(app).post('/api/playlists/clone').send({ url: SHORT });

    expect(res.status).toBe(200);
    expect(getPlaylistWithTracks).toHaveBeenCalledWith('at', 'rt', 555, undefined);
  });
});

describe('POST /api/playlists/clone when SoundCloud refuses the source', () => {
  const scError = (status) => Object.assign(new Error(`API request failed: ${status}`), { status });
  const clone = (url) => request(app).post('/api/playlists/clone').send({ url });

  test.each([401, 403])('a %i read without a token asks for the secret link', async (status) => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 7 });
    getPlaylistWithTracks.mockRejectedValue(scError(status));
    const res = await clone('https://soundcloud.com/someone/sets/hidden-mix');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 'PLAYLIST_PRIVATE', error: 'This playlist is private. Paste its secret link (it ends in /s-…).' });
    expect(createPlaylist).not.toHaveBeenCalled();
  });

  test('a 403 from the resolve step (no status on the error) is read off the message', async () => {
    resolveAny.mockRejectedValue(new Error('Resolve error: 403'));
    const res = await clone('https://soundcloud.com/someone/sets/hidden-mix');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAYLIST_PRIVATE');
  });

  test.each([401, 403])('a %i read with a token says the link was refused', async (status) => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 555 });
    getPlaylistWithTracks.mockRejectedValue(scError(status));
    const res = await clone(SECRET_URL);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 'SECRET_LINK_REFUSED', error: 'SoundCloud refused that secret link — it may have been reset by the owner.' });
    expect(JSON.stringify(res.body)).not.toContain('AbC123xyz');
    expect(createPlaylist).not.toHaveBeenCalled();
  });

  test('a 404 with a token names the deleted-or-reset cause', async () => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 555 });
    getPlaylistWithTracks.mockRejectedValue(scError(404));
    const res = await clone(SECRET_URL);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PLAYLIST_NOT_FOUND');
    expect(res.body.error).toMatch(/reset the link/);
  });

  test('a 403 on a write is not mistaken for a private source', async () => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 8 });
    getPlaylistWithTracks.mockResolvedValue({ id: 8, title: 'Open', sharing: 'public', tracks: toTracks(range(3)) });
    createPlaylist.mockRejectedValue(scError(403));
    const res = await clone('https://soundcloud.com/a/sets/open');
    expect(res.body.code).not.toBe('PLAYLIST_PRIVATE');
  });
});

describe('the catalog never takes in someone else\'s private content', () => {
  const others = { id: 1, streamable: true, sharing: 'private', user: { id: 999 } };
  const mine = { id: 2, streamable: true, sharing: 'private', user: { id: 111 } };
  const open = { id: 3, streamable: true, sharing: 'public', user: { id: 999 } };

  test('a secret-link source is not harvested at all', async () => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 555 });
    getPlaylistWithTracks.mockResolvedValue({ id: 555, title: 'Hidden', sharing: 'private', user: { id: 999 }, tracks: [others, open] });
    const res = await request(app).post('/api/playlists/clone').send({ url: SECRET_URL });

    expect(res.status).toBe(200);
    expect(harvestTracks).not.toHaveBeenCalled();
    expect(harvestPlaylists).not.toHaveBeenCalled();
  });

  test('without a token, other people\'s private tracks are left out; your own and public ones go in', async () => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 7 });
    getPlaylistWithTracks.mockResolvedValue({ id: 7, title: 'Mine', sharing: 'private', user: { id: 111 }, tracks: [others, mine, open] });
    const res = await request(app).post('/api/playlists/clone').send({ url: 'https://soundcloud.com/me/sets/mine' });

    expect(res.status).toBe(200);
    expect(harvestTracks).toHaveBeenCalledWith([mine, open]);
    expect(harvestPlaylists).toHaveBeenCalledTimes(1);
  });

  test('someone else\'s private playlist read without a token is not harvested', async () => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 9 });
    getPlaylistWithTracks.mockResolvedValue({ id: 9, title: 'Theirs', sharing: 'private', user: { id: 999 }, tracks: [open] });
    await request(app).post('/api/playlists/clone').send({ url: 'https://soundcloud.com/x/sets/theirs' });
    expect(harvestPlaylists).not.toHaveBeenCalled();
  });

  test('cloned likes leave out private tracks that are not the caller\'s', async () => {
    resolveAny.mockResolvedValue({ kind: 'user', id: 321, username: 'Some DJ' });
    getUserLikedTracks.mockResolvedValue([others, open]);
    await request(app).post('/api/users/likes/clone').send({ url: 'https://soundcloud.com/some-dj' });
    expect(harvestTracks).toHaveBeenCalledWith([open]);
  });
});

describe('POST /api/playlists/clone of your own private playlist', () => {
  test('over 500 tracks, every part is private and the growing writes go to those parts', async () => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 7 });
    getPlaylistWithTracks.mockResolvedValue({ id: 7, title: 'Mine', sharing: 'private', tracks: toTracks(range(1100)) });

    const res = await request(app).post('/api/playlists/clone').send({ url: 'https://soundcloud.com/me/sets/mine' });

    expect(res.status).toBe(200);
    expect(createPlaylist.mock.calls.map((c) => [c[2], c[4].length, c[5]])).toEqual([
      ['Clone of Mine (1/3)', 100, { sharing: 'private' }],
      ['Clone of Mine (2/3)', 100, { sharing: 'private' }],
      ['Clone of Mine (3/3)', 100, { sharing: 'private' }],
    ]);
    // A PUT carries tracks only, so it cannot flip a part back to public.
    const lastWrite = (id) => addTracksToPlaylist.mock.calls.filter((c) => c[2] === id).at(-1)[3];
    expect([lastWrite(90).length, lastWrite(91).length]).toEqual([500, 500]);
    expect(addTracksToPlaylist.mock.calls.some((c) => c[2] === 92)).toBe(false); // 100 fit in the create
    expect(res.body.playlists).toHaveLength(3);
    expect(res.body.stats).toMatchObject({ totalTracks: 1100, numPlaylistsCreated: 3, private: true });
  });

  test('no token needed; the copy stays private', async () => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 7 });
    getPlaylistWithTracks.mockResolvedValue({ id: 7, title: 'Mine', sharing: 'private', tracks: toTracks(range(5)) });

    const res = await request(app).post('/api/playlists/clone').send({ url: 'https://soundcloud.com/me/sets/mine' });

    expect(res.status).toBe(200);
    expect(getPlaylistWithTracks).toHaveBeenCalledWith('at', 'rt', 7, undefined);
    expect(createPlaylist.mock.calls[0][5]).toEqual({ sharing: 'private' });
  });
});

describe('POST /api/playlists/clone of a public playlist is unchanged', () => {
  test('createPlaylist gets exactly the five arguments it always did', async () => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 8 });
    getPlaylistWithTracks.mockResolvedValue({ id: 8, title: 'Open', sharing: 'public', tracks: toTracks(range(5)) });

    const res = await request(app).post('/api/playlists/clone').send({ url: 'https://soundcloud.com/a/sets/open' });

    expect(res.status).toBe(200);
    expect(createPlaylist.mock.calls[0]).toHaveLength(5);
    expect(res.body.stats.private).toBeUndefined();
  });
});

describe('POST /api/users/likes/clone', () => {
  const clone = (body) => request(app).post('/api/users/likes/clone').send(body);
  const PROFILE = 'https://soundcloud.com/some-dj';

  beforeEach(() => {
    resolveAny.mockResolvedValue({ kind: 'user', id: 321, username: 'Some DJ' });
  });

  test('1,200 likes become three playlists of 500, 500 and 200, titled (n/3)', async () => {
    getUserLikedTracks.mockResolvedValue(toTracks(range(1200)));
    const res = await clone({ url: PROFILE });

    expect(res.status).toBe(200);
    expect(getUserLikedTracks).toHaveBeenCalledWith('at', 'rt', 321, 200);
    expect(res.body.playlists.map((p) => [p.title, p.trackCount])).toEqual([
      ['Some DJ Likes (1/3)', 500],
      ['Some DJ Likes (2/3)', 500],
      ['Some DJ Likes (3/3)', 200],
    ]);
    expect(res.body.stats).toMatchObject({ totalTracks: 1200, numPlaylistsCreated: 3, truncated: false });
    expect(logOperation).toHaveBeenCalledWith(expect.objectContaining({ action: 'clone-user-likes', status: 'split', trackCount: 1200 }));
  });

  test('500 or fewer likes make one playlist with the given title', async () => {
    getUserLikedTracks.mockResolvedValue(toTracks(range(40)));
    const res = await clone({ url: PROFILE, title: 'Best of' });

    expect(res.status).toBe(200);
    expect(createPlaylist).toHaveBeenCalledTimes(1);
    expect(res.body.playlist.title).toBe('Best of');
    expect(res.body.stats.numPlaylistsCreated).toBe(1);
  });

  test('blocked, non-streamable and duplicate likes are left out', async () => {
    getUserLikedTracks.mockResolvedValue([
      { id: 1, streamable: true },
      { id: 2, streamable: false },
      { id: 3, blocked_at: '2026-01-01' },
      { id: 1, streamable: true },
      { id: 4, streamable: true },
    ]);
    const res = await clone({ url: PROFILE });

    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({ fetchedTotal: 5, acceptedTotal: 2, totalTracks: 2 });
  });

  test('a crawl cut short is reported as truncated, not passed off as all likes', async () => {
    const tracks = toTracks(range(10));
    Object.defineProperty(tracks, 'truncated', { value: true });
    getUserLikedTracks.mockResolvedValue(tracks);
    const res = await clone({ url: PROFILE });

    expect(res.status).toBe(200);
    expect(res.body.stats.truncated).toBe(true);
  });

  test('a playlist link is refused with 400 and nothing is written', async () => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 1 });
    const res = await clone({ url: 'https://soundcloud.com/a/sets/x' });

    expect(res.status).toBe(400);
    expect(createPlaylist).not.toHaveBeenCalled();
  });

  test('a profile with no public likes is a 400', async () => {
    getUserLikedTracks.mockResolvedValue([]);
    const res = await clone({ url: PROFILE });

    expect(res.status).toBe(400);
    expect(createPlaylist).not.toHaveBeenCalled();
  });

  test('an unknown profile is a 404', async () => {
    resolveAny.mockRejectedValue(new Error('Resolve error: 404'));
    const res = await clone({ url: PROFILE });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  test('a profile the caller does not follow is a 403; nothing is crawled or written', async () => {
    getFollowings.mockResolvedValue([{ id: 222 }]);
    const res = await clone({ url: PROFILE });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_FOLLOWED');
    expect(res.body.error).toMatch(/someone you follow/i);
    expect(getUserLikedTracks).not.toHaveBeenCalled();
    expect(createPlaylist).not.toHaveBeenCalled();
    expect(logOperation).not.toHaveBeenCalled();
  });

  test('your own profile needs no follow', async () => {
    getFollowings.mockResolvedValue([]);
    resolveAny.mockResolvedValue({ kind: 'user', id: 111, username: 'Me' });
    getUserLikedTracks.mockResolvedValue(toTracks(range(3)));
    const res = await clone({ url: 'https://soundcloud.com/me' });

    expect(res.status).toBe(200);
    expect(getFollowings).not.toHaveBeenCalled();
  });

  test('rejects non-SoundCloud hosts, array urls and an empty body', async () => {
    expect((await clone({ url: 'https://example.com/x' })).status).toBe(400);
    expect((await clone({ url: [PROFILE] })).status).toBe(400);
    expect((await clone({})).status).toBe(400);
    expect(resolveAny).not.toHaveBeenCalled();
  });
});

describe('middleware order on both clone routes', () => {
  // A malformed or cross-site form post must die at the validator with a 400
  // before it can spend the caller's 20/hour heavy-operation budget.
  test.each(['/playlists/clone', '/users/likes/clone'])('%s validates before the rate limiter', (path) => {
    const layer = apiRoutes.stack.find((l) => l.route && l.route.path === path && l.route.methods.post);
    expect(layer).toBeDefined();
    const handles = layer.route.stack.map((s) => s.handle);
    const names = handles.map((h) => h.name);
    const validatorEnd = names.indexOf('handleValidationErrors');
    const limiter = handles.indexOf(heavyOperationRateLimiter);

    expect(names[0]).toBe('authenticateUser');
    expect(validatorEnd).toBeGreaterThan(0);
    expect(limiter).toBeGreaterThan(validatorEnd);
  });
});

describe('a failure after some playlists exist lists them instead of a bare 500', () => {
  const rateLimited = () => Object.assign(new Error('API request failed: 429'), { status: 429 });

  test('playlist clone: 429 on part 2 of 3 answers 429 with part 1 and the half-made part 2', async () => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 8 });
    getPlaylistWithTracks.mockResolvedValue({ id: 8, title: 'Big', sharing: 'public', tracks: toTracks(range(1100)) });
    // Part 1 fills (create + 4 PUTs); part 2 is created, then its first PUT is refused.
    addTracksToPlaylist.mockReset()
      .mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({})
      .mockRejectedValue(rateLimited());

    const res = await request(app).post('/api/playlists/clone').send({ url: 'https://soundcloud.com/a/sets/big' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('CLONE_PARTIAL');
    expect(res.body.playlists).toEqual([
      { id: 90, title: 'Clone of Big (1/3)', permalink_url: 'https://sc/90', trackCount: 500 },
      { id: 91, title: 'Clone of Big (2/3)', permalink_url: 'https://sc/91', trackCount: 100, incomplete: true },
    ]);
    expect(res.body.stats).toMatchObject({ partial: true, numPlaylistsCreated: 2, totalParts: 3 });
    expect(res.body.error).toMatch(/rate limit/i);
    expect(res.body.error).toContain('"Clone of Big (1/3)"');
    expect(res.body.error).toMatch(/new full copy/);
    expect(createPlaylist).toHaveBeenCalledTimes(2); // part 3 never attempted
  });

  test('playlist clone: a failure on the very first create is unchanged (nothing exists)', async () => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 8 });
    getPlaylistWithTracks.mockResolvedValue({ id: 8, title: 'Big', sharing: 'public', tracks: toTracks(range(600)) });
    createPlaylist.mockRejectedValue(rateLimited());
    const res = await request(app).post('/api/playlists/clone').send({ url: 'https://soundcloud.com/a/sets/big' });
    expect(res.body.code).not.toBe('CLONE_PARTIAL');
    expect(res.status).toBe(500);
  });

  test('likes clone: 429 creating part 3 lists parts 1 and 2', async () => {
    resolveAny.mockResolvedValue({ kind: 'user', id: 321, username: 'Some DJ' });
    getUserLikedTracks.mockResolvedValue(toTracks(range(1200)));
    createPlaylist.mockReset()
      .mockResolvedValueOnce({ id: 90, permalink_url: 'https://sc/90' })
      .mockResolvedValueOnce({ id: 91, permalink_url: 'https://sc/91' })
      .mockRejectedValue(rateLimited());

    const res = await request(app).post('/api/users/likes/clone').send({ url: 'https://soundcloud.com/some-dj' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('CLONE_PARTIAL');
    expect(res.body.playlists.map((p) => [p.title, p.trackCount])).toEqual([
      ['Some DJ Likes (1/3)', 500],
      ['Some DJ Likes (2/3)', 500],
    ]);
    expect(res.body.stats).toMatchObject({ partial: true, numPlaylistsCreated: 2, totalParts: 3 });
  });
});

describe('someone else\'s private tracks inside a secret playlist', () => {
  const refused = (status = 422) => Object.assign(new Error(`API request failed: ${status}`), { status });
  // 15 tracks; 3 are private and owned by somebody other than the caller (111).
  const othersPrivateIds = [4, 9, 13];
  const sourceTracks = (n = 15, privateIds = othersPrivateIds) => range(n).map((id) => (
    privateIds.includes(id)
      ? { id, streamable: true, sharing: 'private', user: { id: 999 } }
      : { id, streamable: true, sharing: 'public', user: { id: 999 } }
  ));
  // The source is 555; anything else is a copy being read back.
  const readsBack = (source, landedById = {}) => getPlaylistWithTracks.mockImplementation(async (at, rt, id) => (
    id === 555 ? source : { id, track_count: landedById[id] }
  ));
  const clone = () => request(app).post('/api/playlists/clone').send({ url: SECRET_URL });

  beforeEach(() => {
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 555 });
  });

  test('a refused create is retried once without them; the response counts what landed', async () => {
    readsBack({ id: 555, title: 'Hidden', sharing: 'private', track_count: 15, tracks: sourceTracks() }, { 90: 12 });
    createPlaylist.mockRejectedValueOnce(refused(422));

    const res = await clone();

    expect(res.status).toBe(200);
    expect(createPlaylist).toHaveBeenCalledTimes(2);
    expect(createPlaylist.mock.calls[0][4]).toHaveLength(15);
    const [, , title, , retried, options] = createPlaylist.mock.calls[1];
    expect(title).toBe('Clone of Hidden');
    expect(retried).toEqual(range(15).filter((id) => !othersPrivateIds.includes(id)));
    expect(options).toEqual({ sharing: 'private' });
    expect(res.body.playlist.id).toBe(90); // the refused create made nothing
    expect(res.body.stats).toMatchObject({
      sourceTracks: 15, copiedTracks: 12, verified: true, skippedPrivate: 3, totalTracks: 12, private: true,
    });
  });

  test('accepted as they are: no retry, no skippedPrivate', async () => {
    readsBack({ id: 555, title: 'Hidden', sharing: 'private', track_count: 15, tracks: sourceTracks() }, { 90: 15 });

    const res = await clone();

    expect(res.status).toBe(200);
    expect(createPlaylist).toHaveBeenCalledTimes(1);
    expect(res.body.stats).toMatchObject({ sourceTracks: 15, copiedTracks: 15, verified: true });
    expect(res.body.stats.skippedPrivate).toBeUndefined();
  });

  test('SoundCloud silently keeping fewer is reported from the read-back, not from what was sent', async () => {
    readsBack({ id: 555, title: 'Hidden', sharing: 'private', track_count: 15, tracks: sourceTracks() }, { 90: 12 });
    const res = await clone();
    expect(res.body.stats).toMatchObject({ sourceTracks: 15, copiedTracks: 12, totalTracks: 15, verified: true });
    expect(res.body.stats.skippedPrivate).toBeUndefined();
  });

  test('a refused PUT after the create refills the same playlist; no second playlist', async () => {
    const privateIds = [120, 121, 122];
    readsBack({ id: 555, title: 'Hidden', sharing: 'private', track_count: 150, tracks: sourceTracks(150, privateIds) }, { 90: 147 });
    addTracksToPlaylist.mockReset().mockRejectedValueOnce(refused(400)).mockResolvedValue({});

    const res = await clone();

    expect(res.status).toBe(200);
    expect(createPlaylist).toHaveBeenCalledTimes(1);
    const writes = addTracksToPlaylist.mock.calls;
    expect(writes.every((c) => c[2] === 90)).toBe(true);
    const last = writes.at(-1)[3];
    expect(last).toHaveLength(147);
    expect(last.some((id) => privateIds.includes(id))).toBe(false);
    expect(res.body.playlist.id).toBe(90);
    expect(res.body.stats).toMatchObject({ copiedTracks: 147, skippedPrivate: 3 });
  });

  test('a refusal with no such tracks to drop is not retried', async () => {
    readsBack({ id: 555, title: 'Hidden', sharing: 'private', tracks: sourceTracks(15, []) });
    createPlaylist.mockRejectedValue(refused(422));
    const res = await clone();
    expect(createPlaylist).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
  });

  test('a 429 is never read as a refusal of the private tracks', async () => {
    readsBack({ id: 555, title: 'Hidden', sharing: 'private', tracks: sourceTracks() });
    createPlaylist.mockRejectedValue(refused(429));
    await clone();
    expect(createPlaylist).toHaveBeenCalledTimes(1);
  });

  test('a read-back that fails reports the count as unverified', async () => {
    getPlaylistWithTracks.mockImplementation(async (at, rt, id) => {
      if (id === 555) return { id: 555, title: 'Hidden', sharing: 'private', tracks: sourceTracks() };
      throw refused(503);
    });
    const res = await clone();
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({ sourceTracks: 15, copiedTracks: 15, verified: false });
  });
});

describe('the private-track retry on a split copy', () => {
  test('a refused part 2 is recreated without them; part 1 stays; every part is private', async () => {
    const privateIds = [550, 551];
    resolveAny.mockResolvedValue({ kind: 'playlist', id: 555 });
    const tracks = range(600).map((id) => ({ id, streamable: true, sharing: privateIds.includes(id) ? 'private' : 'public', user: { id: 999 } }));
    getPlaylistWithTracks.mockImplementation(async (at, rt, id) => (
      id === 555 ? { id: 555, title: 'Big', sharing: 'private', tracks } : { id, track_count: id === 90 ? 500 : 98 }
    ));
    createPlaylist
      .mockImplementationOnce(async (at, rt, title) => ({ id: 90, title, permalink_url: 'https://sc/90' }))
      .mockRejectedValueOnce(Object.assign(new Error('API request failed: 422'), { status: 422 }))
      .mockImplementationOnce(async (at, rt, title) => ({ id: 91, title, permalink_url: 'https://sc/91' }));

    const res = await request(app).post('/api/playlists/clone').send({ url: SECRET_URL });

    expect(res.status).toBe(200);
    expect(createPlaylist.mock.calls.map((c) => [c[2], c[5]])).toEqual([
      ['Clone of Big (1/2)', { sharing: 'private' }],
      ['Clone of Big (2/2)', { sharing: 'private' }],
      ['Clone of Big (2/2)', { sharing: 'private' }],
    ]);
    expect(res.body.playlists.map((p) => p.id)).toEqual([90, 91]);
    expect(res.body.stats).toMatchObject({ sourceTracks: 600, copiedTracks: 598, skippedPrivate: 2, numPlaylistsCreated: 2 });
  });
});
