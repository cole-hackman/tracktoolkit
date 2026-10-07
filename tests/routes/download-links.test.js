import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ALLOWLIST = process.env.DOWNLOAD_ALLOWLIST;
process.env.NODE_ENV = 'development'; // disables rate limiters
process.env.DOWNLOAD_ALLOWLIST = '111';

const getDownloadLink = jest.fn();
const logOperation = jest.fn();
const sleep = jest.fn(async () => {});
let currentUser = { id: 'user-a', soundcloudId: 111 };

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: { getDownloadLink },
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
const realPacing = await import('../../server/lib/pacing.js');
jest.unstable_mockModule('../../server/lib/pacing.js', () => ({ ...realPacing, sleep }));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = currentUser;
    req.accessToken = 'at';
    req.refreshToken = 'rt';
    next();
  },
}));

const { default: apiRoutes } = await import('../../server/routes/api.js');
const { SC_WRITE_PACING_MS } = realPacing;

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);

afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_ALLOWLIST === undefined) delete process.env.DOWNLOAD_ALLOWLIST;
  else process.env.DOWNLOAD_ALLOWLIST = ORIGINAL_ALLOWLIST;
});

const url = (n) => `https://api.soundcloud.com/tracks/soundcloud:tracks:${n}/download`;
const cdn = (n) => `https://cf-media.sndcdn.com/${n}.mp3?Policy=x`;
const post = (body) => request(app).post('/api/downloads/links').send(body);

beforeEach(() => {
  currentUser = { id: 'user-a', soundcloudId: 111 };
  getDownloadLink.mockReset();
  logOperation.mockReset();
  sleep.mockClear();
});

describe('POST /api/downloads/links', () => {
  test('is refused server-side for an account not on the allowlist, before any SoundCloud call', async () => {
    currentUser = { id: 'user-b', soundcloudId: 222 };
    const res = await post({ urls: [url(1)] });
    expect(res.status).toBe(403);
    expect(getDownloadLink).not.toHaveBeenCalled();
  });

  test('returns a CDN link per track, paced between calls (not before the first)', async () => {
    getDownloadLink.mockImplementation(async (at, rt, u) => ({ redirect: cdn(u.match(/(\d+)\/download/)[1]) }));
    const res = await post({ urls: [url(1), url(2), url(3)] });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => [r.trackId, r.status, r.link])).toEqual([
      [1, 'ok', cdn(1)],
      [2, 'ok', cdn(2)],
      [3, 'ok', cdn(3)],
    ]);
    expect(sleep.mock.calls).toEqual([[SC_WRITE_PACING_MS], [SC_WRITE_PACING_MS]]);
    expect(logOperation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'download-links', status: 'success', trackIds: [1, 2, 3],
    }));
  });

  test('stops at the first 429 and hands the rest back as rate_limited — no retry loop', async () => {
    getDownloadLink
      .mockResolvedValueOnce({ redirect: cdn(1) })
      .mockRejectedValueOnce(Object.assign(new Error('429'), { status: 429 }));
    const res = await post({ urls: [url(1), url(2), url(3), url(4)] });
    expect(res.body.rateLimited).toBe(true);
    expect(res.body.results.map((r) => r.status)).toEqual(['ok', 'rate_limited', 'rate_limited', 'rate_limited']);
    expect(getDownloadLink).toHaveBeenCalledTimes(2);
    expect(logOperation).toHaveBeenCalledWith(expect.objectContaining({ status: 'partial', errorCode: 'RATE_LIMITED' }));
  });

  test('a track whose downloads are off is "unavailable" with a reason; a CDN link off the allowlist is never handed out', async () => {
    getDownloadLink
      .mockRejectedValueOnce(Object.assign(new Error('404'), { status: 404 }))
      .mockResolvedValueOnce({ redirect: 'https://evil.example/file.mp3' });
    const res = await post({ urls: [url(1), url(2)] });
    expect(res.body.results[0]).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/turned downloads off/) });
    expect(res.body.results[1]).toMatchObject({ status: 'error' });
    expect(res.body.results[1].link).toBeUndefined();
  });

  test.each([
    ['more than 10 urls', { urls: Array.from({ length: 11 }, (_, i) => url(i + 1)) }],
    ['a non-download url', { urls: ['https://api.soundcloud.com/tracks/soundcloud:tracks:1/streams'] }],
    ['an array smuggled in as an element', { urls: [[url(1)]] }],
    ['no body (a cross-site form post parses to {})', {}],
  ])('rejects %s with 400 and calls nothing', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(getDownloadLink).not.toHaveBeenCalled();
  });
});
