import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * A resolve can make two attempts: `resolveAny` with the user's token, then
 * `resolvePublic` with none. When both fail, the two errors are usually
 * different, and only the first says anything about the link:
 *
 *   - the second attempt carries no credentials, so "refused" from it means
 *     only that the link needs some;
 *   - the first attempt can fail for reasons of ours. `resolveAny` passes a
 *     failed token refresh through as thrown, so a database error on the save
 *     arrives here as Prisma text. That says nothing about the link either.
 *
 * So the phrase comes from the first failure when SoundCloud answered it, and
 * otherwise only from what the public attempt can actually know (not found,
 * rate limited, no answer). The raw errors go to the server log, once per run.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const resolveAny = jest.fn();
const resolvePublic = jest.fn();
const logOperation = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../server/lib/catalog.js', () => ({
  harvestTracks: jest.fn(),
  harvestPlaylists: jest.fn(),
}));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: { resolveAny, resolvePublic },
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
const { getCachedResolve } = await import('../../server/lib/resolve-cache.js');

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);

afterAll(() => { process.env.NODE_ENV = ORIGINAL_NODE_ENV; });

const DB_DOWN = "Can't reach database server at `db.internal:5432`";
const LEAK = /db\.internal|5432|P1001|Resolve error|Token refresh|ACCESS-TOKEN|REFRESH-TOKEN/;

const sc = (status, follow = false) => new Error(`Resolve ${follow ? 'follow ' : ''}error: ${status}`);
const dbDown = () => Object.assign(new Error(DB_DOWN), { code: 'P1001' });
const refreshFailed = () => Object.assign(new Error('Token refresh failed: 400'), { invalidGrant: true });
const timeout = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError', code: 'SC_TIMEOUT', status: 504 });

const NOT_FOUND = 'Not found on SoundCloud, or private';
const REFUSED = 'SoundCloud refused this link. It may be private';
const RATE_LIMITED = 'SoundCloud rate limit reached — try again later';
const NO_ANSWER = 'SoundCloud did not respond — try again later';
const UNKNOWN = 'Resolve failed';

// One URL per test: the resolve cache is module state.
let n = 0;
const freshUrl = () => { n += 1; return `https://soundcloud.com/artist/track-${n}`; };

let warned;
let errored;
const logged = () => [...warned, ...errored].map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));

beforeEach(() => {
  resolveAny.mockReset();
  resolvePublic.mockReset();
  logOperation.mockClear();
  warned = [];
  errored = [];
  jest.spyOn(console, 'warn').mockImplementation((...args) => { warned.push(args); });
  jest.spyOn(console, 'error').mockImplementation((...args) => { errored.push(args); });
});
afterEach(() => jest.restoreAllMocks());

const batch = (urls) => request(app).post('/api/resolve/batch').send({ urls });

describe('POST /api/resolve/batch: both attempts fail, with different errors', () => {
  test.each([
    ['not found, then refused without credentials', () => sc(404), () => sc(401), NOT_FOUND],
    ['not found, then a timeout', () => sc(404), timeout, NOT_FOUND],
    ['refused with credentials, then not found', () => sc(403, true), () => sc(404), REFUSED],
    ['refused after a fresh token, then not found', () => sc(401), () => sc(404), REFUSED],
    ['a database error, then refused without credentials', dbDown, () => sc(401), UNKNOWN],
    ['a database error, then forbidden without credentials', dbDown, () => sc(403), UNKNOWN],
    ['a database error, then not found', dbDown, () => sc(404), NOT_FOUND],
    ['a failed token refresh, then refused', refreshFailed, () => sc(401), UNKNOWN],
    ['a failed token refresh, then rate limited', refreshFailed, () => sc(429), RATE_LIMITED],
    ['a failed token refresh, then a timeout', refreshFailed, timeout, NO_ANSWER],
    ['a database error twice', dbDown, dbDown, UNKNOWN],
  ])('%s', async (_name, first, second, expected) => {
    resolveAny.mockImplementation(async () => { throw first(); });
    resolvePublic.mockImplementation(async () => { throw second(); });
    const url = freshUrl();

    const res = await batch([url]);

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ url, status: 'error', error: expected }]);
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
  });

  test('a rate limit or a timeout on the first attempt is not retried, and is what the item says', async () => {
    const [a, b] = [freshUrl(), freshUrl()];
    resolveAny.mockImplementation(async (_at, _rt, url) => { throw url === a ? sc(429) : timeout(); });

    const res = await batch([a, b]);

    expect(resolvePublic).not.toHaveBeenCalled();
    expect(res.body.results.map((r) => r.error)).toEqual([RATE_LIMITED, NO_ANSWER]);
  });
});

describe('POST /api/resolve/batch: the server log keeps what the response does not say', () => {
  test('a database error behind a failed link is logged once, by code, without its text, the link or a token', async () => {
    resolveAny.mockImplementation(async () => { throw dbDown(); });
    resolvePublic.mockImplementation(async () => { throw sc(401); });
    const urls = [freshUrl(), freshUrl(), freshUrl()];

    await batch(urls);

    // By code, not by its text: see safeErrorBrief.
    const lines = logged().filter((line) => line.includes('P1001'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Resolve error: 401');   // the public attempt's answer, beside it
    for (const line of logged()) {
      expect(line).not.toMatch(/db\.internal|5432|ACCESS-TOKEN|REFRESH-TOKEN|soundcloud\.com\/artist/);
    }
  });

  test('a database error is logged even when the public attempt then succeeds', async () => {
    resolveAny.mockImplementation(async () => { throw dbDown(); });
    resolvePublic.mockResolvedValue({ kind: 'track', id: 5, title: 'T', sharing: 'public', user: { username: 'u' } });

    const res = await batch([freshUrl()]);

    expect(res.body.results[0].status).toBe('ok');
    expect(logged().filter((line) => line.includes('P1001'))).toHaveLength(1);
    expect(logged().join(' ')).not.toMatch(/db\.internal|5432/);
  });

  test('an ordinary partial failure logs the first raw error once', async () => {
    const [ok, missing, alsoMissing] = [freshUrl(), freshUrl(), freshUrl()];
    resolveAny.mockImplementation(async (_at, _rt, url) => {
      if (url === ok) return { kind: 'track', id: 6, title: 'T', sharing: 'public', user: { username: 'u' } };
      throw sc(404);
    });
    resolvePublic.mockImplementation(async () => { throw sc(404); });

    await batch([ok, missing, alsoMissing]);

    expect(logged().filter((line) => line.includes('Resolve error: 404'))).toHaveLength(1);
  });

  test('nothing is logged when every link resolves', async () => {
    resolveAny.mockResolvedValue({ kind: 'track', id: 7, title: 'T', sharing: 'public', user: { username: 'u' } });

    await batch([freshUrl(), freshUrl()]);

    expect(logged().filter((line) => /: links failed/.test(line))).toEqual([]);
  });

  test('a thrown non-error does not turn the whole run into a 500', async () => {
    const [bad, good] = [freshUrl(), freshUrl()];
    resolveAny.mockImplementation(async (_at, _rt, url) => {
      if (url === bad) throw null; // eslint-disable-line no-throw-literal
      return { kind: 'track', id: 8, title: 'T', sharing: 'public', user: { username: 'u' } };
    });
    resolvePublic.mockImplementation(async () => { throw null; }); // eslint-disable-line no-throw-literal

    const res = await batch([bad, good]);

    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => r.status)).toEqual(['error', 'ok']);
    expect(res.body.results[0].error).toBe(UNKNOWN);
  });
});

describe('the public retry still keeps private resources out of the shared cache', () => {
  test('a private track returned by the public attempt is served but not cached; a public one is', async () => {
    const [secret, open] = [freshUrl(), freshUrl()];
    resolveAny.mockImplementation(async () => { throw dbDown(); });
    resolvePublic.mockImplementation(async (url) => ({
      kind: 'track', id: url === secret ? 21 : 22, title: 'T', user: { username: 'u' },
      sharing: url === secret ? 'private' : 'public',
    }));

    const res = await batch([secret, open]);

    expect(res.body.results.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(getCachedResolve(secret)).toBeFalsy();
    expect(getCachedResolve(open)).toBeTruthy();
  });
});

describe('POST /api/resolve: one link, the same rule', () => {
  // Pins, not changes: the single resolver already answered from the first
  // failure and logged it. Here so the two cannot drift apart again.
  const single = (url) => request(app).post('/api/resolve').send({ url });

  test('refused with credentials, then not found publicly: the answer is the first failure', async () => {
    resolveAny.mockRejectedValue(sc(401));
    resolvePublic.mockRejectedValue(sc(404));

    const res = await single(freshUrl());

    expect(resolvePublic).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized to resolve this URL. Sign in and try again.' });
  });

  test('not found with credentials: 404, and no public attempt', async () => {
    resolveAny.mockRejectedValue(sc(404));

    const res = await single(freshUrl());

    expect(resolvePublic).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Resource not found or private.' });
  });

  test('a database error: a fixed 500 that names no cause, and the error is in the log', async () => {
    resolveAny.mockRejectedValue(dbDown());

    const res = await single(freshUrl());

    expect(resolvePublic).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to resolve URL' });
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
    expect(logged().filter((line) => line.includes('db.internal:5432'))).toHaveLength(1);
  });
});
