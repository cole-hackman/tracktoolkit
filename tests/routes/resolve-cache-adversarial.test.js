import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Adversarial cases for the shared /api/resolve cache (C2): only a raw
 * resource with kind === 'user' or sharing === 'public' may be cached, on
 * every resolver path (OAuth, client-id public fallback) and both writers.
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
  authenticateUser: (req, res, next) => {
    const who = req.get('x-test-user') === 'b' ? 'b' : 'a';
    req.user = { id: `user-${who}`, soundcloudId: who === 'a' ? 111 : 222 };
    req.accessToken = `at-${who}`;
    req.refreshToken = `rt-${who}`;
    next();
  },
}));

const { default: apiRoutes } = await import('../../server/routes/api.js');
const {
  clearResolveCache, resolveCacheSize, setCachedResolve, isShareableResolve,
} = await import('../../server/lib/resolve-cache.js');

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);
// One server bound to 127.0.0.1 for the whole file. request(server) opens a fresh
// ephemeral port per request on all interfaces, and with a hundred-plus
// requests one occasionally lands on a port another local process holds on
// 127.0.0.1, which answers 404.
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
afterAll(() => new Promise((r) => server.close(r)));

afterAll(() => { process.env.NODE_ENV = ORIGINAL_NODE_ENV; });

const URL_A = 'https://soundcloud.com/owner-a/thing';

beforeEach(() => {
  clearResolveCache();
  resolveAny.mockReset();
  resolvePublic.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('isShareableResolve', () => {
  test.each([
    [{ kind: 'user', id: 1, username: 'u' }, true],
    [{ kind: 'track', id: 1, sharing: 'public' }, true],
    [{ kind: 'playlist', id: 1, sharing: 'public' }, true],
    [{ kind: 'track', id: 1, sharing: 'private' }, false],
    [{ kind: 'track', id: 1, sharing: 'Public' }, false],
    [{ kind: 'track', id: 1, sharing: ' public' }, false],
    [{ kind: 'track', id: 1, sharing: ['public'] }, false],
    [{ kind: 'track', id: 1, sharing: true }, false],
    [{ kind: 'track', id: 1 }, false],
    [{ kind: 'track', id: 1, sharing: 'private', secret_token: 's-abc' }, false],
    [{ track: { kind: 'track', id: 1, sharing: 'public' } }, false],
    [{ id: 1, username: 'no-kind-user' }, false],
    [{ kind: 'User', id: 1 }, false],
    [null, false],
    [undefined, false],
    ['user', false],
  ])('%j -> %s', (resource, expected) => {
    expect(isShareableResolve(resource)).toBe(expected);
  });
});

describe('private resources on the client-id public fallback', () => {
  test('/resolve: a private (secret-link) track from resolvePublic is not cached', async () => {
    resolveAny.mockRejectedValue(new Error('Resolve error: 401'));
    resolvePublic.mockResolvedValue({
      kind: 'track', id: 7, title: 'Secret', sharing: 'private', secret_token: 's-abc',
      user: { id: 111, username: 'owner-a' },
    });
    const a = await request(server).post('/api/resolve?v=2').send({ url: URL_A });
    expect(a.status).toBe(200);
    expect(a.body.meta.resolver_path).toBe('public_fallback');
    expect(resolveCacheSize()).toBe(0);
  });

  test('/resolve/batch: a private track from resolvePublic is not cached', async () => {
    const authErr = Object.assign(new Error('Resolve error: 401'), { status: 401 });
    resolveAny.mockRejectedValue(authErr);
    resolvePublic.mockResolvedValue({ kind: 'track', id: 7, title: 'Secret', sharing: 'private' });
    const a = await request(server).post('/api/resolve/batch').send({ urls: [URL_A] });
    expect(resolvePublic).toHaveBeenCalled();
    expect(a.body.results[0].status).toBe('ok');
    expect(resolveCacheSize()).toBe(0);
  });
});

describe('ambiguous sharing values are treated as private by both writers', () => {
  test.each([
    ['missing', undefined],
    ['capitalised', 'Public'],
    ['private', 'private'],
  ])('sharing %s: user B is asked upstream, not served A\'s copy', async (_l, sharing) => {
    const resource = { kind: 'playlist', id: 55, title: 'A only', track_count: 1, user: { id: 111 } };
    if (sharing !== undefined) resource.sharing = sharing;
    resolveAny.mockImplementation(async (token) => {
      if (token === 'at-a') return resource;
      throw new Error('Resolve error: 404');
    });

    await request(server).post('/api/resolve').send({ url: URL_A });
    await request(server).post('/api/resolve/batch').send({ urls: [URL_A] });
    expect(resolveCacheSize()).toBe(0);

    const b1 = await request(server).post('/api/resolve').set('x-test-user', 'b').send({ url: URL_A });
    expect(b1.status).toBe(404);
    const b2 = await request(server).post('/api/resolve/batch').set('x-test-user', 'b').send({ urls: [URL_A] });
    expect(b2.body.results[0].status).toBe('error');
    expect(JSON.stringify(b2.body)).not.toMatch(/A only/);
  });

  test('a wrapped { track } shape (normalizer fallback) is not cached even if the inner track is public', async () => {
    resolveAny.mockResolvedValue({ track: { kind: 'track', id: 9, title: 'Wrapped', sharing: 'public' } });
    const a = await request(server).post('/api/resolve').send({ url: URL_A });
    expect(a.body).toMatchObject({ type: 'track', id: 9 });
    expect(resolveCacheSize()).toBe(0);
  });
});

describe('cache-hit readers tolerate an entry not in the { v1, v2 } shape', () => {
  // The cache is in-memory and resets on deploy, so a pre-fix flat entry cannot
  // survive into this code. If one ever did, a hit must not crash the route.
  test('/resolve with a flat legacy entry does not 500', async () => {
    setCachedResolve(URL_A, { type: 'track', id: 1, title: 'legacy' });
    const v1 = await request(server).post('/api/resolve').send({ url: URL_A });
    const v2 = await request(server).post('/api/resolve?v=2').send({ url: URL_A });
    expect(v1.status).toBeLessThan(500);
    expect(v2.status).toBeLessThan(500);
  });

  test('/resolve/batch with a flat legacy entry does not 500', async () => {
    setCachedResolve(URL_A, { type: 'track', id: 1, title: 'legacy' });
    const res = await request(server).post('/api/resolve/batch?v=2').send({ urls: [URL_A] });
    expect(res.status).toBeLessThan(500);
  });
});

describe('residual leak outside this branch\'s scope', () => {
  // /resolve/batch still returns each failed item's raw err.message. resolveAny
  // refreshes and persists tokens on a 401, so a database failure there would
  // surface its Prisma text (DB host:port) per item — the same class as C7.
  // Marked test.failing: it passes while the leak exists and turns red once
  // the route sends fixed text, at which point drop the `.failing`.
  test.failing('/resolve/batch per-item errors do not carry raw internal error text', async () => {
    const dbDown = new Error("Can't reach database server at `db.internal:5432`");
    resolveAny.mockRejectedValue(dbDown);
    resolvePublic.mockRejectedValue(dbDown);
    const res = await request(server).post('/api/resolve/batch').send({ urls: [URL_A] });
    expect(JSON.stringify(res.body)).not.toMatch(/db\.internal|5432/);
  });
});
