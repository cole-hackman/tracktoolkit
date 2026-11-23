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
 *   - the first attempt can fail without saying anything about the link: a
 *     failed token refresh, a database error on the token save, the network.
 *
 * So the phrase comes from the first failure when it has one, and otherwise
 * only from what the public attempt can actually know (not found, rate
 * limited, no answer). The server log gets one line per run that had a failed
 * link, describing the first one's errors by name, code and status.
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
  const TRACK = { kind: 'track', id: 5, title: 'T', sharing: 'public', user: { username: 'u' } };
  const failedLines = () => warned.filter((args) => args[0] === '[WARN] Batch resolve: links failed');
  const coveredLines = () => warned.filter((args) => args[0] === '[WARN] Batch resolve: public retry covered a failed signed-in attempt');

  test('a database error behind a failed link is logged once, by code, without its text, the link or a token', async () => {
    resolveAny.mockImplementation(async () => { throw dbDown(); });
    resolvePublic.mockImplementation(async () => { throw sc(401); });
    const urls = [freshUrl(), freshUrl(), freshUrl()];

    await batch(urls);

    expect(failedLines()).toHaveLength(1);
    expect(failedLines()[0][1]).toEqual({
      failed: '3',   // the logger prints numbers as text
      total: '3',
      first: { name: 'Error', code: 'P1001' },
      firstPublic: { name: 'Error', message: 'Resolve error: 401' },   // the public attempt's answer, beside it
    });
    expect(coveredLines()).toEqual([]);
    for (const line of logged()) {
      expect(line).not.toMatch(/db\.internal|5432|ACCESS-TOKEN|REFRESH-TOKEN|soundcloud\.com\/artist/);
    }
  });

  test('nothing the thrower wrote is in the line', async () => {
    resolveAny.mockImplementation(async () => {
      throw new TypeError('Headers.append: "OAuth 2-AB\0CDTOKEN" is an invalid header value.');
    });
    resolvePublic.mockImplementation(async () => { throw new Error('GET soundcloud.com/artist/track/s-SECRETLINK failed'); });

    const res = await batch([freshUrl()]);

    expect(res.status).toBe(200);
    expect(failedLines()).toHaveLength(1);
    expect(failedLines()[0][1]).toEqual({ failed: '1', total: '1', first: { name: 'TypeError' }, firstPublic: { name: 'Error' } });
    for (const line of logged()) expect(line).not.toMatch(/2-AB|CDTOKEN|OAuth|s-SECRETLINK/);
  });

  test('a signed-in failure with no HTTP status that the public retry covered has its own line', async () => {
    resolveAny.mockImplementation(async () => { throw dbDown(); });
    resolvePublic.mockResolvedValue(TRACK);

    const res = await batch([freshUrl(), freshUrl()]);

    expect(res.body.results.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(failedLines()).toEqual([]);
    expect(coveredLines()).toHaveLength(1);
    expect(coveredLines()[0][1]).toEqual({ covered: '2', total: '2', first: { name: 'Error', code: 'P1001' } });
  });

  test('several covered links: the count, and the first one\'s error', async () => {
    const [a, b, c] = [freshUrl(), freshUrl(), freshUrl()];
    resolveAny.mockImplementation(async (_at, _rt, url) => {
      if (url === a) throw sc(401);            // covered, but ordinary
      throw url === b ? dbDown() : refreshFailed();
    });
    resolvePublic.mockResolvedValue(TRACK);

    await batch([a, b, c]);

    expect(coveredLines()).toHaveLength(1);
    expect(coveredLines()[0][1]).toEqual({ covered: '2', total: '3', first: { name: 'Error', code: 'P1001' } });
  });

  test('a signed-in failure, then a public answer that cannot be parsed: a failed link, described by what was thrown', async () => {
    resolveAny.mockImplementation(async () => { throw dbDown(); });
    resolvePublic.mockResolvedValue({ kind: 'something-else', id: 1 });

    const res = await batch([freshUrl()]);

    expect(res.body.results[0]).toMatchObject({ status: 'error', error: 'Could not parse resource' });
    expect(failedLines()).toHaveLength(1);
    expect(failedLines()[0][1]).toEqual({ failed: '1', total: '1', first: { name: 'Error', code: 'P1001' } });
    expect(coveredLines()).toEqual([]);
  });

  test.each([400, 401, 403, 404, 410])('a %i that the public retry covered is ordinary and logs nothing', async (status) => {
    resolveAny.mockImplementation(async () => { throw sc(status); });
    resolvePublic.mockResolvedValue(TRACK);

    const res = await batch([freshUrl()]);

    expect(res.body.results[0].status).toBe('ok');
    expect(warned).toEqual([]);
  });

  test('a failed link is never counted as covered, whatever its first error', async () => {
    const [failed, covered] = [freshUrl(), freshUrl()];
    resolveAny.mockImplementation(async () => { throw dbDown(); });
    resolvePublic.mockImplementation(async (url) => {
      if (url === failed) throw sc(404);
      return TRACK;
    });

    await batch([failed, covered]);

    expect(failedLines()).toHaveLength(1);
    expect(failedLines()[0][1].failed).toBe('1');
    expect(coveredLines()).toHaveLength(1);
    expect(coveredLines()[0][1].covered).toBe('1');
  });

  test('a 404 and then a 500 on different links: the line carries the first failed link only', async () => {
    const [missing, broken] = [freshUrl(), freshUrl()];
    resolveAny.mockImplementation(async (_at, _rt, url) => { throw url === missing ? sc(404) : sc(500); });
    resolvePublic.mockImplementation(async () => { throw sc(404); });

    await batch([missing, broken]);

    expect(failedLines()).toHaveLength(1);
    expect(failedLines()[0][1]).toEqual({
      failed: '2',
      total: '2',
      first: { name: 'Error', message: 'Resolve error: 404' },
      firstPublic: { name: 'Error', message: 'Resolve error: 404' },
    });
    expect(coveredLines()).toEqual([]);
  });

  test('links whose resource cannot be parsed are failed links too: the line has the count and no error', async () => {
    resolveAny.mockResolvedValue({ kind: 'something-else', id: 1 });

    const res = await batch([freshUrl(), freshUrl()]);

    expect(res.body.results.map((r) => r.error)).toEqual(['Could not parse resource', 'Could not parse resource']);
    expect(failedLines()).toHaveLength(1);
    expect(failedLines()[0][1]).toEqual({ failed: '2', total: '2' });
  });

  test('an ordinary partial failure logs the first error once', async () => {
    const [ok, missing, alsoMissing] = [freshUrl(), freshUrl(), freshUrl()];
    resolveAny.mockImplementation(async (_at, _rt, url) => {
      if (url === ok) return { kind: 'track', id: 6, title: 'T', sharing: 'public', user: { username: 'u' } };
      throw sc(404);
    });
    resolvePublic.mockImplementation(async () => { throw sc(404); });

    await batch([ok, missing, alsoMissing]);

    expect(failedLines()).toHaveLength(1);
    expect(failedLines()[0][1]).toMatchObject({ failed: '2', total: '3' });
  });

  test('the operation log keeps the message of the last error of the first failed link, when no link resolved', async () => {
    resolveAny.mockImplementation(async () => { throw sc(401); });
    resolvePublic.mockImplementation(async () => { throw sc(404); });

    await batch([freshUrl()]);

    const op = logOperation.mock.calls.map((c) => c[0]).find((a) => a.action === 'batch-resolve');
    expect(op.errorCode).toBe('ALL_ITEMS_FAILED');
    expect(op.errorMessage).toBe('Resolve error: 404');
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

describe('POST /api/resolve/batch: only the exact status message picks a phrase', () => {
  test.each([
    ['text before it', 'upstream said Resolve error: 404'],
    ['text after it', 'Resolve error: 404 for this link'],
    ['a longer number', 'Resolve error: 4040'],
    ['a line before it', 'x\nResolve error: 404'],
    ['a line after it', 'Resolve error: 404\nx'],
    ['another case', 'resolve error: 404'],
  ])('%s: the item says only that it failed', async (_name, message) => {
    resolveAny.mockImplementation(async () => { throw new Error(message); });
    resolvePublic.mockImplementation(async () => { throw new Error(message); });
    const url = freshUrl();

    const res = await batch([url]);

    expect(res.body.results).toEqual([{ url, status: 'error', error: UNKNOWN }]);
  });
});

describe('POST /api/resolve/batch: a status on the error itself counts, whatever its message', () => {
  const withStatus = (status) => Object.assign(new Error('upstream said no'), { status });

  test('a 403 picks "refused"', async () => {
    resolveAny.mockImplementation(async () => { throw withStatus(403); });
    resolvePublic.mockImplementation(async () => { throw withStatus(404); });
    const url = freshUrl();

    const res = await batch([url]);

    expect(res.body.results).toEqual([{ url, status: 'error', error: REFUSED }]);
  });

  test('a 401 that the public retry covered is ordinary and logs nothing', async () => {
    resolveAny.mockImplementation(async () => { throw withStatus(401); });
    resolvePublic.mockResolvedValue({ kind: 'track', id: 11, title: 'T', sharing: 'public', user: { username: 'u' } });

    const res = await batch([freshUrl()]);

    expect(res.body.results[0].status).toBe('ok');
    expect(warned).toEqual([]);
  });
});

describe('POST /api/resolve/batch: a thrown value cannot fail the run or skip its bookkeeping', () => {
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
  const TRACK = { kind: 'track', id: 9, title: 'T', sharing: 'public', user: { username: 'u' } };
  let unhandled;
  const onUnhandled = (reason) => { unhandled.push(reason); };
  beforeEach(() => { unhandled = []; process.on('unhandledRejection', onUnhandled); });
  afterEach(() => process.off('unhandledRejection', onUnhandled));
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };
  const op = () => logOperation.mock.calls.map((c) => c[0]).find((a) => a.action === 'batch-resolve');

  test.each(HOSTILE)('%s from both attempts: 200, one failed item, the operation logged', async (_name, make) => {
    const [bad, good] = [freshUrl(), freshUrl()];
    resolveAny.mockImplementation(async (_at, _rt, url) => { if (url === bad) throw make(); return TRACK; });
    resolvePublic.mockImplementation(async () => { throw make(); });

    const res = await batch([bad, good]);
    await settle();

    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => [r.status, r.error])).toEqual([['error', UNKNOWN], ['ok', undefined]]);
    expect(op()).toMatchObject({ status: 'success', metadata: { total: 2, succeeded: 1, failed: 1 } });
    expect(logged().join(' ')).not.toContain('GETTER-TEXT');
    expect(unhandled).toEqual([]);
  });

  test.each(HOSTILE)('%s, every link: the operation log gets the fallback text', async (_name, make) => {
    resolveAny.mockImplementation(async () => { throw make(); });
    resolvePublic.mockImplementation(async () => { throw make(); });

    const res = await batch([freshUrl()]);
    await settle();

    expect(res.status).toBe(200);
    expect(op()).toMatchObject({ status: 'error', errorMessage: 'Resolve failed' });
    expect(unhandled).toEqual([]);
  });

  test.each(HOSTILE)('%s, covered by the public retry: 200 and resolved', async (_name, make) => {
    resolveAny.mockImplementation(async () => { throw make(); });
    resolvePublic.mockResolvedValue(TRACK);

    const res = await batch([freshUrl()]);
    await settle();

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('ok');
    expect(op()).toMatchObject({ status: 'success' });
    expect(unhandled).toEqual([]);
  });

  test('a console that throws changes nothing', async () => {
    resolveAny.mockImplementation(async () => { throw sc(404); });
    resolvePublic.mockImplementation(async () => { throw sc(404); });
    console.warn.mockImplementation(() => { throw new Error('EPIPE'); });

    const res = await batch([freshUrl()]);
    await settle();

    expect(res.status).toBe(200);
    expect(op()).toMatchObject({ status: 'error', errorMessage: 'Resolve error: 404' });
    expect(unhandled).toEqual([]);
  });

  test('bookkeeping that throws after the response is logged, and is not a second response', async () => {
    resolveAny.mockResolvedValue(TRACK);
    logOperation.mockImplementationOnce(() => { throw new Error('analytics down'); });

    const res = await batch([freshUrl()]);
    await settle();

    expect(res.status).toBe(200);
    expect(errored.filter((args) => args[0] === '[ERROR] Batch resolve error:')).toHaveLength(1);
    expect(unhandled).toEqual([]);
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
