/**
 * The experiment, end to end, against a real Postgres:
 *
 *   - the exposure route writes exactly one row per user, under the real
 *     unique constraint, with two requests racing;
 *   - the admin readout route and the SQL printed in
 *     docs/experiments/2026-11-activation-guided-first-run.md give the same
 *     numbers for the same rows. The SQL is read out of the document, so the
 *     text Cole pastes into psql is the text that is tested;
 *   - every query in the document runs inside a READ ONLY transaction;
 *   - deleting a user removes their exposure and leaves the arm's counter.
 *
 * Skipped unless TT_TEST_DATABASE_URL points at a THROWAWAY database whose
 * schema is in sync (`DATABASE_URL=… npx prisma db push`). It deletes every
 * row in users (and so everything keyed to a user), feedback and metrics, so
 * never point it at anything real. downloads-usage.integration.test.js clears
 * the same tables, so with the variable set run Jest with --runInBand.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const url = process.env.TT_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const KEY = 'guided-first-run';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const ago = (days, extraMs = 0) => new Date(NOW - days * DAY + extraMs);

if (url) {
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'development'; // rate limiters off
  process.env.ADMIN_IDS = '1';
  process.env.FLAG_GUIDED_FIRST_RUN_PERCENT = '100';
  process.env.FLAG_GUIDED_FIRST_RUN_START = ago(90).toISOString();
  delete process.env.FLAG_GUIDED_FIRST_RUN_END;
  delete process.env.FLAGS_KILL;
  delete process.env.EXPERIMENT_EXCLUDE_IDS;
}

BigInt.prototype.toJSON = function () { return this.toString(); };

let currentUser = { id: 'u-admin', soundcloudId: 1 };
jest.unstable_mockModule('../../server/middleware/auth.js', () => ({
  authenticateUser: (req, res, next) => {
    req.user = currentUser;
    next();
  },
}));

/** The named SQL blocks of the pre-registration document. */
function documentQueries() {
  const path = join(
    dirname(fileURLToPath(import.meta.url)), '..', '..',
    'docs', 'experiments', '2026-11-activation-guided-first-run.md',
  );
  const text = readFileSync(path, 'utf8');
  const blocks = {};
  // A block may be indented (the one inside a numbered list is).
  const re = /^([ \t]*)```sql\n\1-- name: ([a-z-]+)\n([\s\S]*?)^\1```/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[3].split('\n').map((line) => line.slice(m[1].length)).join('\n');
    blocks[m[2]] = body.trim().replace(/;\s*$/, '');
  }
  return blocks;
}

maybe('experiment exposure and readout against a real database', () => {
  let prisma;
  let app;
  let variantFor;
  let twoProportionTest;
  const sql = documentQueries();

  /** Runs a document query the way the document says to: unable to write. */
  const readOnly = async (text) => {
    const [, rows] = await prisma.$transaction([
      prisma.$executeRawUnsafe('SET TRANSACTION READ ONLY'),
      prisma.$queryRawUnsafe(text),
    ]);
    return rows;
  };

  // Accounts whose SoundCloud ids hash to each arm, found rather than assumed.
  const ids = { control: [], guided: [] };

  /**
   * The fixture. Each account: its arm, when it first logged in, and what it
   * did, as [action, status, days after first login].
   */
  let accounts;

  beforeAll(async () => {
    ({ default: prisma } = await import('../../server/lib/prisma.js'));
    ({ variantFor } = await import('../../server/lib/flags.js'));
    ({ twoProportionTest } = await import('../../server/lib/experiment-stats.js'));
    const { default: experimentRoutes } = await import('../../server/routes/experiments.js');
    const { default: adminRoutes } = await import('../../server/routes/admin.js');
    app = express();
    app.use(express.json());
    app.use('/api/experiments', experimentRoutes);
    app.use('/api/admin', adminRoutes);

    for (let id = 5000; ids.control.length < 6 || ids.guided.length < 6; id++) {
      const arm = variantFor(KEY, id);
      if (ids[arm].length < 6) ids[arm].push(id);
    }

    accounts = [
      // ── control ──
      // Window closed, a successful merge on day 1: activated.
      { name: 'c1', arm: 'control', firstLogin: ago(10), ops: [['merge', 'success', 1], ['resolve', 'success', 0.5]] },
      // Window closed, the only write is on day 8: outside the window, not activated. One error inside it.
      { name: 'c2', arm: 'control', firstLogin: ago(20), ops: [['from-likes', 'success', 8], ['merge', 'error', 2]] },
      // Window closed, a 'partial' write counts; so do reads as operations.
      { name: 'c3', arm: 'control', firstLogin: ago(9), ops: [['bulk-unlike', 'partial', 3], ['genre-search', 'success', 1]] },
      // Window closed, only reads and a failed write: not activated.
      { name: 'c4', arm: 'control', firstLogin: ago(30), ops: [['library-audit', 'success', 0.1], ['clone', 'error', 0.2], ['clone', 'error', 0.3]] },
      // Window still open, already activated: counted in operations, not yet in the rate.
      { name: 'c5', arm: 'control', firstLogin: ago(2), ops: [['merge', 'split', 1]] },
      // ── guided ──
      { name: 'g1', arm: 'guided', firstLogin: ago(10), ops: [['from-likes', 'success', 0.01], ['merge', 'success', 0.02]] },
      { name: 'g2', arm: 'guided', firstLogin: ago(12), ops: [['clone', 'success', 6.9]] },
      // Exactly at the edge: 7 days after first login is outside the window.
      { name: 'g3', arm: 'guided', firstLogin: ago(15), ops: [['merge', 'success', 7]] },
      // Page opens, latency probes and logins are not operations.
      { name: 'g4', arm: 'guided', firstLogin: ago(8), ops: [['view:dashboard', 'success', 0], ['read:likes', 'error', 0.1], ['auth-login', 'success', 0]] },
      { name: 'g5', arm: 'guided', firstLogin: ago(3), ops: [['merge', 'error', 1]] },
      { name: 'g6', arm: 'guided', firstLogin: ago(1), ops: [] },
    ].map((account) => {
      const soundcloudId = ids[account.arm].shift();
      return { ...account, soundcloudId, id: `u-${account.name}` };
    });

    await prisma.feedback.deleteMany();
    await prisma.metric.deleteMany();
    await prisma.user.deleteMany();

    await prisma.user.createMany({
      data: [
        { id: 'u-admin', soundcloudId: 1, username: 'admin', createdAt: ago(200) },
        // Not in the experiment, but inside the baseline window, activated.
        { id: 'u-outsider', soundcloudId: 2, username: 'outsider', createdAt: ago(40) },
        // First seen before the baseline window: in neither.
        { id: 'u-old', soundcloudId: 3, username: 'old', createdAt: ago(120) },
        ...accounts.map((a) => ({ id: a.id, soundcloudId: a.soundcloudId, username: a.name, createdAt: a.firstLogin })),
      ],
    });

    const op = (userId, firstLogin, [action, status, afterDays]) => ({
      userId, action, status, createdAt: new Date(firstLogin.getTime() + afterDays * DAY),
    });
    await prisma.operationLog.createMany({
      data: [
        ...accounts.flatMap((a) => a.ops.map((o) => op(a.id, a.firstLogin, o))),
        op('u-outsider', ago(40), ['merge', 'success', 1]),
        op('u-old', ago(120), ['merge', 'success', 1]),
        op('u-admin', ago(200), ['merge', 'error', 199]),
      ],
    });

    const fb = (name, type, status, afterDays) => {
      const a = accounts.find((x) => x.name === name);
      return {
        userId: a.id, soundcloudId: a.soundcloudId, type, status, message: `fixture ${name} ${type}`,
        messageHash: `${name}-${type}-${afterDays}`, createdAt: new Date(a.firstLogin.getTime() + afterDays * DAY),
      };
    };
    await prisma.feedback.createMany({
      data: [
        fb('c1', 'feature', 'new', 1),
        fb('g1', 'bug', 'seen', 2),
        fb('g1', 'bug', 'new', 3), // a second report from the same account
        fb('g2', 'bug', 'spam', 1), // spam is not feedback
        fb('g3', 'bug', 'new', 9), // outside the window
        fb('g4', 'other', 'done', 6),
      ],
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const enrol = async (account) => {
    currentUser = { id: account.id, soundcloudId: account.soundcloudId, createdAt: account.firstLogin };
    return request(app).post('/api/experiments/exposure').send({ key: KEY });
  };

  test('the document carries every query this suite reads from it', () => {
    expect(Object.keys(sql).sort()).toEqual(['analysis', 'assignment-audit', 'baseline', 'readout']);
  });

  test('nobody is enrolled with the flag off, and nothing is written', async () => {
    const saved = process.env.FLAG_GUIDED_FIRST_RUN_PERCENT;
    delete process.env.FLAG_GUIDED_FIRST_RUN_PERCENT;
    try {
      const fresh = accounts.find((a) => a.name === 'g6');
      const res = await enrol(fresh);
      expect(res.body).toEqual({ key: KEY, enrolled: false, variant: null, activated: false });
      expect(await prisma.experimentExposure.count()).toBe(0);
      expect(await prisma.metric.count()).toBe(0);
    } finally {
      process.env.FLAG_GUIDED_FIRST_RUN_PERCENT = saved;
    }
  });

  test('two racing requests from one new account leave one exposure and count it once', async () => {
    const fresh = accounts.find((a) => a.name === 'g6');
    const responses = await Promise.all([enrol(fresh), enrol(fresh), enrol(fresh)]);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ key: KEY, enrolled: true, variant: 'guided', activated: false });
    }
    const rows = await prisma.experimentExposure.findMany({ where: { userId: fresh.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ experimentKey: KEY, variant: 'guided' });
    const counter = await prisma.metric.findUnique({ where: { key: `experiment_enrolled:${KEY}:guided` } });
    expect(counter.value).toBe(1n);

    // And again later: same answer, still one row, still counted once.
    const again = await enrol(fresh);
    expect(again.body.variant).toBe('guided');
    expect(await prisma.experimentExposure.count({ where: { userId: fresh.id } })).toBe(1);
    expect((await prisma.metric.findUnique({ where: { key: `experiment_enrolled:${KEY}:guided` } })).value).toBe(1n);
  });

  test('the route refuses the accounts the pre-registration excludes', async () => {
    // Already activated before ever reaching the dashboard.
    const activated = accounts.find((a) => a.name === 'c5');
    expect((await enrol(activated)).body).toMatchObject({ enrolled: false, variant: null });
    // Past the 7-day enrolment window.
    const late = accounts.find((a) => a.name === 'g4');
    expect((await enrol(late)).body).toMatchObject({ enrolled: false, variant: null });
    // An admin.
    currentUser = { id: 'u-admin', soundcloudId: 1, createdAt: ago(1) };
    const admin = await request(app).post('/api/experiments/exposure').send({ key: KEY });
    expect(admin.body).toMatchObject({ enrolled: false, variant: null });
    // First seen before the experiment started.
    currentUser = { id: 'u-old', soundcloudId: 3, createdAt: ago(120) };
    const old = await request(app).post('/api/experiments/exposure').send({ key: KEY });
    expect(old.body).toMatchObject({ enrolled: false, variant: null });

    expect(await prisma.experimentExposure.count()).toBe(1);
  });

  test('the database itself refuses a second exposure for the same user and experiment', async () => {
    const fresh = accounts.find((a) => a.name === 'g6');
    await expect(
      prisma.experimentExposure.create({ data: { userId: fresh.id, experimentKey: KEY, variant: 'control' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  describe('with every fixture account enrolled', () => {
    beforeAll(async () => {
      // The remaining accounts are enrolled as of their own first dashboard
      // load, which the route cannot be asked to do in the past. The arm is
      // the one their id hashes to, which is what the route would record.
      const rest = accounts.filter((a) => a.name !== 'g6');
      await prisma.experimentExposure.createMany({
        data: rest.map((a) => ({
          userId: a.id, experimentKey: KEY, variant: variantFor(KEY, a.soundcloudId), createdAt: a.firstLogin,
        })),
      });
      // The counters as the route would have left them, plus one control and
      // two guided accounts that enrolled and have since been deleted.
      await prisma.metric.upsert({
        where: { key: `experiment_enrolled:${KEY}:control` },
        create: { key: `experiment_enrolled:${KEY}:control`, value: 6n },
        update: { value: 6n },
      });
      await prisma.metric.update({ where: { key: `experiment_enrolled:${KEY}:guided` }, data: { value: 8n } });
    });

    // Worked out by hand from the fixture above.
    const EXPECTED = {
      control: {
        enrolled: 5, enrolledEver: 6, windowComplete: 4, activated: 2,
        operations: 9, operationErrors: 3, usersWithError: 2,
        feedbackSubmissions: 1, feedbackUsers: 1, bugFeedbackUsers: 0,
      },
      guided: {
        enrolled: 6, enrolledEver: 8, windowComplete: 4, activated: 2,
        operations: 4, operationErrors: 1, usersWithError: 1,
        feedbackSubmissions: 3, feedbackUsers: 2, bugFeedbackUsers: 1,
      },
    };

    test('the admin route reports the hand-computed numbers', async () => {
      currentUser = { id: 'u-admin', soundcloudId: 1 };
      const res = await request(app).get(`/api/admin/experiments/${KEY}/readout`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('enrolling');
      expect(res.body.test).toBeNull();
      for (const arm of res.body.variants) {
        expect(arm).toMatchObject(EXPECTED[arm.variant]);
      }
      const [control, guided] = res.body.variants;
      expect(control.activationRate).toBe(0.5);
      expect(control.operationErrorRate).toBeCloseTo(3 / 9, 12);
      expect(control.deletedSinceEnrolment).toBe(1);
      expect(guided.deletedSinceEnrolment).toBe(2);
      expect(res.body.srm).toMatchObject({ basis: 'enrolledEver', observed: [6, 8] });
    });

    test('the readout query in the document gives the same numbers as the route', async () => {
      currentUser = { id: 'u-admin', soundcloudId: 1 };
      const [route, rows] = await Promise.all([
        request(app).get(`/api/admin/experiments/${KEY}/readout`),
        readOnly(sql.readout),
      ]);
      expect(rows.map((r) => r.variant)).toEqual(['control', 'guided']);
      for (const row of rows) {
        const arm = route.body.variants.find((v) => v.variant === row.variant);
        expect({
          enrolled: row.enrolled,
          enrolledEver: row.enrolled_ever,
          windowComplete: row.window_complete,
          activated: row.activated,
          operations: row.operations,
          operationErrors: row.operation_errors,
          usersWithError: row.users_with_error,
          feedbackSubmissions: row.feedback_submissions,
          feedbackUsers: row.feedback_users,
          bugFeedbackUsers: row.bug_feedback_users,
        }).toEqual({
          enrolled: arm.enrolled,
          enrolledEver: arm.enrolledEver,
          windowComplete: arm.windowComplete,
          activated: arm.activated,
          operations: arm.operations,
          operationErrors: arm.operationErrors,
          usersWithError: arm.usersWithError,
          feedbackSubmissions: arm.feedbackSubmissions,
          feedbackUsers: arm.feedbackUsers,
          bugFeedbackUsers: arm.bugFeedbackUsers,
        });
        expect(arm).toMatchObject(EXPECTED[row.variant]);
      }
    });

    test('the analysis query in the document agrees with the test the console runs', async () => {
      const [row] = await readOnly(sql.analysis);
      // c5, g5 and g6 are still inside their windows.
      expect(row.windows_still_open).toBe(3);
      expect(row).toMatchObject({ control_n: 4, control_activated: 2, guided_n: 4, guided_activated: 2 });
      expect(row.z).toBe(0);
      expect(row.p_value).toBe(1);

      // Move one activation so the arms differ, and compare every figure.
      const g3 = accounts.find((a) => a.name === 'g3');
      const g4 = accounts.find((a) => a.name === 'g4');
      await prisma.operationLog.createMany({
        data: [g3, g4].map((a) => ({
          userId: a.id, action: 'merge', status: 'success', createdAt: new Date(a.firstLogin.getTime() + DAY),
        })),
      });
      try {
        const [moved] = await readOnly(sql.analysis);
        const js = twoProportionTest({ controlSuccesses: 2, controlTotal: 4, treatmentSuccesses: 4, treatmentTotal: 4 });
        expect(moved).toMatchObject({ control_n: 4, control_activated: 2, guided_n: 4, guided_activated: 4 });
        expect(moved.control_rate).toBeCloseTo(js.controlRate, 12);
        expect(moved.guided_rate).toBeCloseTo(js.treatmentRate, 12);
        expect(moved.difference).toBeCloseTo(js.difference, 12);
        expect(moved.z).toBeCloseTo(js.z, 10);
        expect(moved.p_value).toBeCloseTo(js.pValue, 10);
        expect(moved.ci95_low).toBeCloseTo(js.ci95[0], 8);
        expect(moved.ci95_high).toBeCloseTo(js.ci95[1], 8);

        // And the route, once the experiment is closed and every window has.
        const savedEnd = process.env.FLAG_GUIDED_FIRST_RUN_END;
        process.env.FLAG_GUIDED_FIRST_RUN_END = ago(60).toISOString();
        const open = accounts.filter((a) => ['c5', 'g5', 'g6'].includes(a.name));
        await prisma.user.updateMany({ where: { id: { in: open.map((a) => a.id) } }, data: { createdAt: ago(70) } });
        try {
          currentUser = { id: 'u-admin', soundcloudId: 1 };
          const res = await request(app).get(`/api/admin/experiments/${KEY}/readout`);
          expect(res.body.status).toBe('final');
          const [final] = await readOnly(sql.analysis);
          expect(final.windows_still_open).toBe(0);
          expect(res.body.test.z).toBeCloseTo(final.z, 10);
          expect(res.body.test.pValue).toBeCloseTo(final.p_value, 10);
          expect(res.body.test.difference).toBeCloseTo(final.difference, 12);
          expect(res.body.test.ci95[0]).toBeCloseTo(final.ci95_low, 8);
          expect(res.body.variants.map((v) => [v.windowComplete, v.activated])).toEqual([
            [final.control_n, final.control_activated],
            [final.guided_n, final.guided_activated],
          ]);
        } finally {
          if (savedEnd === undefined) delete process.env.FLAG_GUIDED_FIRST_RUN_END;
          else process.env.FLAG_GUIDED_FIRST_RUN_END = savedEnd;
          for (const a of open) {
            await prisma.user.update({ where: { id: a.id }, data: { createdAt: a.firstLogin } });
          }
        }
      } finally {
        await prisma.operationLog.deleteMany({
          where: { userId: { in: [g3.id, g4.id] }, action: 'merge', createdAt: { gte: ago(14.5), lte: ago(6.5) } },
        });
      }
    });

    test('the assignment audit recomputes every arm in SQL and finds no mismatch, then finds a planted one', async () => {
      const clean = await readOnly(sql['assignment-audit']);
      expect(clean).toEqual([
        { recorded: 'control', recomputed: 'control', accounts: 5 },
        { recorded: 'guided', recomputed: 'guided', accounts: 6 },
      ]);

      const c1 = accounts.find((a) => a.name === 'c1');
      const where = { userId_experimentKey: { userId: c1.id, experimentKey: KEY } };
      await prisma.experimentExposure.update({ where, data: { variant: 'guided' } });
      try {
        const planted = await readOnly(sql['assignment-audit']);
        expect(planted).toContainEqual({ recorded: 'guided', recomputed: 'control', accounts: 1 });
      } finally {
        await prisma.experimentExposure.update({ where, data: { variant: 'control' } });
      }
    });

    test('the baseline query counts new accounts whose window has closed, by week and in total', async () => {
      const rows = await readOnly(sql.baseline);
      const total = rows.find((r) => r.weeks_back === 'ALL');
      // In the 56 days ending 7 days ago: c1 c2 c3 c4, g1 g2 g3 g4 and the
      // outsider. c5, g5 and g6 are too recent; the admin and u-old too old.
      // Activated within 7 days of first login: c1, c3, g1, g2, the outsider.
      expect(total).toMatchObject({ new_accounts: 9, activated: 5 });
      expect(Number(total.activation_rate)).toBeCloseTo(5 / 9, 4);
      expect(Number(total.per_day)).toBeCloseTo(9 / 56, 2);
      const weekly = rows.filter((r) => r.weeks_back !== 'ALL');
      expect(weekly.reduce((sum, r) => sum + r.new_accounts, 0)).toBe(9);
      expect(weekly.reduce((sum, r) => sum + r.activated, 0)).toBe(5);
      // g4 (8 days ago), c3 (9), c1 and g1 (10) and g2 (12) are the newest week.
      expect(weekly.find((r) => r.weeks_back === '0')).toMatchObject({ new_accounts: 5, activated: 4 });
    });

    test('a document query that tried to write would be refused', async () => {
      await expect(readOnly('DELETE FROM metrics')).rejects.toThrow(/read-only transaction/);
    });

    test('deleting an account removes its exposure; the arm counter remembers it', async () => {
      const g2 = accounts.find((a) => a.name === 'g2');
      await prisma.user.delete({ where: { id: g2.id } });
      expect(await prisma.experimentExposure.count({ where: { userId: g2.id } })).toBe(0);
      expect((await prisma.metric.findUnique({ where: { key: `experiment_enrolled:${KEY}:guided` } })).value).toBe(8n);

      currentUser = { id: 'u-admin', soundcloudId: 1 };
      const res = await request(app).get(`/api/admin/experiments/${KEY}/readout`);
      const guided = res.body.variants.find((v) => v.variant === 'guided');
      expect(guided).toMatchObject({ enrolled: 5, enrolledEver: 8, deletedSinceEnrolment: 3 });
    });
  });
});
