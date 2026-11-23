import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// GET /api/admin/experiments and /api/admin/experiments/:key/readout: the
// admin boundary, the 404s, and the shape the console reads. The arithmetic
// is covered in tests/experiments.test.js; the SQL in the integration test.

const queryRaw = jest.fn();
const metricFindMany = jest.fn();
const operationLogCount = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
  default: {
    $queryRaw: queryRaw,
    metric: { findMany: metricFindMany },
    operationLog: { count: operationLogCount },
  },
}));

let currentUser = { id: 'u-admin', soundcloudId: 1 };
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    if (!currentUser) return res.status(401).json({ error: 'Not authenticated' });
    req.user = currentUser;
    next();
  },
}));

const { default: adminRoutes } = await import('../../server/routes/admin.js');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const KEY = 'guided-first-run';
const NAMES = ['ADMIN_IDS', 'FLAG_GUIDED_FIRST_RUN_PERCENT', 'FLAG_GUIDED_FIRST_RUN_START', 'FLAG_GUIDED_FIRST_RUN_END', 'FLAGS_KILL'];
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

beforeEach(() => {
  for (const name of NAMES) delete process.env[name];
  process.env.ADMIN_IDS = '1';
  currentUser = { id: 'u-admin', soundcloudId: 1 };
  queryRaw.mockReset().mockResolvedValue([]);
  metricFindMany.mockReset().mockResolvedValue([]);
  operationLogCount.mockReset().mockResolvedValue(0);
});
afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('the admin boundary', () => {
  test.each(['/api/admin/experiments', `/api/admin/experiments/${KEY}/readout`])(
    '%s is 403 for a signed-in non-admin and issues no query',
    async (path) => {
      currentUser = { id: 'u-2', soundcloudId: 2 };
      const res = await request(app).get(path);
      expect(res.status).toBe(403);
      expect(queryRaw).not.toHaveBeenCalled();
      expect(metricFindMany).not.toHaveBeenCalled();
    },
  );

  test('and 403 for everyone when ADMIN_IDS is unset', async () => {
    delete process.env.ADMIN_IDS;
    const res = await request(app).get(`/api/admin/experiments/${KEY}/readout`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/experiments', () => {
  test('lists every flag with the configuration this process is running', async () => {
    const res = await request(app).get('/api/admin/experiments');
    expect(res.status).toBe(200);
    expect(res.body.flags).toEqual([
      expect.objectContaining({
        key: KEY,
        kind: 'experiment',
        percent: 0,
        percentSource: 'default',
        killed: false,
        start: null,
        end: null,
        newUsersOnly: true,
        variants: [{ name: 'control', weight: 50 }, { name: 'guided', weight: 50 }],
        doc: 'docs/experiments/2026-11-activation-guided-first-run.md',
        problems: [],
        gate: null,
      }),
    ]);
  });

  test('shows a setting that was refused, and a kill', async () => {
    process.env.FLAG_GUIDED_FIRST_RUN_PERCENT = '50%';
    process.env.FLAGS_KILL = 'all';
    const res = await request(app).get('/api/admin/experiments');
    const [flag] = res.body.flags;
    expect(flag).toMatchObject({ percent: 0, percentSource: 'invalid', killed: true });
    expect(flag.problems.join(' ')).toMatch(/PERCENT is not a whole number/);
  });

  test('reports the settings in force, as ISO times', async () => {
    process.env.FLAG_GUIDED_FIRST_RUN_PERCENT = '100';
    process.env.FLAG_GUIDED_FIRST_RUN_START = '2026-12-01T00:00:00Z';
    process.env.FLAG_GUIDED_FIRST_RUN_END = '2026-12-15T00:00:00Z';
    const res = await request(app).get('/api/admin/experiments');
    expect(res.body.flags[0]).toMatchObject({
      percent: 100, percentSource: 'setting', start: '2026-12-01T00:00:00.000Z', end: '2026-12-15T00:00:00.000Z',
    });
  });
});

describe('GET /api/admin/experiments/:key/readout', () => {
  test.each(['no-such-flag', 'constructor', '..%2F..', 'UPPER', 'a'])('%s is a 404', async (key) => {
    const res = await request(app).get(`/api/admin/experiments/${key}/readout`);
    expect(res.status).toBe(404);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  test('before launch: both arms at zero, not started, nothing compared', async () => {
    const res = await request(app).get(`/api/admin/experiments/${KEY}/readout`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: KEY, status: 'not-started', windowDays: 7, srm: null, test: null, guardrailTests: null });
    expect(res.body.variants.map((v) => [v.variant, v.enrolled, v.activationRate])).toEqual([
      ['control', 0, null],
      ['guided', 0, null],
    ]);
  });

  test('returns per arm: enrolled, activated, the rate and the guardrails', async () => {
    process.env.FLAG_GUIDED_FIRST_RUN_PERCENT = '100';
    process.env.FLAG_GUIDED_FIRST_RUN_START = '2020-01-01T00:00:00Z';
    process.env.FLAG_GUIDED_FIRST_RUN_END = '2020-01-15T00:00:00Z';
    queryRaw.mockResolvedValue([
      { variant: 'control', enrolled: 400, window_complete: 400, activated: 120, operations: 900, operation_errors: 45, users_with_error: 30, feedback_submissions: 6, feedback_users: 5, bug_feedback_users: 2 },
      { variant: 'guided', enrolled: 410, window_complete: 410, activated: 164, operations: 1100, operation_errors: 44, users_with_error: 29, feedback_submissions: 8, feedback_users: 7, bug_feedback_users: 3 },
    ]);
    metricFindMany.mockResolvedValue([
      { key: `experiment_enrolled:${KEY}:control`, value: 404n },
      { key: `experiment_enrolled:${KEY}:guided`, value: 411n },
    ]);
    const res = await request(app).get(`/api/admin/experiments/${KEY}/readout`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('final');
    const [control, guided] = res.body.variants;
    expect(control).toMatchObject({
      variant: 'control', enrolled: 400, enrolledEver: 404, deletedSinceEnrolment: 4, windowComplete: 400,
      activated: 120, activationRate: 0.3, operations: 900, operationErrors: 45, operationErrorRate: 0.05,
      feedbackSubmissions: 6, feedbackUsers: 5, bugFeedbackUsers: 2,
    });
    expect(guided).toMatchObject({ variant: 'guided', enrolled: 410, activated: 164, activationRate: 0.4, operationErrorRate: 0.04 });
    expect(res.body.test.difference).toBeCloseTo(0.1, 12);
    expect(res.body.test.pValue).toBeLessThan(0.01);
    expect(res.body.srm.basis).toBe('enrolledEver');
  });

  test('a database error is a 500 with no detail', async () => {
    queryRaw.mockRejectedValue(new Error('relation "experiment_exposures" does not exist'));
    const res = await request(app).get(`/api/admin/experiments/${KEY}/readout`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch the experiment readout' });
  });
});
