import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development'; // disables rate limiters

const count = jest.fn().mockResolvedValue(0);
const findFirst = jest.fn().mockResolvedValue(null);
const create = jest.fn().mockResolvedValue({});

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
  default: { growthAction: { count, findFirst, create } },
}));
// The session user is mutable so a test can delete an account and log back in
// as the same SoundCloud account under a new internal id.
let currentUser = { id: 'user-a', soundcloudId: 111 };
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = currentUser;
    req.accessToken = 'at';
    req.refreshToken = 'rt';
    next();
  },
}));
// The engagement batch paces follows 2-5 s apart; a 50-follow run must not
// take minutes here.
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

function targets(n) {
  return Array.from({ length: n }, (_, i) => ({ userId: 1000 + i }));
}

afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

beforeEach(() => {
  currentUser = { id: 'user-a', soundcloudId: 111 };
  count.mockReset();
  findFirst.mockReset();
  create.mockReset();
  count.mockResolvedValue(0);
  findFirst.mockResolvedValue(null);
  create.mockResolvedValue({});
});

describe('follow caps are enforced server-side regardless of what the client asks for', () => {
  test('a user at the daily cap is refused with 429', async () => {
    // Mock: count returns the daily cap; findFirst returns null (no recent actions).
    // This means: user has used up all 50 follows in the last 24h.
    count.mockResolvedValue(GROWTH_DAILY_FOLLOW_CAP);
    findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/growth/engage').send({ targets: targets(1) });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/daily follow limit/i);
  });

  test('a user inside the session cooldown is refused with 429', async () => {
    // Mock: count returns 0 (no recent follows); findFirst returns a recent action
    // (less than 30 min ago). This triggers the cooldown check.
    count.mockResolvedValue(0);
    findFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - (GROWTH_SESSION_COOLDOWN_MS / 2)),
      sessionId: 'sess_123',
    });

    const res = await request(app).post('/api/growth/engage').send({ targets: targets(1) });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/cooldown/i);
  });

  test('requesting more targets than the remaining budget is refused with 400', async () => {
    // Mock: count returns 48 (2 follows left in daily budget); findFirst returns
    // an old action (outside cooldown, so no cooldown block). Trying to start
    // 10 follows when only 2 remain should fail with 400.
    count.mockResolvedValue(GROWTH_DAILY_FOLLOW_CAP - 2);
    findFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - GROWTH_SESSION_COOLDOWN_MS - 60 * 1000),
      sessionId: 'sess_old',
    });

    const res = await request(app).post('/api/growth/engage').send({ targets: targets(10) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/remaining in your daily budget/i);
  });

  test('an array target userId is refused with 400 (it reaches /me/followings/${id})', async () => {
    const res = await request(app).post('/api/growth/engage').send({ targets: [{ userId: [1000] }] });
    expect(res.status).toBe(400);
  });

  test('GET /growth/limits reports the cap without mutating anything', async () => {
    count.mockResolvedValue(0);
    findFirst.mockResolvedValue(null);

    const res = await request(app).get('/api/growth/limits');

    expect(res.status).toBe(200);
    expect(res.body.budget ?? res.body).toMatchObject({
      dailyCap: GROWTH_DAILY_FOLLOW_CAP,
    });
  });
});

/**
 * The cap and cooldown used to be counted only from GrowthAction rows keyed by
 * the internal User.id. Deleting the account cascades those rows away, and the
 * next login creates a new User.id, so delete + log in again handed back a
 * fresh 50-follow budget and no cooldown. The in-memory ledger is keyed by the
 * SoundCloud id, which survives both.
 *
 * Each test uses its own SoundCloud id: the ledger is module state.
 */
describe('the follow budget survives deleting the account and logging back in', () => {
  // A GrowthAction table in memory, so a cascade delete is a real removal and
  // count/findFirst answer from what is actually there.
  let rows;

  beforeEach(() => {
    rows = [];
    count.mockImplementation(async ({ where }) => rows.filter((r) =>
      r.userId === where.userId
      && (!where.actionType || r.actionType === where.actionType)
      && (!where.createdAt?.gte || r.createdAt >= where.createdAt.gte)).length);
    findFirst.mockImplementation(async ({ where }) => {
      const mine = rows.filter((r) => r.userId === where.userId);
      mine.sort((a, b) => b.createdAt - a.createdAt);
      return mine[0] ? { createdAt: mine[0].createdAt, sessionId: mine[0].sessionId } : null;
    });
    create.mockImplementation(async ({ data }) => {
      const row = { ...data, createdAt: new Date() };
      rows.push(row);
      return row;
    });
    jest.spyOn(soundcloudClient, 'followUser').mockResolvedValue({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** What DELETE /api/auth/account does to this table: cascade by userId. */
  const deleteAccount = (userId) => { rows = rows.filter((r) => r.userId !== userId); };

  async function runBatch(n) {
    const res = await request(app).post('/api/growth/engage').send({ targets: targets(n) });
    expect(res.status).toBe(202);
    for (let i = 0; i < 1000; i += 1) {
      const job = getEngagementJob(currentUser.id);
      if (job && job.status !== 'running') return job;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error('engagement batch did not finish');
  }

  test('50 follows, delete the account, log in again: /growth/engage is still 429', async () => {
    currentUser = { id: 'user-x1', soundcloudId: 9001 };
    const job = await runBatch(GROWTH_DAILY_FOLLOW_CAP);
    expect(job.followed).toBe(GROWTH_DAILY_FOLLOW_CAP);

    deleteAccount('user-x1');
    currentUser = { id: 'user-x1-new', soundcloudId: 9001 };

    const res = await request(app).post('/api/growth/engage').send({ targets: targets(1) });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/daily follow limit/i);
    expect(res.body.budget.used24h).toBe(GROWTH_DAILY_FOLLOW_CAP);

    const limits = await request(app).get('/api/growth/limits');
    expect(limits.body.remaining).toBe(0);
  });

  test('the session cooldown also survives delete + log in again', async () => {
    currentUser = { id: 'user-x2', soundcloudId: 9002 };
    await runBatch(1);

    deleteAccount('user-x2');
    currentUser = { id: 'user-x2-new', soundcloudId: 9002 };

    const res = await request(app).post('/api/growth/engage').send({ targets: targets(1) });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/cooldown/i);
  });

  test('a follow whose database write failed still counts against the cap', async () => {
    currentUser = { id: 'user-x3', soundcloudId: 9003 };
    create.mockRejectedValue(new Error('db down'));
    await runBatch(GROWTH_DAILY_FOLLOW_CAP);
    expect(rows).toHaveLength(0);

    const limits = await request(app).get('/api/growth/limits');
    expect(limits.body.used24h).toBe(GROWTH_DAILY_FOLLOW_CAP);
    expect(limits.body.remaining).toBe(0);
  });

  test('a follow SoundCloud refused does not count', async () => {
    currentUser = { id: 'user-x4', soundcloudId: 9004 };
    soundcloudClient.followUser.mockRejectedValue(new Error('403'));
    await runBatch(3);

    const limits = await request(app).get('/api/growth/limits');
    expect(limits.body.used24h).toBe(0);
  });

  test('another SoundCloud account is unaffected', async () => {
    currentUser = { id: 'user-x5', soundcloudId: 9005 };
    await runBatch(GROWTH_DAILY_FOLLOW_CAP);

    currentUser = { id: 'user-y5', soundcloudId: 9006 };
    const res = await request(app).post('/api/growth/engage').send({ targets: targets(1) });
    expect(res.status).toBe(202);
  });

  test('the remembered follows expire after 24 hours', async () => {
    currentUser = { id: 'user-x6', soundcloudId: 9007 };
    await runBatch(GROWTH_DAILY_FOLLOW_CAP);
    deleteAccount('user-x6');
    currentUser = { id: 'user-x6-new', soundcloudId: 9007 };

    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 24 * 60 * 60 * 1000 + 1000);

    const limits = await request(app).get('/api/growth/limits');
    expect(limits.body.used24h).toBe(0);
    expect(limits.body.cooldownRemainingMs).toBe(0);
  });
});
