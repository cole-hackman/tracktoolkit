import { jest } from '@jest/globals';
import { Response } from 'node-fetch';

process.env.SC_FETCH_TIMEOUT_MS = '50'; // before the module loads
process.env.SC_GATEWAY_RETRY_MIN_MS = '0';
process.env.SC_GATEWAY_RETRY_MAX_MS = '1';
process.env.ENCRYPTION_KEY ||= 'x'.repeat(32);

jest.unstable_mockModule('../server/lib/prisma.js', () => ({
  default: { token: { update: jest.fn(), findUnique: jest.fn() } },
}));

const { soundcloudClient } = await import('../server/lib/soundcloud-client.js');

const res = (status, body = '') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

beforeEach(() => {
  global.fetch = jest.fn();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('scRequest error shape', () => {
  test('a non-OK response keeps its message and gains status/endpoint/method', async () => {
    fetch.mockResolvedValueOnce(res(404));
    const err = await soundcloudClient.scRequest('/playlists/1', 'a', 'r').catch((e) => e);
    expect(err.message).toBe('API request failed: 404');
    expect(err.status).toBe(404);
    expect(err.endpoint).toBe('/playlists/1');
    expect(err.method).toBe('GET');
  });

  test('GET 502 then 200 is retried exactly once and succeeds', async () => {
    fetch.mockResolvedValueOnce(res(502)).mockResolvedValueOnce(res(200, { ok: true }));
    await expect(soundcloudClient.scRequest('/me', 'a', 'r')).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('GET 502 then 502 throws with status 502 after exactly 2 fetches', async () => {
    fetch.mockResolvedValue(res(502));
    const err = await soundcloudClient.scRequest('/me', 'a', 'r').catch((e) => e);
    expect(err.message).toBe('API request failed: 502');
    expect(err.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test.each(['POST', 'PUT', 'DELETE'])('%s 502 is never retried', async (method) => {
    fetch.mockResolvedValue(res(502));
    const err = await soundcloudClient.scRequest('/playlists/1', 'a', 'r', { method }).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.method).toBe(method);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('a 500 is not retried', async () => {
    fetch.mockResolvedValue(res(500));
    const err = await soundcloudClient.scRequest('/me', 'a', 'r').catch((e) => e);
    expect(err.status).toBe(500);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('a timeout keeps its message and is tagged SC_TIMEOUT / 504', async () => {
    fetch.mockImplementation((url, options = {}) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    }));
    const err = await soundcloudClient.scRequest('/me', 'a', 'r').catch((e) => e);
    expect(err.message).toMatch(/abort/i);
    expect(err.code).toBe('SC_TIMEOUT');
    expect(err.status).toBe(504);
  }, 5000);
});

describe('paginate', () => {
  test('retries a 502 page once, then continues', async () => {
    fetch
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200, { collection: [{ id: 1 }] }));
    const items = await soundcloudClient.paginate('/me/playlists', 'a', 'r', 200);
    expect(items).toEqual([{ id: 1 }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('two 502s on a page throw with status after 2 fetches', async () => {
    fetch.mockResolvedValue(res(503));
    const err = await soundcloudClient.paginate('/me/playlists', 'a', 'r', 200).catch((e) => e);
    expect(err.message).toBe('API request failed: 503');
    expect(err.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
