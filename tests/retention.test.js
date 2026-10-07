import { jest } from '@jest/globals';

// A fixed clock so every cutoff assertion is an exact date, not a tolerance.
const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysBefore = (days) => new Date(NOW - days * DAY_MS);

// Each bulk statement resolves with a distinct row count so the log-line
// assertions can tell the steps apart. The counts are re-applied in beforeEach
// rather than set once, because one test deliberately makes everything reject.
const DEFAULT_COUNTS = new Map();
const ok = (count = 0) => {
  const fn = jest.fn();
  DEFAULT_COUNTS.set(fn, count);
  return fn;
};

const libraryCachePageDeleteMany = ok(3);
const libraryCacheStateDeleteMany = ok(2);
const userDeleteMany = ok(1);
const userCount = jest.fn();
const operationLogDeleteMany = ok(40);
const queryRaw = jest.fn();
const growthActionDeleteMany = ok(7);
const feedbackDeleteMany = ok(1);
const betaSignupUpdateMany = ok(5);
const trackUpdateMany = ok(9);
const metricFindUnique = jest.fn();
const metricUpsert = jest.fn();

const prismaMock = {
  libraryCachePage: { deleteMany: libraryCachePageDeleteMany },
  libraryCacheState: { deleteMany: libraryCacheStateDeleteMany },
  user: { deleteMany: userDeleteMany, count: userCount },
  operationLog: { deleteMany: operationLogDeleteMany },
  growthAction: { deleteMany: growthActionDeleteMany },
  feedback: { deleteMany: feedbackDeleteMany },
  betaSignup: { updateMany: betaSignupUpdateMany },
  track: { updateMany: trackUpdateMany },
  metric: { findUnique: metricFindUnique, upsert: metricUpsert },
};
// $queryRaw and $transaction hang off the client itself, not off a model delegate.
prismaMock.$queryRaw = queryRaw;
const transaction = jest.fn();
prismaMock.$transaction = transaction;

jest.unstable_mockModule('../server/lib/prisma.js', () => ({ default: prismaMock }));

const {
  runRetentionOnce, startRetentionScheduler, resolveIntervalMs,
  LIFETIME_METRIC_KEY, TRACKS_METRIC_KEY, TRACKS_CURSOR_KEY,
} = await import('../server/lib/retention.js');

const infoSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

afterAll(() => { infoSpy.mockRestore(); errorSpy.mockRestore(); warnSpy.mockRestore(); });

beforeEach(() => {
  // mockReset, not mockClear: implementations have to go too, or the
  // "everything rejects" test poisons every later one.
  for (const fn of allMocks()) {
    fn.mockReset();
    if (DEFAULT_COUNTS.has(fn)) fn.mockResolvedValue({ count: DEFAULT_COUNTS.get(fn) });
  }
  infoSpy.mockClear();
  errorSpy.mockClear();
  // COUNT(DISTINCT "userId") comes back as a one-row result set.
  queryRaw.mockResolvedValue([{ count: 3 }]);
  userCount.mockResolvedValue(1);
  metricFindUnique.mockResolvedValue(null);
  metricUpsert.mockResolvedValue({});
  transaction.mockImplementation((ops) => Promise.all(ops));
});

const logLines = () => infoSpy.mock.calls.map((c) => c.join(' '));

/**
 * Drain the microtask queue. `runRetentionOnce` is a chain of ~20 awaits and
 * every mock resolves immediately, so a fixed number of turns runs it to
 * completion — and fake timers make setImmediate unavailable as a flush.
 */
const flush = async (turns = 60) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

/** Every jest.fn in the mocked client, including the top-level $queryRaw. */
function allMocks() {
  const fns = [];
  for (const [key, value] of Object.entries(prismaMock)) {
    if (typeof value === 'function') fns.push(value);
    else if (value && typeof value === 'object') fns.push(...Object.values(value));
    void key;
  }
  return fns;
}

describe('cutoff dates', () => {
  test('library cache pages age by createdAt, states by updatedAt, both at 7 days', async () => {
    await runRetentionOnce(NOW);

    expect(libraryCachePageDeleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: daysBefore(7) } },
    });
    expect(libraryCacheStateDeleteMany).toHaveBeenCalledWith({
      where: { updatedAt: { lt: daysBefore(7) } },
    });
  });

  test('CACHE_TTL_DAYS overrides the cache window', async () => {
    process.env.CACHE_TTL_DAYS = '2';
    try {
      await runRetentionOnce(NOW);
      expect(libraryCachePageDeleteMany).toHaveBeenCalledWith({
        where: { createdAt: { lt: daysBefore(2) } },
      });
    } finally {
      delete process.env.CACHE_TTL_DAYS;
    }
  });

  // SIX days, not seven, and this expectation is a compliance assertion rather
  // than a description of the code. The SoundCloud terms cap deletion at 7 days
  // after a disconnect; this job sweeps once a day, so the real worst case is
  // the grace period PLUS up to one interval. Seven would put that worst case
  // past the ceiling. If this test is ever "fixed" by moving it back to 7,
  // read docs/internal/TERMS-CHECK.md finding B before changing the constant.
  test('disconnected accounts are removed after a 6-day grace period, keeping the daily sweep inside the terms\' 7-day ceiling', async () => {
    await runRetentionOnce(NOW);

    expect(userDeleteMany).toHaveBeenNthCalledWith(1, {
      where: { disconnectedAt: { lt: daysBefore(6) } },
    });
  });

  test('inactive accounts use calendar months, with updatedAt as the fallback', async () => {
    await runRetentionOnce(NOW);

    // 24 calendar months before 2026-09-22 is 2024-09-22 — not 730 days.
    const expected = new Date('2024-09-22T12:00:00.000Z');
    expect(userDeleteMany).toHaveBeenNthCalledWith(2, {
      where: {
        OR: [
          { lastLoginAt: { lt: expected } },
          { AND: [{ lastLoginAt: null }, { updatedAt: { lt: expected } }] },
        ],
      },
    });
  });

  test('INACTIVE_MONTHS overrides the dormancy window', async () => {
    process.env.INACTIVE_MONTHS = '6';
    try {
      await runRetentionOnce(NOW);
      const where = userDeleteMany.mock.calls[1][0].where;
      expect(where.OR[0].lastLoginAt.lt).toEqual(new Date('2026-03-22T12:00:00.000Z'));
    } finally {
      delete process.env.INACTIVE_MONTHS;
    }
  });

  test('operation logs, growth actions and feedback use their own windows', async () => {
    await runRetentionOnce(NOW);

    expect(operationLogDeleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: daysBefore(365) } },
    });
    expect(growthActionDeleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: daysBefore(365) } },
    });
    expect(feedbackDeleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: daysBefore(730) } },
    });
  });

  test('OPLOG_RETENTION_DAYS overrides the log window', async () => {
    process.env.OPLOG_RETENTION_DAYS = '30';
    try {
      await runRetentionOnce(NOW);
      expect(operationLogDeleteMany).toHaveBeenCalledWith({
        where: { createdAt: { lt: daysBefore(30) } },
      });
    } finally {
      delete process.env.OPLOG_RETENTION_DAYS;
    }
  });
});

describe('unconditional steps', () => {
  test('beta signup emails are nulled every run, not aged out', async () => {
    await runRetentionOnce(NOW);
    expect(betaSignupUpdateMany).toHaveBeenCalledWith({
      where: { email: { not: null } },
      data: { email: null },
    });
  });

  test("catalog rows for tracks deleted upstream lose their metadata, not their id", async () => {
    await runRetentionOnce(NOW);
    expect(trackUpdateMany).toHaveBeenCalledWith({
      where: { access: 'gone', title: { not: null } },
      data: {
        title: null,
        artistName: null,
        genre: null,
        genreNormalized: null,
        permalinkUrl: null,
      },
    });
  });
});

describe('lifetime distinct-user snapshot', () => {
  test('creates the metric from the live count when it does not exist', async () => {
    metricFindUnique.mockResolvedValue(null);

    await runRetentionOnce(NOW);

    // Aggregated in Postgres, not by dragging one row per user into Node.
    // The first raw query is this one; the second is the tracks total.
    const sql = queryRaw.mock.calls[0][0];
    const text = Array.isArray(sql?.strings) ? sql.strings.join('') : String(sql);
    expect(text).toMatch(/COUNT\(DISTINCT "userId"\)/);
    expect(text).toMatch(/FROM operation_logs/);

    expect(metricUpsert).toHaveBeenCalledWith({
      where: { key: LIFETIME_METRIC_KEY },
      create: { key: LIFETIME_METRIC_KEY, value: 3n },
      update: { value: 3n },
    });
  });

  test('keeps the stored maximum when the live count has shrunk after a purge', async () => {
    // The whole point: yesterday's purge removed rows, so today's live count
    // is lower. The all-time figure must not follow it down.
    metricFindUnique.mockResolvedValue({ key: LIFETIME_METRIC_KEY, value: 900n });

    await runRetentionOnce(NOW);

    expect(metricUpsert.mock.calls[0][0].update).toEqual({ value: 900n });
  });

  test('raises the metric when the live count has grown', async () => {
    metricFindUnique.mockResolvedValue({ key: LIFETIME_METRIC_KEY, value: 1n });

    await runRetentionOnce(NOW);

    expect(metricUpsert.mock.calls[0][0].update).toEqual({ value: 3n });
  });

  test('the snapshot is taken BEFORE the logs it is computed from are purged', async () => {
    await runRetentionOnce(NOW);

    expect(metricUpsert.mock.invocationCallOrder[0])
      .toBeLessThan(operationLogDeleteMany.mock.invocationCallOrder[0]);
  });

  test('the snapshot runs before ANY user delete, not just before the log purge', async () => {
    // The user sweeps cascade into operation_logs. Counting after them would
    // drop exactly the departing users the all-time figure exists to keep.
    await runRetentionOnce(NOW);

    expect(queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(userDeleteMany.mock.invocationCallOrder[0]);
    expect(metricUpsert.mock.invocationCallOrder[0])
      .toBeLessThan(userDeleteMany.mock.invocationCallOrder[0]);
  });

  test('it is the very first thing the run does', async () => {
    await runRetentionOnce(NOW);

    const everythingElse = allMocks()
      .filter((fn) => fn !== queryRaw && fn !== metricFindUnique && fn !== metricUpsert)
      .flatMap((fn) => fn.mock.invocationCallOrder);

    expect(Math.min(...everythingElse))
      .toBeGreaterThan(queryRaw.mock.invocationCallOrder[0]);
  });
});

describe('lifetime tracks-processed total', () => {
  const SETTLE_MS = 5 * 60 * 1000;
  const sqlText = (call) => {
    const sql = call[0];
    return Array.isArray(sql?.strings) ? sql.strings.join('?') : String(sql);
  };
  /** The raw query that sums trackCount, wherever it falls in the run. */
  const tracksQuery = () => queryRaw.mock.calls.find((c) => /SUM\("trackCount"\)/.test(sqlText(c)));
  const stored = (values) => metricFindUnique.mockImplementation(async ({ where }) =>
    (where.key in values ? { key: where.key, value: values[where.key] } : null));
  const upsertFor = (key) => metricUpsert.mock.calls.map((c) => c[0]).find((a) => a.where.key === key);

  beforeEach(() => {
    queryRaw.mockImplementation(async (sql) => (
      /SUM\("trackCount"\)/.test(Array.isArray(sql?.strings) ? sql.strings.join('') : String(sql))
        ? [{ tracks: 250n }]
        : [{ count: 3 }]));
  });

  test('the first run sums every row and starts the cursor just behind now', async () => {
    const results = await runRetentionOnce(NOW);

    const [sql] = tracksQuery();
    expect(sql.values).toEqual([new Date(0), new Date(NOW - SETTLE_MS)]);
    // Same definition as admin tracksProcessed: page opens and probes are not operations.
    expect(sqlText(tracksQuery())).toMatch(/NOT LIKE 'view:%'/);
    expect(sqlText(tracksQuery())).toMatch(/NOT LIKE 'read:%'/);

    expect(upsertFor(TRACKS_METRIC_KEY)).toEqual({
      where: { key: TRACKS_METRIC_KEY },
      create: { key: TRACKS_METRIC_KEY, value: 250n },
      update: { value: 250n },
    });
    expect(upsertFor(TRACKS_CURSOR_KEY).update).toEqual({ value: BigInt(NOW - SETTLE_MS) });
    expect(results['lifetime-tracks-metric']).toBe(250);
  });

  test('a later run counts only rows after the cursor and ADDS them — it is not a high-water mark', async () => {
    // The live table could sum to far less than 10,000 after a purge; the
    // total must still grow by exactly the new rows.
    const cursor = NOW - DAY_MS;
    stored({ [TRACKS_METRIC_KEY]: 10000n, [TRACKS_CURSOR_KEY]: BigInt(cursor) });

    await runRetentionOnce(NOW);

    expect(tracksQuery()[0].values).toEqual([new Date(cursor), new Date(NOW - SETTLE_MS)]);
    expect(upsertFor(TRACKS_METRIC_KEY).update).toEqual({ value: 10250n });
    expect(upsertFor(TRACKS_CURSOR_KEY).update).toEqual({ value: BigInt(NOW - SETTLE_MS) });
  });

  test('the total and the cursor are written in one transaction', async () => {
    await runRetentionOnce(NOW);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0][0]).toHaveLength(2);
  });

  test('a cursor already at or past now writes nothing, so no window is counted twice', async () => {
    stored({ [TRACKS_METRIC_KEY]: 10000n, [TRACKS_CURSOR_KEY]: BigInt(NOW) });

    const results = await runRetentionOnce(NOW);

    expect(tracksQuery()).toBeUndefined();
    expect(transaction).not.toHaveBeenCalled();
    expect(results['lifetime-tracks-metric']).toBe(10000);
  });

  test('it runs before any delete — the user sweeps cascade into operation_logs', async () => {
    await runRetentionOnce(NOW);

    const firstDelete = Math.min(
      ...userDeleteMany.mock.invocationCallOrder,
      ...operationLogDeleteMany.mock.invocationCallOrder,
      ...libraryCachePageDeleteMany.mock.invocationCallOrder,
    );
    expect(transaction.mock.invocationCallOrder[0]).toBeLessThan(firstDelete);
  });

  test('a failing transaction is isolated like any other step', async () => {
    transaction.mockRejectedValueOnce(new Error('serialization failure'));

    const results = await runRetentionOnce(NOW);

    expect(results['lifetime-tracks-metric']).toBeNull();
    expect(results['lifetime-users-metric']).toBe(3);
    expect(operationLogDeleteMany).toHaveBeenCalled();
  });
});

describe('step isolation', () => {
  test('one failing step does not stop the others', async () => {
    userDeleteMany.mockRejectedValueOnce(new Error('deadlock'));

    const results = await runRetentionOnce(NOW);

    expect(results['disconnected-users']).toBeNull();
    // Everything downstream still ran.
    expect(userDeleteMany).toHaveBeenCalledTimes(2); // the inactive sweep too
    expect(metricUpsert).toHaveBeenCalled();
    expect(operationLogDeleteMany).toHaveBeenCalled();
    expect(betaSignupUpdateMany).toHaveBeenCalled();
    expect(trackUpdateMany).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  test('a failing metric snapshot still lets the log purge run', async () => {
    metricFindUnique.mockRejectedValueOnce(new Error('no metrics table'));

    const results = await runRetentionOnce(NOW);

    expect(results['lifetime-users-metric']).toBeNull();
    expect(operationLogDeleteMany).toHaveBeenCalled();
  });

  test('runRetentionOnce never rejects, even if every step throws', async () => {
    for (const fn of allMocks()) fn.mockRejectedValue(new Error('everything is down'));

    await expect(runRetentionOnce(NOW)).resolves.toEqual(expect.any(Object));
  });

  test('a failing pre-delete count does not delete anything for that step', async () => {
    userCount.mockRejectedValueOnce(new Error('count failed'));

    const results = await runRetentionOnce(NOW);

    expect(results['disconnected-users']).toBeNull();
    // Only the inactive sweep got through; the disconnected delete never ran.
    expect(userDeleteMany).toHaveBeenCalledTimes(1);
  });
});

describe('logging', () => {
  test('each step reports its count in the [retention] <step> removed N shape', async () => {
    await runRetentionOnce(NOW);

    const lines = logLines();
    expect(lines).toEqual(expect.arrayContaining([
      '[INFO] [retention] library-cache-pages removed 3',
      '[INFO] [retention] library-cache-states removed 2',
      '[INFO] [retention] disconnected-users removed 1',
      '[INFO] [retention] inactive-users removed 1',
      '[INFO] [retention] operation-logs removed 40',
      '[INFO] [retention] growth-actions removed 7',
      '[INFO] [retention] feedback removed 1',
      '[INFO] [retention] beta-signup-emails removed 5',
      '[INFO] [retention] catalog-gone-metadata removed 9',
    ]));
  });

  test('every user delete announces its size before running', async () => {
    userCount.mockResolvedValue(12);

    await runRetentionOnce(NOW);

    const lines = logLines();
    expect(lines).toContain('[INFO] [retention] disconnected-users will remove 12 users');
    expect(lines).toContain('[INFO] [retention] inactive-users will remove 12 users');

    // Announced before the fact, not after — that is the whole point.
    expect(userCount.mock.invocationCallOrder[0])
      .toBeLessThan(userDeleteMany.mock.invocationCallOrder[0]);
    expect(lines.indexOf('[INFO] [retention] disconnected-users will remove 12 users'))
      .toBeLessThan(lines.indexOf('[INFO] [retention] disconnected-users removed 1'));
  });

  test('the count is scoped to the same filter as the delete', async () => {
    await runRetentionOnce(NOW);

    expect(userCount.mock.calls[0][0]).toEqual(userDeleteMany.mock.calls[0][0]);
    expect(userCount.mock.calls[1][0]).toEqual(userDeleteMany.mock.calls[1][0]);
  });

  test('the metric step does not claim to have removed anything', async () => {
    await runRetentionOnce(NOW);

    const lines = logLines();
    expect(lines).toContain('[INFO] [retention] lifetime-users-metric snapshot 3');
    expect(lines).not.toContain('[INFO] [retention] lifetime-users-metric removed 3');
  });

  test('no log line carries a soundcloudId or any user identifier', async () => {
    await runRetentionOnce(NOW);
    for (const line of logLines()) {
      expect(line).not.toMatch(/soundcloudId/i);
      expect(line).not.toMatch(/user-[a-z0-9]/i);
    }
  });
});

describe('the Feedback model may not exist yet', () => {
  test('the job still completes when prisma.feedback is absent', async () => {
    const { feedback, ...rest } = prismaMock;
    // Simulate a client generated before the feedback feature landed.
    delete prismaMock.feedback;
    try {
      const results = await runRetentionOnce(NOW);
      expect(results['feedback']).toBe(0);
      // And the steps after it still ran.
      expect(betaSignupUpdateMany).toHaveBeenCalled();
      expect(trackUpdateMany).toHaveBeenCalled();
    } finally {
      prismaMock.feedback = feedback;
      void rest;
    }
  });
});

describe('scheduler', () => {
  beforeEach(() => { jest.useFakeTimers({ now: NOW }); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  test('RETENTION_ENABLED=false disables it entirely', () => {
    process.env.RETENTION_ENABLED = 'false';
    try {
      expect(startRetentionScheduler()).toBeNull();
      jest.advanceTimersByTime(40 * DAY_MS);
      expect(operationLogDeleteMany).not.toHaveBeenCalled();
    } finally {
      delete process.env.RETENTION_ENABLED;
    }
  });

  test('unset means enabled — a retention policy that is off by default is not one', async () => {
    const interval = startRetentionScheduler();
    expect(interval).not.toBeNull();

    // Nothing at boot: the first sweep waits 10 minutes.
    expect(operationLogDeleteMany).not.toHaveBeenCalled();

    jest.advanceTimersByTime(10 * 60 * 1000);
    await flush();
    expect(libraryCachePageDeleteMany).toHaveBeenCalled();

    clearInterval(interval);
  });

  test('RETENTION_INTERVAL_MS sets the repeat period', async () => {
    process.env.RETENTION_INTERVAL_MS = String(60 * 60 * 1000);
    try {
      const interval = startRetentionScheduler();
      jest.advanceTimersByTime(10 * 60 * 1000);
      await flush();
      const afterFirst = libraryCachePageDeleteMany.mock.calls.length;

      jest.advanceTimersByTime(60 * 60 * 1000);
      await flush();
      expect(libraryCachePageDeleteMany.mock.calls.length).toBeGreaterThan(afterFirst);

      clearInterval(interval);
    } finally {
      delete process.env.RETENTION_INTERVAL_MS;
    }
  });
});

/**
 * The interval is a compliance input, not a tuning knob.
 *
 * DISCONNECTED_GRACE_DAYS is 6 against a 7-day ceiling, so the single day
 * between them is the whole margin — and it is spent waiting for the next
 * sweep after a row becomes eligible. A 48-hour period puts the worst case at
 * 8 days, outside the terms, from an environment variable and with nothing in
 * the code to notice. These assert that it cannot.
 */
describe('RETENTION_INTERVAL_MS is clamped to the deletion deadline', () => {
  const DAY = 24 * 60 * 60 * 1000;

  // Same setup as the `scheduler` block above, and for the same reason: the
  // last test here starts the real scheduler, which arms a 10-minute timeout
  // and a multi-day interval. Without fake timers that does not fail, it
  // hangs the run.
  beforeEach(() => { jest.useFakeTimers({ now: NOW }); });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    delete process.env.RETENTION_INTERVAL_MS;
  });

  test('an over-long interval is clamped to 24h', () => {
    process.env.RETENTION_INTERVAL_MS = String(7 * DAY);
    expect(resolveIntervalMs()).toBe(DAY);
  });

  test('the clamp is announced, naming the value that was refused', () => {
    warnSpy.mockClear();
    process.env.RETENTION_INTERVAL_MS = String(48 * 60 * 60 * 1000);

    resolveIntervalMs();

    const warned = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(warned).toContain('172800000');
    expect(warned).toContain('clamped to 24h');
    // An operator who set it must be able to find out why from the log alone.
    expect(warned).toContain('TERMS-CHECK.md');
  });

  test('a shorter interval is honoured — more frequent sweeps only help', () => {
    process.env.RETENTION_INTERVAL_MS = String(60 * 60 * 1000);
    expect(resolveIntervalMs()).toBe(60 * 60 * 1000);
  });

  test('exactly 24h is not clamped, and says nothing', () => {
    warnSpy.mockClear();
    process.env.RETENTION_INTERVAL_MS = String(DAY);
    expect(resolveIntervalMs()).toBe(DAY);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('unset falls back to the 24h default', () => {
    expect(resolveIntervalMs()).toBe(DAY);
  });

  test('the scheduler uses the clamped value, not the configured one', async () => {
    process.env.RETENTION_INTERVAL_MS = String(7 * DAY);
    const interval = startRetentionScheduler();
    try {
      jest.advanceTimersByTime(10 * 60 * 1000);   // the initial run
      await flush();
      const afterFirst = libraryCachePageDeleteMany.mock.calls.length;

      // One day later the sweep must have run again. If the raw 7-day value
      // had reached setInterval, it would not have.
      jest.advanceTimersByTime(DAY);
      await flush();
      expect(libraryCachePageDeleteMany.mock.calls.length).toBeGreaterThan(afterFirst);
    } finally {
      clearInterval(interval);
    }
  });
});
