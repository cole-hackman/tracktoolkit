import { jest } from '@jest/globals';

// resolveExposure, experimentReadout and rolloutGate against a mocked client,
// so every read and write they issue can be inspected. The SQL itself is run
// for real in tests/routes/experiment-readout.integration.test.js.

const exposureFindUnique = jest.fn();
const exposureCreate = jest.fn((args) => ({ __op: 'exposure.create', args }));
const metricUpsert = jest.fn((args) => ({ __op: 'metric.upsert', args }));
const metricFindMany = jest.fn();
const operationLogFindFirst = jest.fn();
const operationLogCount = jest.fn();
const transaction = jest.fn();
const queryRaw = jest.fn();

jest.unstable_mockModule('../server/lib/prisma.js', () => ({
  default: {
    experimentExposure: { findUnique: exposureFindUnique, create: exposureCreate },
    metric: { upsert: metricUpsert, findMany: metricFindMany },
    operationLog: { findFirst: operationLogFindFirst, count: operationLogCount },
    $transaction: transaction,
    $queryRaw: queryRaw,
  },
}));

const {
  WRITE_ACTIONS,
  SUCCESS_STATUSES,
  enrolledMetricKey,
  hasActivated,
  resolveExposure,
  experimentReadout,
  rolloutGate,
} = await import('../server/lib/experiments.js');
const { variantFor, readFlagConfig } = await import('../server/lib/flags.js');

const KEY = 'guided-first-run';
const DAY = 24 * 60 * 60 * 1000;
const START = '2026-12-01T00:00:00Z';
const FIRST_LOGIN = new Date('2026-12-02T10:00:00Z');
const NOW = FIRST_LOGIN.getTime() + 60_000;

const env = (extra = {}) => ({
  FLAG_GUIDED_FIRST_RUN_PERCENT: '100',
  FLAG_GUIDED_FIRST_RUN_START: START,
  ...extra,
});
const user = (soundcloudId = 555) => ({ id: `u-${soundcloudId}`, soundcloudId, createdAt: FIRST_LOGIN });

const NOT_ENROLLED = { enrolled: false, variant: null, activated: false };
const writes = () => [exposureCreate, metricUpsert, transaction].reduce((n, m) => n + m.mock.calls.length, 0);
const reads = () => exposureFindUnique.mock.calls.length + operationLogFindFirst.mock.calls.length;

beforeEach(() => {
  for (const mock of [exposureFindUnique, exposureCreate, metricUpsert, metricFindMany, operationLogFindFirst, operationLogCount, transaction, queryRaw]) {
    mock.mockClear();
  }
  exposureFindUnique.mockResolvedValue(null);
  operationLogFindFirst.mockResolvedValue(null);
  transaction.mockResolvedValue([]);
  metricFindMany.mockResolvedValue([]);
  queryRaw.mockResolvedValue([]);
});

describe('what counts as activation', () => {
  test('write actions are distinct slugs and exclude reads, downloads and logins', () => {
    expect(new Set(WRITE_ACTIONS).size).toBe(WRITE_ACTIONS.length);
    for (const notAWrite of ['resolve', 'batch-resolve', 'genre-search', 'library-audit', 'playlist-compare',
      'playlist-keyword-search', 'proxy-download', 'download-links', 'gate-download', 'growth-discover',
      'growth-check-followbacks', 'auth-login', 'auth-logout', 'admin-re-resolve']) {
      expect(WRITE_ACTIONS).not.toContain(notAWrite);
    }
    expect(WRITE_ACTIONS).toEqual(expect.arrayContaining(['merge', 'from-likes', 'clone', 'bulk-unlike']));
    expect([...SUCCESS_STATUSES]).toEqual(['success', 'split', 'partial']);
  });

  test('hasActivated looks for one successful write by this user', async () => {
    operationLogFindFirst.mockResolvedValueOnce({ id: 'op-1' });
    await expect(hasActivated('u-1')).resolves.toBe(true);
    expect(operationLogFindFirst).toHaveBeenCalledWith({
      where: { userId: 'u-1', action: { in: [...WRITE_ACTIONS] }, status: { in: ['success', 'split', 'partial'] } },
      select: { id: true },
    });
    await expect(hasActivated('u-1')).resolves.toBe(false);
  });
});

describe('resolveExposure: who is not enrolled', () => {
  test.each([
    ['an unknown key', 'nope', env()],
    ['a flag at 0 percent', KEY, env({ FLAG_GUIDED_FIRST_RUN_PERCENT: '0' })],
    ['no settings at all', KEY, {}],
    ['a killed flag', KEY, env({ FLAGS_KILL: 'all' })],
    ['no start', KEY, { FLAG_GUIDED_FIRST_RUN_PERCENT: '100' }],
    ['a first login before the start', KEY, env({ FLAG_GUIDED_FIRST_RUN_START: '2026-12-03T00:00:00Z' })],
    ['an excluded account', KEY, env({ EXPERIMENT_EXCLUDE_IDS: '555' })],
  ])('%s: control, and the database is not touched at all', async (_label, key, settings) => {
    await expect(resolveExposure(key, user(), { now: NOW, env: settings })).resolves.toEqual(NOT_ENROLLED);
    expect(reads()).toBe(0);
    expect(writes()).toBe(0);
  });

  test('an admin is never enrolled', async () => {
    const before = process.env.ADMIN_IDS;
    process.env.ADMIN_IDS = '555';
    try {
      await expect(resolveExposure(KEY, user(), { now: NOW, env: env() })).resolves.toEqual(NOT_ENROLLED);
      expect(reads() + writes()).toBe(0);
    } finally {
      if (before === undefined) delete process.env.ADMIN_IDS;
      else process.env.ADMIN_IDS = before;
    }
  });

  test('a killed flag is control even for someone enrolled earlier', async () => {
    exposureFindUnique.mockResolvedValue({ variant: 'guided' });
    await expect(resolveExposure(KEY, user(), { now: NOW, env: env({ FLAGS_KILL: KEY }) })).resolves.toEqual(NOT_ENROLLED);
    expect(reads()).toBe(0);
  });

  test('someone who has already completed a write could not see a difference: not enrolled', async () => {
    operationLogFindFirst.mockResolvedValue({ id: 'op-1' });
    await expect(resolveExposure(KEY, user(), { now: NOW, env: env() })).resolves.toEqual(NOT_ENROLLED);
    expect(writes()).toBe(0);
  });

  test('past the enrolment window nobody new is enrolled', async () => {
    const late = FIRST_LOGIN.getTime() + 7 * DAY;
    await expect(resolveExposure(KEY, user(), { now: late, env: env() })).resolves.toEqual(NOT_ENROLLED);
    expect(writes()).toBe(0);
    // One millisecond earlier is still inside it.
    await expect(resolveExposure(KEY, user(), { now: late - 1, env: env() })).resolves.toMatchObject({ enrolled: true });
  });

  test('a rollout flag has no exposure', async () => {
    const flags = { thing: { kind: 'rollout', description: '', rolloutPercent: 100 } };
    await expect(resolveExposure('thing', user(), { now: NOW, env: {}, flags })).resolves.toEqual(NOT_ENROLLED);
    expect(reads() + writes()).toBe(0);
  });
});

describe('resolveExposure: recording an exposure', () => {
  test('the first call writes the row and the counter in one transaction', async () => {
    const expected = variantFor(KEY, 555);
    const result = await resolveExposure(KEY, user(), { now: NOW, env: env() });
    expect(result).toEqual({ enrolled: true, variant: expected, activated: false });

    expect(transaction).toHaveBeenCalledTimes(1);
    const [steps] = transaction.mock.calls[0];
    expect(steps.map((s) => s.__op)).toEqual(['exposure.create', 'metric.upsert']);
    expect(exposureCreate).toHaveBeenCalledWith({
      data: { userId: 'u-555', experimentKey: KEY, variant: expected },
    });
    const counterKey = `experiment_enrolled:${KEY}:${expected}`;
    expect(enrolledMetricKey(KEY, expected)).toBe(counterKey);
    expect(metricUpsert).toHaveBeenCalledWith({
      where: { key: counterKey },
      create: { key: counterKey, value: 1n },
      update: { value: { increment: 1 } },
    });
  });

  test('both arms are recorded, each under its own counter', async () => {
    const seen = new Set();
    for (let id = 1000; id < 1040; id++) {
      const result = await resolveExposure(KEY, user(id), { now: NOW, env: env() });
      expect(result.variant).toBe(variantFor(KEY, id));
      seen.add(result.variant);
    }
    expect(seen).toEqual(new Set(['control', 'guided']));
    expect(transaction).toHaveBeenCalledTimes(40);
    const counters = new Set(metricUpsert.mock.calls.map(([args]) => args.where.key));
    expect(counters).toEqual(new Set([
      'experiment_enrolled:guided-first-run:control',
      'experiment_enrolled:guided-first-run:guided',
    ]));
  });

  test('a second call returns the recorded arm and writes nothing', async () => {
    exposureFindUnique.mockResolvedValue({ variant: 'guided' });
    const result = await resolveExposure(KEY, user(), { now: NOW, env: env() });
    expect(result).toEqual({ enrolled: true, variant: 'guided', activated: false });
    expect(exposureFindUnique).toHaveBeenCalledWith({
      where: { userId_experimentKey: { userId: 'u-555', experimentKey: KEY } },
      select: { variant: true },
    });
    expect(writes()).toBe(0);
  });

  test('the recorded arm wins over what the hash would say today', async () => {
    const hashed = variantFor(KEY, 555);
    const other = hashed === 'guided' ? 'control' : 'guided';
    exposureFindUnique.mockResolvedValue({ variant: other });
    await expect(resolveExposure(KEY, user(), { now: NOW, env: env() })).resolves.toMatchObject({ variant: other });
  });

  test('an enrolled user keeps their arm after the window, and is reported activated once they are', async () => {
    exposureFindUnique.mockResolvedValue({ variant: 'guided' });
    operationLogFindFirst.mockResolvedValue({ id: 'op-9' });
    const result = await resolveExposure(KEY, user(), { now: FIRST_LOGIN.getTime() + 30 * DAY, env: env() });
    expect(result).toEqual({ enrolled: true, variant: 'guided', activated: true });
    expect(writes()).toBe(0);
  });

  test('two requests racing: the loser reads the row that won and bumps nothing', async () => {
    const hashed = variantFor(KEY, 555);
    transaction.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    exposureFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ variant: hashed });
    const result = await resolveExposure(KEY, user(), { now: NOW, env: env() });
    expect(result).toEqual({ enrolled: true, variant: hashed, activated: false });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  test('a write that fails for any other reason is thrown, never reported as enrolled', async () => {
    transaction.mockRejectedValueOnce(new Error('connection reset'));
    await expect(resolveExposure(KEY, user(), { now: NOW, env: env() })).rejects.toThrow('connection reset');
  });
});

describe('experimentReadout', () => {
  const row = (variant, over = {}) => ({
    variant, enrolled: 100, window_complete: 100, activated: 40, operations: 300, operation_errors: 12,
    users_with_error: 9, feedback_submissions: 4, feedback_users: 3, bug_feedback_users: 2, ...over,
  });
  const END = '2026-12-15T00:00:00Z';
  const closed = env({ FLAG_GUIDED_FIRST_RUN_END: END });
  const afterEverything = new Date('2026-12-23T00:00:00Z');

  test('is null for an unknown key or a rollout flag', async () => {
    await expect(experimentReadout('nope')).resolves.toBeNull();
    const flags = { thing: { kind: 'rollout', description: '', rolloutPercent: 0 } };
    await expect(experimentReadout('thing', { flags })).resolves.toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  test('before launch: not started, every arm listed at zero, nothing compared', async () => {
    const readout = await experimentReadout(KEY, { now: new Date('2026-11-25T00:00:00Z'), env: {} });
    expect(readout.status).toBe('not-started');
    expect(readout.windowDays).toBe(7);
    expect(readout.config).toMatchObject({ key: KEY, percent: 0, percentSource: 'default', killed: false, start: null, end: null });
    expect(readout.variants.map((v) => v.variant)).toEqual(['control', 'guided']);
    for (const arm of readout.variants) {
      expect(arm).toMatchObject({
        enrolled: 0, enrolledEver: null, deletedSinceEnrolment: null, windowComplete: 0, activated: 0,
        activationRate: null, operations: 0, operationErrors: 0, operationErrorRate: null,
      });
    }
    expect(readout.srm).toBeNull();
    expect(readout.test).toBeNull();
    expect(readout.guardrailTests).toBeNull();
    expect(readout.readyAt).toBeNull();
  });

  test('while enrolling: counts and guardrails are shown, the comparison is withheld', async () => {
    queryRaw.mockResolvedValue([row('control', { window_complete: 20, activated: 8 }), row('guided', { window_complete: 20, activated: 12 })]);
    const readout = await experimentReadout(KEY, { now: new Date('2026-12-10T00:00:00Z'), env: closed });
    expect(readout.status).toBe('enrolling');
    expect(readout.readyAt).toBe('2026-12-22T00:00:00.000Z');
    expect(readout.variants[0]).toMatchObject({
      variant: 'control', weight: 50, enrolled: 100, windowComplete: 20, activated: 8, activationRate: 0.4,
      operations: 300, operationErrors: 12, operationErrorRate: 0.04, usersWithError: 9, usersWithErrorRate: 0.09,
      feedbackSubmissions: 4, feedbackUsers: 3, bugFeedbackUsers: 2, bugFeedbackUsersRate: 0.02,
    });
    expect(readout.test).toBeNull();
    expect(readout.guardrailTests).toBeNull();
    // The sample-ratio check is about assignment, so it is not withheld.
    expect(readout.srm).toMatchObject({ basis: 'enrolled', observed: [100, 100], chi2: 0, pValue: 1 });
  });

  test('after enrolment closes but before every window has: maturing, still no comparison', async () => {
    queryRaw.mockResolvedValue([row('control', { window_complete: 90 }), row('guided')]);
    const readout = await experimentReadout(KEY, { now: new Date('2026-12-18T00:00:00Z'), env: closed });
    expect(readout.status).toBe('maturing');
    expect(readout.test).toBeNull();
  });

  test('final: the two-proportion test and the guardrail tests appear, treatment minus control', async () => {
    queryRaw.mockResolvedValue([
      row('guided', { enrolled: 1000, window_complete: 1000, activated: 250, users_with_error: 60, bug_feedback_users: 11 }),
      row('control', { enrolled: 1000, window_complete: 1000, activated: 200, users_with_error: 50, bug_feedback_users: 10 }),
    ]);
    const readout = await experimentReadout(KEY, { now: afterEverything, env: closed });
    expect(readout.status).toBe('final');
    // Registry order, whatever order the rows came back in.
    expect(readout.variants.map((v) => v.variant)).toEqual(['control', 'guided']);
    expect(readout.test.controlRate).toBe(0.2);
    expect(readout.test.treatmentRate).toBe(0.25);
    expect(readout.test.z).toBeCloseTo(2.6773978, 6);
    expect(readout.test.pValue).toBeCloseTo(0.0074196, 6);
    expect(readout.guardrailTests.usersWithError.difference).toBeCloseTo(0.01, 12);
    expect(readout.guardrailTests.bugFeedbackUsers.difference).toBeCloseTo(0.001, 12);
  });

  test('a flag stopped by percent 0 or by the kill switch also reaches final', async () => {
    queryRaw.mockResolvedValue([row('control'), row('guided')]);
    for (const settings of [env({ FLAG_GUIDED_FIRST_RUN_PERCENT: '0' }), env({ FLAGS_KILL: 'all' })]) {
      const readout = await experimentReadout(KEY, { now: afterEverything, env: settings });
      expect(readout.status).toBe('final');
      expect(readout.test).not.toBeNull();
    }
  });

  test('an END that does not parse reads as enrolment closed, not open-ended', async () => {
    queryRaw.mockResolvedValue([row('control', { window_complete: 10 }), row('guided')]);
    const readout = await experimentReadout(KEY, {
      now: new Date('2026-12-10T00:00:00Z'),
      env: env({ FLAG_GUIDED_FIRST_RUN_END: 'next friday' }),
    });
    expect(readout.status).toBe('maturing');
    expect(readout.config.end).toBeNull();
    expect(readout.readyAt).toBeNull();
    expect(readout.config.problems.join(' ')).toMatch(/END is not an ISO-8601 time/);
  });

  test('the counters show accounts deleted since enrolment, and feed the sample-ratio check', async () => {
    queryRaw.mockResolvedValue([row('control', { enrolled: 95 }), row('guided', { enrolled: 99 })]);
    metricFindMany.mockResolvedValue([
      { key: 'experiment_enrolled:guided-first-run:control', value: 102n },
      { key: 'experiment_enrolled:guided-first-run:guided', value: 100n },
    ]);
    const readout = await experimentReadout(KEY, { now: new Date('2026-12-10T00:00:00Z'), env: closed });
    expect(metricFindMany).toHaveBeenCalledWith({
      where: { key: { in: ['experiment_enrolled:guided-first-run:control', 'experiment_enrolled:guided-first-run:guided'] } },
    });
    expect(readout.variants[0]).toMatchObject({ enrolled: 95, enrolledEver: 102, deletedSinceEnrolment: 7 });
    expect(readout.variants[1]).toMatchObject({ enrolled: 99, enrolledEver: 100, deletedSinceEnrolment: 1 });
    expect(readout.srm).toMatchObject({ basis: 'enrolledEver', observed: [102, 100] });
  });

  test('an arm the registry no longer names is still shown', async () => {
    queryRaw.mockResolvedValue([row('control'), row('guided'), row('old-arm', { enrolled: 3 })]);
    const readout = await experimentReadout(KEY, { now: new Date('2026-12-10T00:00:00Z'), env: closed });
    expect(readout.variants.map((v) => v.variant)).toEqual(['control', 'guided', 'old-arm']);
    expect(readout.variants[2]).toMatchObject({ weight: null, enrolled: 3 });
  });
});

describe('rolloutGate', () => {
  const flags = {
    thing: {
      kind: 'rollout', description: '', rolloutPercent: 0,
      guard: { actions: ['thing-apply', 'thing-undo'], maxErrorRatePct: 10, minOperations: 20, windowHours: 24 },
    },
    bare: { kind: 'rollout', description: '', rolloutPercent: 0 },
  };
  const config = readFlagConfig('thing', { env: {}, flags });
  const now = new Date('2026-12-10T12:00:00Z');

  test('a flag with no guard has no gate', async () => {
    await expect(rolloutGate(readFlagConfig('bare', { env: {}, flags }), { now })).resolves.toBeNull();
    expect(operationLogCount).not.toHaveBeenCalled();
  });

  test.each([
    [5, 5, 'insufficient-data'],
    [19, 0, 'insufficient-data'],
    [20, 2, 'ok'],
    [200, 20, 'ok'],
    [200, 21, 'halt'],
    [20, 20, 'halt'],
  ])('%p operations, %p errors → %p', async (operations, errors, status) => {
    operationLogCount.mockResolvedValueOnce(operations).mockResolvedValueOnce(errors);
    const gate = await rolloutGate(config, { now });
    expect(gate).toMatchObject({ status, operations, errors, maxErrorRatePct: 10, minOperations: 20, windowHours: 24 });
  });

  test('it reads only the flag’s own actions, over its own trailing window', async () => {
    operationLogCount.mockResolvedValue(0);
    const gate = await rolloutGate(config, { now });
    const since = new Date('2026-12-09T12:00:00Z');
    expect(operationLogCount).toHaveBeenNthCalledWith(1, {
      where: { action: { in: ['thing-apply', 'thing-undo'] }, createdAt: { gte: since } },
    });
    expect(operationLogCount).toHaveBeenNthCalledWith(2, {
      where: { action: { in: ['thing-apply', 'thing-undo'] }, createdAt: { gte: since }, status: 'error' },
    });
    expect(gate.errorRatePct).toBeNull();
  });
});
