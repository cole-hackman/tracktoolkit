import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const scRequest = jest.fn();
const getReposts = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: { scRequest, getReposts, getFollowings: jest.fn(), getFollowers: jest.fn() },
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
}));
jest.unstable_mockModule('../../server/lib/snapshot-cache.js', () => ({
  readSnapshot: jest.fn().mockResolvedValue(null),
  writeSnapshot: jest.fn().mockResolvedValue({ pages: 1, items: 1 }),
  invalidateSnapshot: jest.fn().mockResolvedValue({ count: 0 }),
  dropSnapshots: jest.fn(),
  SNAPSHOT_RESOURCES: ['likes', 'playlists', 'followings', 'followers', 'reposts'],
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

beforeEach(() => {
  requestCache.invalidateUser('user-a');
  scRequest.mockReset().mockResolvedValue({ collection: [{ id: 1 }], next_href: null });
  getReposts.mockReset();
});

afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

describe.each([
  ['/api/likes/paged', '/me/likes/tracks'],
  ['/api/followings/paged', '/me/followings'],
  ['/api/followers/paged', '/me/followers'],
])('%s', (route, endpoint) => {
  test('fetches one page from the matching SoundCloud endpoint', async () => {
    const res = await request(app).get(`${route}?limit=200`);
    expect(res.status).toBe(200);
    expect(res.body.collection).toEqual([{ id: 1 }]);
    // One round trip for a page — the whole point versus the full crawl.
    expect(scRequest).toHaveBeenCalledTimes(1);
    expect(scRequest.mock.calls[0][0]).toContain(endpoint);
    expect(scRequest.mock.calls[0][0]).toContain('limit=200');
  });

  test('accepts a 200-item page size', async () => {
    const res = await request(app).get(`${route}?limit=200`);
    expect(res.status).toBe(200);
  });

  test('rejects a page size above the SoundCloud maximum', async () => {
    const res = await request(app).get(`${route}?limit=500`);
    expect(res.status).toBe(400);
  });

  test('a next cursor from anywhere but this collection is refused, and SoundCloud is never called', async () => {
    // This used to assert the cursor's path and query were still sent
    // (`/steal?token=1`) — i.e. that any SoundCloud path was reachable with
    // the user's token. A cursor may now only continue this same collection
    // (lib/sc-cursor.js; tests/routes/cursor-injection.test.js).
    const res = await request(app).get(`${route}?next=${encodeURIComponent('https://evil.example.com/steal?token=1')}`);
    expect(res.status).toBe(400);
    expect(scRequest).not.toHaveBeenCalled();
  });

  test('a malformed next cursor is rejected', async () => {
    const res = await request(app).get(`${route}?next=not-a-url`);
    expect(res.status).toBe(400);
    expect(scRequest).not.toHaveBeenCalled();
  });
});

describe('/api/reposts/paged', () => {
  test('slices the assembled collection and reports whether more remain', async () => {
    getReposts.mockResolvedValue(Array.from({ length: 120 }, (_, i) => ({ id: i })));

    const first = await request(app).get('/api/reposts/paged?limit=50&offset=0');
    expect(first.status).toBe(200);
    expect(first.body.collection).toHaveLength(50);
    expect(first.body.total).toBe(120);
    expect(first.body.has_more).toBe(true);

    const last = await request(app).get('/api/reposts/paged?limit=50&offset=100');
    expect(last.body.collection).toHaveLength(20);
    expect(last.body.has_more).toBe(false);
  });

  test('the underlying crawl runs once across many pages', async () => {
    getReposts.mockResolvedValue(Array.from({ length: 300 }, (_, i) => ({ id: i })));
    await request(app).get('/api/reposts/paged?offset=0');
    await request(app).get('/api/reposts/paged?offset=50');
    await request(app).get('/api/reposts/paged?offset=100');
    expect(getReposts).toHaveBeenCalledTimes(1);
  });

  test('an out-of-range offset returns an empty page, not an error', async () => {
    getReposts.mockResolvedValue([{ id: 1 }]);
    const res = await request(app).get('/api/reposts/paged?offset=9999');
    expect(res.status).toBe(200);
    expect(res.body.collection).toEqual([]);
    expect(res.body.has_more).toBe(false);
  });

  test('a negative offset is rejected', async () => {
    const res = await request(app).get('/api/reposts/paged?offset=-5');
    expect(res.status).toBe(400);
  });
});
