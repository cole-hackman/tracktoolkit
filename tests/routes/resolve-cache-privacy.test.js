import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * The /api/resolve cache is process-global and keyed by URL alone, so anything
 * it stores is served to every later caller without asking SoundCloud. A
 * resource only one user's token can see (a private track or playlist) must
 * therefore never enter it: user B asking for user A's private URL has to get
 * SoundCloud's own answer for B's token, not A's cached copy.
 *
 * Covers both writers (/resolve and /resolve/batch) and the batch cache-hit
 * path, which used to run normalizeResourceV2 on an already-normalized v1
 * object and so labelled every cached track and playlist `user`.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const resolveAny = jest.fn();
const resolvePublic = jest.fn();

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
  soundcloudClient: { resolveAny, resolvePublic },
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation: jest.fn(),
  startOperationTimer: () => () => 0,
  extractClientInfo: () => ({}),
  getAnalyticsWriteHealth: () => ({ status: 'ok' }),
  instrumentRead: () => (req, res, next) => next(),
}));
jest.unstable_mockModule('../../server/lib/enrichment.js', () => ({
  piggybackEnrichment: jest.fn(),
}));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  // The caller is chosen per request with x-test-user, so one app can play
  // both the owner (A) and a stranger (B).
  authenticateUser: (req, res, next) => {
    const who = req.get('x-test-user') === 'b' ? 'b' : 'a';
    req.user = { id: `user-${who}`, soundcloudId: who === 'a' ? 111 : 222 };
    req.accessToken = `at-${who}`;
    req.refreshToken = `rt-${who}`;
    next();
  },
}));

const { default: apiRoutes } = await import('../../server/routes/api.js');
const { clearResolveCache, resolveCacheSize } = await import('../../server/lib/resolve-cache.js');

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);

afterAll(() => { process.env.NODE_ENV = ORIGINAL_NODE_ENV; });

const PRIVATE_URL = 'https://soundcloud.com/owner-a/private-demo';
const PUBLIC_TRACK_URL = 'https://soundcloud.com/artist/public-track';
const PUBLIC_SET_URL = 'https://soundcloud.com/artist/sets/public-set';
const USER_URL = 'https://soundcloud.com/artist';

// Raw upstream shapes, as /resolve returns them: tracks and playlists carry
// `sharing`, users do not.
const privateTrack = {
  kind: 'track', id: 900, title: 'Unreleased demo', sharing: 'private',
  user: { id: 111, username: 'owner-a' }, permalink_url: PRIVATE_URL,
};
const publicTrack = {
  kind: 'track', id: 901, title: 'Out now', sharing: 'public',
  user: { id: 333, username: 'artist' }, permalink_url: PUBLIC_TRACK_URL, genre: 'House',
};
const publicPlaylist = {
  kind: 'playlist', id: 902, title: 'Public set', sharing: 'public', track_count: 2,
  user: { id: 333, username: 'artist' }, permalink_url: PUBLIC_SET_URL,
};
const userResource = {
  kind: 'user', id: 333, username: 'artist', followers_count: 10, permalink_url: USER_URL,
};

function upstream(url, token) {
  if (url === PRIVATE_URL) {
    // Only the owner's token can see it; anyone else gets SoundCloud's 404.
    if (token === 'at-a') return privateTrack;
    throw new Error('Resolve error: 404');
  }
  if (url === PUBLIC_TRACK_URL) return publicTrack;
  if (url === PUBLIC_SET_URL) return publicPlaylist;
  if (url === USER_URL) return userResource;
  throw new Error('Resolve error: 404');
}

beforeEach(() => {
  clearResolveCache();
  resolveAny.mockReset().mockImplementation(async (token, _rt, url) => upstream(url, token));
  resolvePublic.mockReset().mockImplementation(async (url) => upstream(url, null));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('/api/resolve — private resources never enter the shared cache', () => {
  test("user B gets 404 for a private URL user A resolved first", async () => {
    const a = await request(app).post('/api/resolve').send({ url: PRIVATE_URL });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ type: 'track', id: 900 });

    const b = await request(app).post('/api/resolve').set('x-test-user', 'b').send({ url: PRIVATE_URL });
    expect(b.status).toBe(404);
    expect(b.body).not.toHaveProperty('title');
    expect(resolveAny).toHaveBeenLastCalledWith('at-b', 'rt-b', PRIVATE_URL);
  });

  test('the GET form and v2 are covered by the same guard', async () => {
    await request(app).get('/api/resolve').query({ url: PRIVATE_URL, v: '2' });
    const b = await request(app).get('/api/resolve').set('x-test-user', 'b').query({ url: PRIVATE_URL, v: '2' });
    expect(b.status).toBe(404);
  });

  test('a resource with no `sharing` field is not cached (unknown means private)', async () => {
    resolveAny.mockImplementation(async () => ({ kind: 'track', id: 5, title: 'Old shape' }));
    await request(app).post('/api/resolve').send({ url: PUBLIC_TRACK_URL });
    expect(resolveCacheSize()).toBe(0);
  });

  test('a public track is still served from the cache to another user', async () => {
    await request(app).post('/api/resolve').send({ url: PUBLIC_TRACK_URL });
    expect(resolveAny).toHaveBeenCalledTimes(1);

    const b = await request(app).post('/api/resolve').set('x-test-user', 'b').send({ url: PUBLIC_TRACK_URL });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ type: 'track', id: 901, title: 'Out now' });
    expect(resolveAny).toHaveBeenCalledTimes(1);
  });

  test('a user profile (no `sharing` field upstream) is still cached', async () => {
    await request(app).post('/api/resolve').send({ url: USER_URL });
    const b = await request(app).post('/api/resolve').set('x-test-user', 'b').send({ url: USER_URL });
    expect(b.body).toMatchObject({ type: 'user', id: 333 });
    expect(resolveAny).toHaveBeenCalledTimes(1);
  });

  test('a v2 cache hit keeps the resource kind', async () => {
    await request(app).post('/api/resolve?v=2').send({ url: PUBLIC_TRACK_URL });
    const hit = await request(app).post('/api/resolve?v=2').send({ url: PUBLIC_TRACK_URL });
    expect(hit.body.meta).toMatchObject({ cached: true });
    expect(hit.body.data).toMatchObject({ type: 'track', kind: 'track', id: 901, genre: 'House' });
  });
});

describe('/api/resolve/batch — same guard, and correct v2 cache hits', () => {
  test("user B gets an error for a private URL user A batch-resolved first", async () => {
    const a = await request(app).post('/api/resolve/batch').send({ urls: [PRIVATE_URL] });
    expect(a.body.results[0]).toMatchObject({ status: 'ok', data: { id: 900 } });

    const b = await request(app).post('/api/resolve/batch').set('x-test-user', 'b').send({ urls: [PRIVATE_URL] });
    expect(b.body.results[0].status).toBe('error');
    expect(b.body.results[0]).not.toHaveProperty('data');
    expect(resolveAny).toHaveBeenLastCalledWith('at-b', 'rt-b', PRIVATE_URL);
  });

  test('a private URL cached by /resolve cannot leak through /resolve/batch either', async () => {
    await request(app).post('/api/resolve').send({ url: PRIVATE_URL });
    const b = await request(app).post('/api/resolve/batch').set('x-test-user', 'b').send({ urls: [PRIVATE_URL] });
    expect(b.body.results[0].status).toBe('error');
  });

  test('public resources are still served from the cache to another user', async () => {
    await request(app).post('/api/resolve/batch').send({ urls: [PUBLIC_TRACK_URL, PUBLIC_SET_URL] });
    expect(resolveAny).toHaveBeenCalledTimes(2);

    const b = await request(app).post('/api/resolve/batch').set('x-test-user', 'b')
      .send({ urls: [PUBLIC_TRACK_URL, PUBLIC_SET_URL] });
    expect(b.body.results.map((r) => r.data.type)).toEqual(['track', 'playlist']);
    expect(resolveAny).toHaveBeenCalledTimes(2);
  });

  test('a v2 batch cache hit is labelled with the real kind, not `user`', async () => {
    const miss = await request(app).post('/api/resolve/batch?v=2').send({ urls: [PUBLIC_TRACK_URL, PUBLIC_SET_URL] });
    const hit = await request(app).post('/api/resolve/batch?v=2').send({ urls: [PUBLIC_TRACK_URL, PUBLIC_SET_URL] });
    expect(resolveAny).toHaveBeenCalledTimes(2);

    expect(hit.body.results.map((r) => r.data.kind)).toEqual(['track', 'playlist']);
    expect(hit.body.results.map((r) => r.data.type)).toEqual(['track', 'playlist']);
    // Same payload whether it came from SoundCloud or from the cache.
    expect(hit.body.results.map((r) => r.data)).toEqual(miss.body.results.map((r) => r.data));
  });

  test('a v1 response after a v2 cache fill is still the v1 shape', async () => {
    await request(app).post('/api/resolve/batch?v=2').send({ urls: [PUBLIC_TRACK_URL] });
    const v1 = await request(app).post('/api/resolve/batch').send({ urls: [PUBLIC_TRACK_URL] });
    expect(v1.body.results[0].data).toMatchObject({ type: 'track', id: 901 });
    expect(v1.body.results[0].data).not.toHaveProperty('kind');
  });
});
