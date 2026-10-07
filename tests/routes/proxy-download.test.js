import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const getDownloadLink = jest.fn();
const logOperation = jest.fn();

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

afterAll(() => { process.env.NODE_ENV = ORIGINAL_NODE_ENV; });

// The shape every downloadable track carried in production on 2026-10-07.
const URN_URL = 'https://api.soundcloud.com/tracks/soundcloud:tracks:1897670478/download';
const NUMERIC_URL = 'https://api.soundcloud.com/tracks/123/download';
const CDN = 'https://cf-media.sndcdn.com/abc.mp3?Policy=x';

const get = (url, json = true) =>
  request(app).get(`/api/proxy-download?${json ? 'format=json&' : ''}url=${encodeURIComponent(url)}`);

beforeEach(() => {
  getDownloadLink.mockReset();
  logOperation.mockReset();
});

describe('GET /api/proxy-download', () => {
  test('accepts the URN-form download_url and returns the CDN link', async () => {
    getDownloadLink.mockResolvedValue({ redirect: CDN });
    const res = await get(URN_URL);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: CDN });
    expect(getDownloadLink).toHaveBeenCalledWith('at', 'rt', URN_URL);
    expect(logOperation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'proxy-download', status: 'success', trackIds: [1897670478],
    }));
  });

  test('still accepts the legacy numeric form', async () => {
    getDownloadLink.mockResolvedValue({ redirect: CDN });
    const res = await get(NUMERIC_URL);
    expect(res.status).toBe(200);
    expect(logOperation).toHaveBeenCalledWith(expect.objectContaining({ trackIds: [123] }));
  });

  test('redirects (no format=json) straight to the CDN', async () => {
    getDownloadLink.mockResolvedValue({ redirect: CDN });
    const res = await get(URN_URL, false);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(CDN);
  });

  test('refuses anything that is not a SoundCloud track download URL, without calling SoundCloud', async () => {
    for (const bad of [
      'https://api.soundcloud.com/tracks/soundcloud:playlists:1/download',
      'https://api.soundcloud.com/tracks/soundcloud:tracks:1/streams',
      'https://evil.example/tracks/soundcloud:tracks:1/download',
    ]) {
      const res = await get(bad);
      expect(res.status).toBe(400);
    }
    expect(getDownloadLink).not.toHaveBeenCalled();
  });

  test('a redirect off the CDN allowlist is a 502, never forwarded', async () => {
    getDownloadLink.mockResolvedValue({ redirect: 'https://evil.example/file.mp3' });
    const res = await get(URN_URL);
    expect(res.status).toBe(502);
    expect(res.body.url).toBeUndefined();
  });

  test.each([403, 404])('SoundCloud %i means downloads are off: 404 with a plain reason, and logged', async (status) => {
    getDownloadLink.mockRejectedValue(Object.assign(new Error(`Download request failed: ${status}`), { status }));
    const res = await get(URN_URL);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/turned downloads off/);
    expect(logOperation).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error', trackIds: [1897670478], metadata: expect.objectContaining({ upstreamStatus: status }),
    }));
  });

  test('SoundCloud 429 surfaces as 429', async () => {
    getDownloadLink.mockRejectedValue(Object.assign(new Error('Download request failed: 429'), { status: 429 }));
    const res = await get(URN_URL);
    expect(res.status).toBe(429);
  });

  test('an unexplained failure is still a 500, and still logged', async () => {
    getDownloadLink.mockRejectedValue(new Error('boom'));
    const res = await get(URN_URL);
    expect(res.status).toBe(500);
    expect(logOperation).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });
});
