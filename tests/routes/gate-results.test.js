import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ALLOWLIST = process.env.DOWNLOAD_ALLOWLIST;
process.env.NODE_ENV = 'development'; // disables rate limiters
process.env.DOWNLOAD_ALLOWLIST = '111';

const logOperation = jest.fn();
const findMany = jest.fn();
let currentUser = { id: 'user-a', soundcloudId: 111 };

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({ default: { operationLog: { findMany } } }));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: {},
  fetchWithTimeout: jest.fn(),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation,
  startOperationTimer: () => () => 1,
  extractClientInfo: () => ({}),
  getAnalyticsWriteHealth: () => ({ status: 'ok' }),
  instrumentRead: () => (req, res, next) => next(),
}));
jest.unstable_mockModule('../../server/lib/enrichment.js', () => ({ piggybackEnrichment: jest.fn() }));
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = currentUser;
    next();
  },
}));

const { default: apiRoutes } = await import('../../server/routes/api.js');

const app = express();
app.use(express.json()); // the ONLY body parser, as in prod
app.use('/api', apiRoutes);

afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_ALLOWLIST === undefined) delete process.env.DOWNLOAD_ALLOWLIST;
  else process.env.DOWNLOAD_ALLOWLIST = ORIGINAL_ALLOWLIST;
});

const post = (body) => request(app).post('/api/downloads/gate-results').send(body);
const done = (id, extra = {}) => ({ id, site: 'hypeddit', status: 'done', ...extra });

beforeEach(() => {
  currentUser = { id: 'user-a', soundcloudId: 111 };
  logOperation.mockReset().mockResolvedValue(undefined);
  findMany.mockReset().mockResolvedValue([]);
});

describe('POST /api/downloads/gate-results', () => {
  test('is refused for an account off the allowlist, before anything is read or written', async () => {
    currentUser = { id: 'user-b', soundcloudId: 222 };
    const res = await post({ runId: 'run-1', results: [done(1)] });
    expect(res.status).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
    expect(logOperation).not.toHaveBeenCalled();
  });

  test('logs one row per track with the site, run and reason, mapping done/failed to success/error', async () => {
    const res = await post({
      runId: 'run-1',
      results: [
        done(11, { title: 'Get Lucky', artist: 'Daft Punk', actions: ['follow', 'like'] }),
        { id: 12, site: 'droploud', status: 'failed', reason: 'Auto-Allow is off' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ logged: 2, duplicates: 0 });
    expect(logOperation).toHaveBeenCalledTimes(2);
    expect(logOperation.mock.calls[0][0]).toMatchObject({
      action: 'gate-download',
      status: 'success',
      trackIds: [11],
      metadata: { runId: 'run-1', site: 'hypeddit', via: 'extension', title: 'Get Lucky', artist: 'Daft Punk', actions: ['follow', 'like'] },
    });
    expect(logOperation.mock.calls[1][0]).toMatchObject({
      status: 'error',
      errorCode: 'GATE_FAILED',
      errorMessage: 'Auto-Allow is off',
      trackIds: [12],
      metadata: { site: 'droploud', reason: 'Auto-Allow is off' },
    });
  });

  test('skips an outcome already logged for this run, and repeats inside one request', async () => {
    findMany.mockResolvedValue([{ status: 'success', metadata: { runId: 'run-1', trackIds: [11] } }]);
    const res = await post({ runId: 'run-1', results: [done(11), done(12), done(12)] });
    expect(res.body).toEqual({ logged: 1, duplicates: 2 });
    expect(logOperation.mock.calls.map((c) => c[0].trackIds)).toEqual([[12]]);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ userId: 'user-a', action: 'gate-download', metadata: { path: ['runId'], equals: 'run-1' } });
  });

  test('a failure followed by a success for the same track are two different outcomes', async () => {
    findMany.mockResolvedValue([{ status: 'error', metadata: { runId: 'run-1', trackIds: [11] } }]);
    const res = await post({ runId: 'run-1', results: [done(11)] });
    expect(res.body.logged).toBe(1);
  });

  test('strips control characters from the free text before storing it', async () => {
    await post({ runId: 'run-1', results: [done(11, { title: 'Bad\u0000 Title\u0007', reason: 'x\u0001y' })] });
    expect(logOperation.mock.calls[0][0].metadata.title).toBe('Bad Title');
  });

  test.each([
    ['no body at all', {}],
    ['an empty results list', { runId: 'r', results: [] }],
    ['more than 50 results', { runId: 'r', results: Array.from({ length: 51 }, (_, i) => done(i + 1)) }],
    ['a runId that is an array (element-wise bypass)', { runId: ['r'], results: [done(1)] }],
    ['a runId with odd characters', { runId: 'r/../x', results: [done(1)] }],
    ['an id that is not a positive integer', { runId: 'r', results: [done(0)] }],
    ['an id that is a string of letters', { runId: 'r', results: [done('abc')] }],
    ['a site that is not a gate the extension runs', { runId: 'r', results: [{ id: 1, site: 'toneden', status: 'done' }] }],
    ['a status that is an array', { runId: 'r', results: [{ id: 1, site: 'hypeddit', status: ['done'] }] }],
    ['a status other than done/failed', { runId: 'r', results: [{ id: 1, site: 'hypeddit', status: 'running' }] }],
    ['an unknown action', { runId: 'r', results: [done(1, { actions: ['delete-account'] })] }],
    ['a reason over 300 characters', { runId: 'r', results: [done(1, { reason: 'x'.repeat(301) })] }],
  ])('rejects %s with 400 and writes nothing', async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(logOperation).not.toHaveBeenCalled();
  });

  test('a cross-site form post (urlencoded) parses to an empty body and fails at the validator', async () => {
    const res = await request(app)
      .post('/api/downloads/gate-results')
      .type('form')
      .send('runId=r&results=1');
    expect(res.status).toBe(400);
    expect(logOperation).not.toHaveBeenCalled();
  });

  test('a database failure answers 500 without leaking the error', async () => {
    findMany.mockRejectedValue(new Error('connection refused postgres://secret'));
    const res = await post({ runId: 'r', results: [done(1)] });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret/);
  });
});
