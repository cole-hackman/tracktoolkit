import { jest } from '@jest/globals';

// The flag module is pure apart from its boot log line; no database.
jest.unstable_mockModule('../server/lib/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  ACTIVATION_WINDOW_DAYS,
  FLAGS,
  bucketFor,
  variantBucketFor,
  variantFor,
  flagEnvName,
  readFlagConfig,
  describeFlags,
  evaluateFlag,
  isFlagEnabled,
  flagsForUser,
  withinEnrolmentWindow,
  logFlagConfig,
} = await import('../server/lib/flags.js');
const { default: logger } = await import('../server/lib/logger.js');

const KEY = 'guided-first-run';
const IDS = Array.from({ length: 10_000 }, (_, i) => 100_000 + i * 37);

const START = '2026-12-01T00:00:00Z';
const newUser = (soundcloudId, createdAt = '2026-12-02T10:00:00Z') => ({
  id: `u-${soundcloudId}`,
  soundcloudId,
  createdAt: new Date(createdAt),
});
/** Settings for a running experiment at `percent`. */
const running = (percent = 100, extra = {}) => ({
  FLAG_GUIDED_FIRST_RUN_PERCENT: String(percent),
  FLAG_GUIDED_FIRST_RUN_START: START,
  ...extra,
});

/** A registry of its own, so rollout behaviour is tested without shipping one. */
const TEST_FLAGS = {
  ...FLAGS,
  'new-thing': {
    kind: 'rollout',
    description: 'A feature in staged rollout',
    rolloutPercent: 0,
    guard: { actions: ['new-thing-run'], maxErrorRatePct: 10, minOperations: 20, windowHours: 24 },
  },
};

describe('the registry', () => {
  test('every flag ships off, and every variant split adds up to 100', () => {
    for (const [key, flag] of Object.entries(FLAGS)) {
      expect(['experiment', 'rollout']).toContain(flag.kind);
      expect(flag.rolloutPercent).toBe(0);
      expect(key).toMatch(/^[a-z0-9-]{2,60}$/);
      if (flag.kind === 'experiment') {
        const total = flag.variants.reduce((sum, v) => sum + v.weight, 0);
        expect(total).toBe(100);
        expect(new Set(flag.variants.map((v) => v.name)).size).toBe(flag.variants.length);
      }
    }
  });

  test('with no settings at all, nobody is in anything', () => {
    expect(describeFlags({ env: {} }).every((c) => c.percent === 0 && !c.killed)).toBe(true);
    for (const id of IDS.slice(0, 500)) {
      expect(flagsForUser(newUser(id), { env: {} })).toEqual({ flags: [], experiments: [] });
    }
  });

  test('setting names are derived from the key', () => {
    expect(flagEnvName(KEY, 'PERCENT')).toBe('FLAG_GUIDED_FIRST_RUN_PERCENT');
    expect(flagEnvName(KEY, 'START')).toBe('FLAG_GUIDED_FIRST_RUN_START');
  });
});

describe('bucketing', () => {
  test('is deterministic: the same flag and id always land in the same bucket', () => {
    for (const id of IDS.slice(0, 200)) {
      const first = bucketFor(KEY, id);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(100);
      expect(Number.isInteger(first)).toBe(true);
      expect(bucketFor(KEY, id)).toBe(first);
      // A number and its string form are the same unit.
      expect(bucketFor(KEY, String(id))).toBe(first);
    }
  });

  test('pins known values, so a change to the hash cannot pass unnoticed', () => {
    // sha256("guided-first-run:1"), first 32 bits, mod 100 — and the variant
    // hash sha256("guided-first-run:variant:1"). If these move, every account
    // changes arm.
    expect([1, 2, 3, 1000001].map((id) => bucketFor(KEY, id))).toEqual([15, 83, 91, 11]);
    expect([1, 2, 3, 1000001].map((id) => variantBucketFor(KEY, id))).toEqual([23, 89, 76, 71]);
  });

  test('is roughly uniform over 10,000 ids', () => {
    const counts = new Array(100).fill(0);
    for (const id of IDS) counts[bucketFor(KEY, id)] += 1;
    // Expected 100 per bucket. Chi-square with 99 degrees of freedom has a
    // 99.9th percentile of 148.2; a fixed input makes this deterministic.
    const chi2 = counts.reduce((sum, c) => sum + ((c - 100) ** 2) / 100, 0);
    expect(chi2).toBeLessThan(148.2);
    expect(Math.min(...counts)).toBeGreaterThan(60);
    expect(Math.max(...counts)).toBeLessThan(140);
  });

  test('a 50/50 split of 10,000 ids is within 2 points of even', () => {
    const guided = IDS.filter((id) => variantFor(KEY, id) === 'guided').length;
    // Binomial(10000, 0.5): sd is 50, so 4 sd either side is 4800–5200.
    expect(guided).toBeGreaterThan(4800);
    expect(guided).toBeLessThan(5200);
  });

  test('a different flag key gives an unrelated assignment', () => {
    const same = IDS.filter((id) => bucketFor(KEY, id) === bucketFor('another-flag', id)).length;
    // Independent buckets agree 1 time in 100.
    expect(same).toBeGreaterThan(50);
    expect(same).toBeLessThan(160);
  });

  test('the variant does not depend on the rollout bucket', () => {
    // If one hash served both, the lowest tenth of the rollout would all be
    // in the first variant. At 10% the split must still be near even.
    const inTenth = IDS.filter((id) => bucketFor(KEY, id) < 10);
    const guided = inTenth.filter((id) => variantFor(KEY, id) === 'guided').length;
    expect(inTenth.length).toBeGreaterThan(850);
    expect(inTenth.length).toBeLessThan(1150);
    expect(guided / inTenth.length).toBeGreaterThan(0.42);
    expect(guided / inTenth.length).toBeLessThan(0.58);
  });

  test('variant weights are honoured', () => {
    const flags = {
      skewed: {
        kind: 'experiment',
        description: '',
        rolloutPercent: 0,
        variants: [{ name: 'a', weight: 90 }, { name: 'b', weight: 10 }],
      },
    };
    const b = IDS.filter((id) => variantFor('skewed', id, flags) === 'b').length;
    expect(b).toBeGreaterThan(850);
    expect(b).toBeLessThan(1150);
  });
});

describe('stickiness', () => {
  test('the same account gets the same decision on every evaluation', () => {
    const env = running(100);
    for (const id of IDS.slice(0, 300)) {
      const first = evaluateFlag(KEY, newUser(id), { env });
      for (let i = 0; i < 3; i++) expect(evaluateFlag(KEY, newUser(id), { env })).toEqual(first);
    }
  });

  test('raising the percent only adds accounts, and never changes an arm', () => {
    const at = (percent) =>
      new Map(IDS.map((id) => [id, evaluateFlag(KEY, newUser(id), { env: running(percent) })]));
    const ten = at(10);
    const fifty = at(50);
    const hundred = at(100);
    let inTen = 0;
    let inFifty = 0;
    for (const id of IDS) {
      if (ten.get(id).enabled) {
        inTen += 1;
        expect(fifty.get(id)).toEqual(ten.get(id));
        expect(hundred.get(id)).toEqual(ten.get(id));
      }
      if (fifty.get(id).enabled) {
        inFifty += 1;
        expect(hundred.get(id)).toEqual(fifty.get(id));
      }
      expect(hundred.get(id).enabled).toBe(true);
    }
    expect(inTen).toBeGreaterThan(850);
    expect(inTen).toBeLessThan(1150);
    expect(inFifty).toBeGreaterThan(4800);
    expect(inFifty).toBeLessThan(5200);
  });

  test('the arm depends on the SoundCloud id, not on the users row', () => {
    const before = evaluateFlag(KEY, { id: 'row-1', soundcloudId: 4242, createdAt: new Date('2026-12-02T00:00:00Z') }, { env: running() });
    // Deleted and signed up again: a new row id and a new first login.
    const after = evaluateFlag(KEY, { id: 'row-2', soundcloudId: 4242, createdAt: new Date('2026-12-09T00:00:00Z') }, { env: running() });
    expect(after.variant).toBe(before.variant);
  });
});

describe('experiment eligibility', () => {
  const ORIGINAL_ADMIN_IDS = process.env.ADMIN_IDS;
  afterEach(() => {
    if (ORIGINAL_ADMIN_IDS === undefined) delete process.env.ADMIN_IDS;
    else process.env.ADMIN_IDS = ORIGINAL_ADMIN_IDS;
  });

  test('an eligible new user gets an arm', () => {
    const decision = evaluateFlag(KEY, newUser(555), { env: running() });
    expect(decision.enabled).toBe(true);
    expect(['control', 'guided']).toContain(decision.variant);
    expect(decision.reason).toBe('eligible');
  });

  test('admins are never enrolled, at any percent', () => {
    process.env.ADMIN_IDS = '555, 556';
    expect(evaluateFlag(KEY, newUser(555), { env: running(100) })).toEqual({
      enabled: false, variant: null, reason: 'excluded-admin',
    });
    expect(evaluateFlag(KEY, newUser(557), { env: running(100) }).enabled).toBe(true);
  });

  test('EXPERIMENT_EXCLUDE_IDS keeps named accounts out', () => {
    const env = running(100, { EXPERIMENT_EXCLUDE_IDS: '900, 901' });
    expect(evaluateFlag(KEY, newUser(900), { env }).reason).toBe('excluded-id');
    expect(evaluateFlag(KEY, newUser(901), { env }).reason).toBe('excluded-id');
    expect(evaluateFlag(KEY, newUser(902), { env }).enabled).toBe(true);
  });

  test('only accounts first seen at or after the start are eligible', () => {
    const env = running(100);
    expect(evaluateFlag(KEY, newUser(1, '2026-11-30T23:59:59Z'), { env }).reason).toBe('before-start');
    expect(evaluateFlag(KEY, newUser(1, '2026-12-01T00:00:00Z'), { env }).enabled).toBe(true);
    expect(evaluateFlag(KEY, newUser(1, '2024-03-01T00:00:00Z'), { env }).reason).toBe('before-start');
  });

  test('with no start set, nobody is eligible, whatever the percent', () => {
    const env = { FLAG_GUIDED_FIRST_RUN_PERCENT: '100' };
    expect(evaluateFlag(KEY, newUser(1), { env }).reason).toBe('no-start');
    expect(readFlagConfig(KEY, { env }).problems.join(' ')).toMatch(/START is not set/);
  });

  test('an end closes the cohort without touching accounts already inside it', () => {
    const env = running(100, { FLAG_GUIDED_FIRST_RUN_END: '2026-12-15T00:00:00Z' });
    expect(evaluateFlag(KEY, newUser(1, '2026-12-14T23:59:59Z'), { env }).enabled).toBe(true);
    expect(evaluateFlag(KEY, newUser(1, '2026-12-15T00:00:00Z'), { env }).reason).toBe('after-end');
  });

  test('a missing user, id or first login is never enrolled', () => {
    const env = running(100);
    expect(evaluateFlag(KEY, null, { env }).reason).toBe('no-user');
    expect(evaluateFlag(KEY, { id: 'x' }, { env }).reason).toBe('no-user');
    expect(evaluateFlag(KEY, { id: 'x', soundcloudId: 5 }, { env }).reason).toBe('no-first-login');
    expect(evaluateFlag('nope', newUser(1), { env }).reason).toBe('unknown-flag');
    // Object.hasOwn, not `in`: an inherited name is not a flag.
    expect(evaluateFlag('constructor', newUser(1), { env }).reason).toBe('unknown-flag');
  });

  test('at 0 percent nobody is in, and /me lists nothing', () => {
    const env = running(0);
    for (const id of IDS.slice(0, 300)) {
      expect(evaluateFlag(KEY, newUser(id), { env }).reason).toBe('rollout-0');
    }
    expect(flagsForUser(newUser(1), { env })).toEqual({ flags: [], experiments: [] });
  });

  test('/me lists the experiment for an eligible account only', () => {
    expect(flagsForUser(newUser(555), { env: running() })).toEqual({ flags: [], experiments: [KEY] });
    expect(flagsForUser(newUser(555, '2025-01-01T00:00:00Z'), { env: running() })).toEqual({ flags: [], experiments: [] });
  });
});

describe('settings fail towards off', () => {
  test.each(['50%', '0.5', 'fifty', '101', '-1', '1e2', ' ', '100.0'])(
    'a percent of %p is treated as 0 and reported',
    (raw) => {
      const env = running(100, { FLAG_GUIDED_FIRST_RUN_PERCENT: raw });
      const config = readFlagConfig(KEY, { env });
      expect(config.percent).toBe(0);
      if (raw.trim() === '') {
        expect(config.percentSource).toBe('default');
      } else {
        expect(config.percentSource).toBe('invalid');
        expect(config.problems.join(' ')).toMatch(/PERCENT is not a whole number/);
      }
      expect(evaluateFlag(KEY, newUser(1), { env }).enabled).toBe(false);
    },
  );

  test.each(['0', '10', '50', '100', ' 25 '])('a percent of %p is accepted', (raw) => {
    const config = readFlagConfig(KEY, { env: { FLAG_GUIDED_FIRST_RUN_PERCENT: raw } });
    expect(config.percent).toBe(Number(raw));
    expect(config.percentSource).toBe('setting');
  });

  test.each(['2026-12-01', '2026-12-01T00:00:00', 'tomorrow', '2026-13-45T00:00:00Z', '1764547200'])(
    'a start of %p is refused: a time with no zone is not an instant',
    (raw) => {
      const env = { FLAG_GUIDED_FIRST_RUN_PERCENT: '100', FLAG_GUIDED_FIRST_RUN_START: raw };
      const config = readFlagConfig(KEY, { env });
      expect(config.start).toBeNull();
      expect(config.problems).toHaveLength(1);
      expect(config.problems[0]).toMatch(/START is not an ISO-8601 time.*nobody is eligible/);
      expect(evaluateFlag(KEY, newUser(1), { env }).enabled).toBe(false);
    },
  );

  test('a start with an offset is the same instant as its UTC form', () => {
    const config = readFlagConfig(KEY, { env: { FLAG_GUIDED_FIRST_RUN_START: '2026-11-30T16:00:00-08:00' } });
    expect(config.start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  test('an end that does not parse closes enrolment instead of leaving it open', () => {
    const env = running(100, { FLAG_GUIDED_FIRST_RUN_END: 'next friday' });
    const config = readFlagConfig(KEY, { env });
    expect(config.problems.join(' ')).toMatch(/END is not an ISO-8601 time.*closed/);
    expect(config).toMatchObject({ end: null, endInvalid: true });
    expect(evaluateFlag(KEY, newUser(1), { env }).reason).toBe('invalid-end');
    // Without the END setting at all, the same account is eligible.
    expect(evaluateFlag(KEY, newUser(1), { env: running(100) }).enabled).toBe(true);
  });

  test('an end before the start is reported and enrols nobody', () => {
    const env = running(100, { FLAG_GUIDED_FIRST_RUN_END: '2026-11-01T00:00:00Z' });
    expect(readFlagConfig(KEY, { env }).problems.join(' ')).toMatch(/END is not after/);
    expect(evaluateFlag(KEY, newUser(1), { env }).enabled).toBe(false);
  });
});

describe('the kill switch', () => {
  test.each([
    ['all', true],
    ['ALL', true],
    [KEY, true],
    [` ${KEY} , something-else`, true],
    ['', false],
    [undefined, false],
  ])('FLAGS_KILL=%p → killed %p', (value, killed) => {
    const env = running(100, value === undefined ? {} : { FLAGS_KILL: value });
    expect(readFlagConfig(KEY, { env }).killed).toBe(killed);
    expect(evaluateFlag(KEY, newUser(1), { env }).enabled).toBe(!killed);
  });

  test('a typo in the kill switch kills everything, and says so', () => {
    // The operator meant to stop something. Stopping too much is recoverable.
    const env = running(100, { FLAGS_KILL: 'guided-frist-run' });
    const config = readFlagConfig(KEY, { env });
    expect(config.killed).toBe(true);
    expect(config.problems.join(' ')).toMatch(/names no known flag \(guided-frist-run\)/);
    expect(evaluateFlag(KEY, newUser(1), { env })).toEqual({ enabled: false, variant: null, reason: 'killed' });
  });

  test('killing one flag leaves the others on', () => {
    const env = { FLAG_NEW_THING_PERCENT: '100', FLAGS_KILL: KEY };
    expect(readFlagConfig('new-thing', { env, flags: TEST_FLAGS }).killed).toBe(false);
    expect(isFlagEnabled('new-thing', newUser(1), { env, flags: TEST_FLAGS })).toBe(true);
  });

  test('a kill beats every other setting, including admin access to a rollout', () => {
    const before = process.env.ADMIN_IDS;
    process.env.ADMIN_IDS = '7';
    try {
      const env = { FLAG_NEW_THING_PERCENT: '100', FLAGS_KILL: 'all' };
      expect(isFlagEnabled('new-thing', newUser(7), { env, flags: TEST_FLAGS })).toBe(false);
    } finally {
      if (before === undefined) delete process.env.ADMIN_IDS;
      else process.env.ADMIN_IDS = before;
    }
  });
});

describe('staged rollout', () => {
  const env = (percent) => ({ FLAG_NEW_THING_PERCENT: String(percent) });
  const share = (percent) =>
    IDS.filter((id) => isFlagEnabled('new-thing', newUser(id), { env: env(percent), flags: TEST_FLAGS })).length / IDS.length;

  test('10 / 50 / 100 percent reach about that share of accounts', () => {
    expect(share(0)).toBe(0);
    expect(share(10)).toBeGreaterThan(0.085);
    expect(share(10)).toBeLessThan(0.115);
    expect(share(50)).toBeGreaterThan(0.48);
    expect(share(50)).toBeLessThan(0.52);
    expect(share(100)).toBe(1);
  });

  test('each stage contains the one before it, and rolling back to 0 removes everyone', () => {
    const has = (percent, id) => isFlagEnabled('new-thing', newUser(id), { env: env(percent), flags: TEST_FLAGS });
    for (const id of IDS) {
      if (has(10, id)) expect(has(50, id)).toBe(true);
      if (has(50, id)) expect(has(100, id)).toBe(true);
      expect(has(0, id)).toBe(false);
    }
  });

  test('a rollout ignores first login: existing accounts are in it too', () => {
    expect(isFlagEnabled('new-thing', newUser(1, '2024-01-01T00:00:00Z'), { env: env(100), flags: TEST_FLAGS })).toBe(true);
  });

  test('admins have a rollout flag from 0 percent: that is the internal stage', () => {
    const before = process.env.ADMIN_IDS;
    process.env.ADMIN_IDS = '7';
    try {
      expect(evaluateFlag('new-thing', newUser(7), { env: env(0), flags: TEST_FLAGS })).toEqual({
        enabled: true, variant: null, reason: 'admin',
      });
      expect(flagsForUser(newUser(7), { env: env(0), flags: TEST_FLAGS })).toEqual({ flags: ['new-thing'], experiments: [] });
      expect(isFlagEnabled('new-thing', newUser(8), { env: env(0), flags: TEST_FLAGS })).toBe(false);
    } finally {
      if (before === undefined) delete process.env.ADMIN_IDS;
      else process.env.ADMIN_IDS = before;
    }
  });

  test('isFlagEnabled is for rollout flags; an experiment is never "enabled" that way', () => {
    expect(isFlagEnabled(KEY, newUser(555), { env: running() })).toBe(false);
    expect(isFlagEnabled('nope', newUser(555), { env: running() })).toBe(false);
  });
});

describe('the enrolment window', () => {
  const first = new Date('2026-12-01T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;

  test(`is ${ACTIVATION_WINDOW_DAYS} days from first login, end exclusive`, () => {
    expect(ACTIVATION_WINDOW_DAYS).toBe(7);
    expect(withinEnrolmentWindow(first, first.getTime())).toBe(true);
    expect(withinEnrolmentWindow(first, first.getTime() + 7 * day - 1)).toBe(true);
    expect(withinEnrolmentWindow(first, first.getTime() + 7 * day)).toBe(false);
    expect(withinEnrolmentWindow(undefined, first.getTime())).toBe(false);
  });
});

describe('the boot log', () => {
  test('prints one line per flag and a warning per refused setting', () => {
    logger.info.mockClear();
    logger.warn.mockClear();
    logFlagConfig({ env: { FLAG_GUIDED_FIRST_RUN_PERCENT: 'lots' } });
    expect(logger.info).toHaveBeenCalledWith(
      '[flags] guided-first-run: experiment, rollout 0% (invalid), start unset, end unset',
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/PERCENT is not a whole number/));

    logger.info.mockClear();
    logFlagConfig({ env: running(100, { FLAGS_KILL: 'all' }) });
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/guided-first-run: experiment, KILLED, start 2026-12-01T00:00:00.000Z/));
  });
});
