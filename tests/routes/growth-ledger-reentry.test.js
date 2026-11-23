import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Second independent pass over the C5 fix (follow cap keyed by SoundCloud id).
 * growth-limits.test.js covers one full batch → delete → re-login. These cover
 * what it does not:
 * - delete + re-login WHILE a batch is still running: the old job is keyed by
 *   the old User.id, so JOB_RUNNING cannot stop a second job; only the ledger's
 *   session-start record can.
 * - a budget spent across several delete/re-login cycles, each after the
 *   cooldown: the ledger must keep the running total (max(DB, ledger) with DB
 *   reset to 0 each time).
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';

let rows = [];
const count = jest.fn(async ({ where }) => rows.filter((r) =>
  r.userId === where.userId
  && (!where.actionType || r.actionType === where.actionType)
  && (!where.createdAt?.gte || r.createdAt >= where.createdAt.gte)).length);
const findFirst = jest.fn(async ({ where }) => {
  const mine = rows.filter((r) => r.userId === where.userId).sort((a, b) => b.createdAt - a.createdAt);
  return mine[0] ? { createdAt: mine[0].createdAt, sessionId: mine[0].sessionId } : null;
});
const create = jest.fn(async ({ data }) => {
  const row = { ...data, createdAt: new Date(Date.now()) };
  rows.push(row);
  return row;
});

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
  default: { growthAction: { count, findFirst, create } },
}));
let currentUser = { id: 'u', soundcloudId: 1 };
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = currentUser;
    req.accessToken = 'at';
    req.refreshToken = 'rt';
    next();
  },
}));
const actualPacing = await import('../../server/lib/pacing.js');
jest.unstable_mockModule('../../server/lib/pacing.js', () => ({
  ...actualPacing,
  sleep: jest.fn(async () => {}),
}));

const { default: growthRoutes } = await import('../../server/routes/growth.js');
const { GROWTH_DAILY_FOLLOW_CAP, GROWTH_SESSION_COOLDOWN_MS, getEngagementJob } =
  await import('../../server/lib/growth-engine.js');
const { soundcloudClient } = await import('../../server/lib/soundcloud-client.js');

const app = express();
app.use(express.json());
app.use('/api', growthRoutes);

const targets = (n, base = 1000) => Array.from({ length: n }, (_, i) => ({ userId: base + i }));
const deleteAccount = (userId) => { rows = rows.filter((r) => r.userId !== userId); };

async function waitForJob(userId) {
  for (let i = 0; i < 2000; i += 1) {
    const job = getEngagementJob(userId);
    if (job && job.status !== 'running') return job;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('engagement batch did not finish');
}

let clock;
beforeEach(() => {
  rows = [];
  clock = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => { jest.restoreAllMocks(); });
afterAll(() => { process.env.NODE_ENV = ORIGINAL_NODE_ENV; });

test('delete + re-login while a batch is still running cannot start a second batch', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  jest.spyOn(soundcloudClient, 'followUser').mockImplementation(async () => {
    calls += 1;
    if (calls > 1) await gate; // the first follow lands, then the job stalls
    return {};
  });

  currentUser = { id: 'run-old', soundcloudId: 7101 };
  const first = await request(app).post('/api/growth/engage').send({ targets: targets(GROWTH_DAILY_FOLLOW_CAP) });
  expect(first.status).toBe(202);
  for (let i = 0; i < 50 && calls < 2; i += 1) await new Promise((r) => setImmediate(r));
  expect(getEngagementJob('run-old').status).toBe('running');

  deleteAccount('run-old');
  currentUser = { id: 'run-new', soundcloudId: 7101 };
  const second = await request(app).post('/api/growth/engage').send({ targets: targets(10, 5000) });
  expect(second.status).toBe(429);
  expect(getEngagementJob('run-new')).toBeFalsy();

  release();
  await waitForJob('run-old');
});

test('a budget spent across repeated delete/re-login cycles keeps its running total', async () => {
  jest.spyOn(soundcloudClient, 'followUser').mockResolvedValue({});
  const sc = 7102;

  currentUser = { id: 'cyc-1', soundcloudId: sc };
  let res = await request(app).post('/api/growth/engage').send({ targets: targets(30) });
  expect(res.status).toBe(202);
  await waitForJob('cyc-1');

  deleteAccount('cyc-1');
  clock += GROWTH_SESSION_COOLDOWN_MS + 1000;
  currentUser = { id: 'cyc-2', soundcloudId: sc };

  res = await request(app).post('/api/growth/engage').send({ targets: targets(21) });
  expect(res.status).toBe(400); // only 20 remain
  expect(res.body.budget.used24h).toBe(30);

  res = await request(app).post('/api/growth/engage').send({ targets: targets(20) });
  expect(res.status).toBe(202);
  await waitForJob('cyc-2');

  deleteAccount('cyc-2');
  clock += GROWTH_SESSION_COOLDOWN_MS + 1000;
  currentUser = { id: 'cyc-3', soundcloudId: sc };

  res = await request(app).post('/api/growth/engage').send({ targets: targets(1) });
  expect(res.status).toBe(429);
  expect(res.body.budget.used24h).toBe(GROWTH_DAILY_FOLLOW_CAP);

  // And the first 30 age out first: 24h after them, 30 come back, not 50.
  clock += 24 * 60 * 60 * 1000 - 2 * (GROWTH_SESSION_COOLDOWN_MS + 1000) + 1000;
  const limits = await request(app).get('/api/growth/limits');
  expect(limits.body.used24h).toBe(20);
});
