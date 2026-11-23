import { jest } from '@jest/globals';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

// POST /api/experiments/exposure and the flag lists on GET /api/auth/me,
// through the real routers and the real flag logic. Only the database and the
// session lookup are stand-ins.

process.env.SESSION_SECRET ||= 's'.repeat(40);

const exposureFindUnique = jest.fn();
const exposureCreate = jest.fn((args) => ({ __op: 'exposure.create', args }));
const metricUpsert = jest.fn((args) => ({ __op: 'metric.upsert', args }));
const operationLogFindFirst = jest.fn();
const transaction = jest.fn();
const userFindUnique = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
  default: {
    experimentExposure: { findUnique: exposureFindUnique, create: exposureCreate },
    metric: { upsert: metricUpsert },
    operationLog: { findFirst: operationLogFindFirst },
    user: { findUnique: userFindUnique },
    $transaction: transaction,
  },
}));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: {},
  signOut: jest.fn(async () => true),
  forgetRecentRotation: jest.fn(),
  fetchWithTimeout: jest.fn(),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation: jest.fn(),
  startOperationTimer: () => () => 0,
  extractClientInfo: () => ({}),
  getAnalyticsWriteHealth: jest.fn(),
}));
jest.unstable_mockModule('../../server/lib/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let currentUser = null;
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    if (!currentUser) return res.status(401).json({ error: 'Not authenticated' });
    req.user = currentUser;
    next();
  },
}));

const { default: experimentRoutes } = await import('../../server/routes/experiments.js');
const { default: authRoutes } = await import('../../server/routes/auth.js');
const { rejectUntrustedOrigin } = await import('../../server/middleware/security.js');
const { signSession } = await import('../../server/lib/session.js');
const { variantFor } = await import('../../server/lib/flags.js');

const app = express();
app.use(express.json()); // mirrors prod: express.json() is the ONLY body parser
app.use(cookieParser());
app.use('/api', rejectUntrustedOrigin);
app.use('/api/experiments', experimentRoutes);
app.use('/api/auth', authRoutes);

const KEY = 'guided-first-run';
const FLAG_ENV = ['FLAG_GUIDED_FIRST_RUN_PERCENT', 'FLAG_GUIDED_FIRST_RUN_START', 'FLAG_GUIDED_FIRST_RUN_END', 'FLAGS_KILL', 'EXPERIMENT_EXCLUDE_IDS', 'ADMIN_IDS'];
const saved = Object.fromEntries(FLAG_ENV.map((name) => [name, process.env[name]]));

/** A user who signed up a minute ago, after the experiment started. */
const freshUser = (soundcloudId = 555) => ({
  id: `u-${soundcloudId}`,
  soundcloudId,
  username: 'newbie',
  createdAt: new Date(Date.now() - 60_000),
  tokens: [{ id: 't' }],
});
const launch = () => {
  process.env.FLAG_GUIDED_FIRST_RUN_PERCENT = '100';
  process.env.FLAG_GUIDED_FIRST_RUN_START = new Date(Date.now() - 3_600_000).toISOString();
};
const writes = () => transaction.mock.calls.length + exposureCreate.mock.calls.length + metricUpsert.mock.calls.length;

beforeEach(() => {
  for (const name of FLAG_ENV) delete process.env[name];
  for (const mock of [exposureFindUnique, exposureCreate, metricUpsert, operationLogFindFirst, transaction, userFindUnique]) mock.mockClear();
  exposureFindUnique.mockResolvedValue(null);
  operationLogFindFirst.mockResolvedValue(null);
  transaction.mockResolvedValue([]);
  currentUser = freshUser();
});
afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const post = (body) => request(app).post('/api/experiments/exposure').send(body);

describe('POST /api/experiments/exposure', () => {
  test('requires a session', async () => {
    currentUser = null;
    launch();
    const res = await post({ key: KEY });
    expect(res.status).toBe(401);
    expect(writes()).toBe(0);
  });

  test('with the flag at its default of 0 percent: not enrolled, nothing read, nothing written', async () => {
    const res = await post({ key: KEY });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: KEY, enrolled: false, variant: null, activated: false });
    expect(exposureFindUnique).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
  });

  test('an eligible new user is enrolled once, into the arm their id hashes to', async () => {
    launch();
    const expected = variantFor(KEY, 555);
    const res = await post({ key: KEY });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: KEY, enrolled: true, variant: expected, activated: false });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(exposureCreate).toHaveBeenCalledWith({ data: { userId: 'u-555', experimentKey: KEY, variant: expected } });

    // Every later call finds the row and writes nothing.
    exposureFindUnique.mockResolvedValue({ variant: expected });
    for (let i = 0; i < 3; i++) {
      const again = await post({ key: KEY });
      expect(again.body).toEqual({ key: KEY, enrolled: true, variant: expected, activated: false });
    }
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  test('the user id comes from the session, never from the request', async () => {
    launch();
    await post({ key: KEY, userId: 'u-victim', soundcloudId: 999, variant: 'guided' });
    expect(exposureCreate.mock.calls[0][0].data.userId).toBe('u-555');
    expect(exposureCreate.mock.calls[0][0].data.variant).toBe(variantFor(KEY, 555));
  });

  test('an admin is answered "not enrolled"', async () => {
    launch();
    process.env.ADMIN_IDS = '555';
    const res = await post({ key: KEY });
    expect(res.body).toMatchObject({ enrolled: false, variant: null });
    expect(writes()).toBe(0);
  });

  test('the kill switch turns it off without a deploy, even for an enrolled user', async () => {
    launch();
    exposureFindUnique.mockResolvedValue({ variant: 'guided' });
    expect((await post({ key: KEY })).body).toMatchObject({ enrolled: true, variant: 'guided' });
    process.env.FLAGS_KILL = KEY;
    expect((await post({ key: KEY })).body).toEqual({ key: KEY, enrolled: false, variant: null, activated: false });
  });

  test('an unknown key is "not enrolled", not an error', async () => {
    launch();
    const res = await post({ key: 'no-such-flag' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: 'no-such-flag', enrolled: false, variant: null, activated: false });
  });

  test.each([
    ['no body', undefined],
    ['an empty body', {}],
    ['an array key', { key: [KEY] }],
    ['a number', { key: 5 }],
    ['an object', { key: { $ne: null } }],
    ['a key with a slash', { key: 'guided/first' }],
    ['an upper-case key', { key: 'GUIDED-FIRST-RUN' }],
  ])('%s is a 400 at the validator, before anything runs', async (_label, body) => {
    launch();
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(exposureFindUnique).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
  });

  test('CSRF: a cross-site form-encoded POST fails closed', async () => {
    launch();
    const res = await request(app).post('/api/experiments/exposure').type('form').send(`key=${KEY}`);
    // express.json() ignores urlencoded bodies -> req.body empty -> validator rejects
    expect(res.status).toBe(400);
    expect(writes()).toBe(0);
  });

  test('CSRF: a JSON POST from a foreign origin is refused before the route', async () => {
    launch();
    const res = await post({ key: KEY }).set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(writes()).toBe(0);
  });

  test('a database failure is a 500, so the page serves control', async () => {
    launch();
    transaction.mockRejectedValueOnce(new Error('connection reset'));
    const res = await post({ key: KEY });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Could not resolve the experiment' });
    expect(res.body.variant).toBeUndefined();
  });

  test('middleware order: authenticateUser, then the validator, then the handler', () => {
    const layer = experimentRoutes.stack.find((l) => l.route?.path === '/exposure');
    const names = layer.route.stack.map((s) => s.handle.name);
    expect(names[0]).toBe('authenticateUser');
    expect(names.indexOf('handleValidationErrors')).toBeGreaterThan(0);
    expect(names.indexOf('handleValidationErrors')).toBeLessThan(names.length - 1);
  });
});

describe('GET /api/auth/me carries the flag lists', () => {
  const cookie = (soundcloudId) =>
    `session=${encodeURIComponent(signSession(JSON.stringify({
      userId: `u-${soundcloudId}`, soundcloudId, username: 'newbie', iat: Date.now(),
    }), process.env.SESSION_SECRET))}`;

  test('both lists are empty while every flag is off', async () => {
    userFindUnique.mockResolvedValue(freshUser());
    const res = await request(app).get('/api/auth/me').set('Cookie', cookie(555));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: 'u-555', isAdmin: false, flags: [], experiments: [] });
  });

  test('an eligible account is told which experiment to ask about; an old one is not', async () => {
    launch();
    userFindUnique.mockResolvedValue(freshUser());
    const fresh = await request(app).get('/api/auth/me').set('Cookie', cookie(555));
    expect(fresh.body.experiments).toEqual([KEY]);

    userFindUnique.mockResolvedValue({ ...freshUser(), createdAt: new Date('2025-01-01T00:00:00Z') });
    const old = await request(app).get('/api/auth/me').set('Cookie', cookie(555));
    expect(old.body.experiments).toEqual([]);
  });

  test('reading /me never records an exposure', async () => {
    launch();
    userFindUnique.mockResolvedValue(freshUser());
    await request(app).get('/api/auth/me').set('Cookie', cookie(555));
    expect(exposureFindUnique).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
  });
});
