/**
 * RETENTION_DRY_RUN — the sweep that counts and writes nothing.
 *
 * Why this exists as its own suite rather than a case in retention.test.js:
 * the property under test is negative ("no write happens"), and a negative is
 * only worth asserting if the observation covers writes nobody has thought of
 * yet. That needs a differently-shaped client mock from the per-step ones the
 * main suite uses for its cutoff assertions.
 *
 * **The mock is a Proxy, and that is the entire point.** An earlier version
 * built a plain object out of the `MUTATING` list below and asserted none of
 * those nine was called. It passed — 54/54 green — while a rogue
 * `prisma.user.delete(...)`, `prisma.rebrandVote.deleteMany({})`,
 * `prisma.metric.deleteMany({})` or
 * `prisma.$executeRaw(Prisma.sql\`DELETE FROM users\`)` fired under the flag,
 * because the mock simply had no such property, the call threw a `TypeError`
 * inside `runStep`, and `runStep` swallows it by design. Four real writes,
 * silently uncovered, on the one job in this codebase that deletes user
 * accounts. (The old "the list matches the mock surface" test could not catch
 * it either: the mock was *built from* the list, so it compared a list to
 * itself.)
 *
 * The Proxy answers every property on every delegate, known or not, and
 * `recordCall` pushes onto `writes` whenever the method name looks like a
 * write. So "nothing was written" now means what it says: any `delete*`,
 * `update*`, `upsert`, `create*`, `$executeRaw*` or `$transaction`, on any
 * delegate, fails the suite — including ones this file has never heard of.
 *
 * `MUTATING` and `READING` survive because the tests need real `jest.fn()`s
 * with canned return values for the calls the job makes *today*; they are no
 * longer the boundary of what is observed.
 */
import { jest } from '@jest/globals';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');

/**
 * Method names that write. Deliberately prefix-matched and deliberately
 * generous: `deleteMany`, `updateManyAndReturn`, `createManyAndReturn`,
 * `upsert` and anything else Prisma adds starting the same way are all
 * covered without this list being revisited. A read misclassified as a write
 * would be a loud false failure; a write misclassified as a read is the
 * silent one, so the bias runs this way on purpose.
 */
const WRITE_METHOD = /^(delete|update|upsert|create|\$executeRaw|\$transaction)/;

/** Every write the job issues **today**, as `<delegate>.<method>`. */
const MUTATING = [
  'libraryCachePage.deleteMany',
  'libraryCacheState.deleteMany',
  'user.deleteMany',
  'operationLog.deleteMany',
  'growthAction.deleteMany',
  'feedback.deleteMany',
  'betaSignup.updateMany',
  'track.updateMany',
  'metric.upsert',
];

/** Every read it can issue. The counts each step reports come from these. */
const READING = [
  'libraryCachePage.count',
  'libraryCacheState.count',
  'user.count',
  'operationLog.count',
  'growthAction.count',
  'feedback.count',
  'betaSignup.count',
  'track.count',
  'metric.findUnique',
];

/** Declared spies, so the tests can set return values and assert call counts. */
const declared = {};
for (const path of [...MUTATING, ...READING]) {
  const [delegate, method] = path.split('.');
  declared[delegate] ??= {};
  declared[delegate][method] = jest.fn();
}
declared.$queryRaw = jest.fn();

/** `<delegate>.<method>` for every write reaching the client this run. */
let writes = [];

/**
 * Wraps one client method so the call is recorded before it is delegated.
 * Undeclared methods still answer — with `undefined` — because the point is
 * to observe the call, not to make the rogue step succeed.
 */
function recordCall(delegate, method, spy) {
  return (...args) => {
    if (WRITE_METHOD.test(method)) writes.push(`${delegate}.${method}`);
    return spy ? spy(...args) : undefined;
  };
}

const delegateCache = new Map();
function delegateFor(name) {
  if (!delegateCache.has(name)) {
    delegateCache.set(name, new Proxy(declared[name] ?? {}, {
      get: (target, method) =>
        (typeof method === 'string' ? recordCall(name, method, target[method]) : target[method]),
      // `prisma.feedback` is probed for existence before use; every delegate
      // has to look present, or that guard changes behaviour under test.
      has: () => true,
    }));
  }
  return delegateCache.get(name);
}

const prismaMock = new Proxy({}, {
  get(_target, prop) {
    if (typeof prop !== 'string') return undefined;
    // Top-level client methods: `$queryRaw` reads, `$executeRaw` writes.
    if (prop.startsWith('$')) return recordCall('prisma', prop, declared[prop]);
    return delegateFor(prop);
  },
  has: () => true,
});

jest.unstable_mockModule('../server/lib/prisma.js', () => ({ default: prismaMock }));

const { runRetentionOnce, isRetentionDryRun, startRetentionScheduler } =
  await import('../server/lib/retention.js');

const infoSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
afterAll(() => { infoSpy.mockRestore(); errorSpy.mockRestore(); });

/** The underlying spy, not the recording wrapper — assertions need the spy. */
const at = (path) => {
  const [delegate, method] = path.split('.');
  return declared[delegate][method];
};
const logLines = () => infoSpy.mock.calls.map((c) => c.join(' '));

beforeEach(() => {
  writes = [];
  for (const path of MUTATING) at(path).mockReset().mockResolvedValue({ count: 99 });
  // Distinct counts so a log line can be traced back to the step that wrote it.
  const counts = {
    'libraryCachePage.count': 3,
    'libraryCacheState.count': 2,
    'user.count': 12,
    'operationLog.count': 40,
    'growthAction.count': 7,
    'feedback.count': 1,
    'betaSignup.count': 5,
    'track.count': 9,
  };
  for (const [path, value] of Object.entries(counts)) at(path).mockReset().mockResolvedValue(value);
  at('metric.findUnique').mockReset().mockResolvedValue(null);
  declared.$queryRaw.mockReset().mockResolvedValue([{ count: 3 }]);
  infoSpy.mockClear();
  errorSpy.mockClear();
  delete process.env.RETENTION_DRY_RUN;
});

describe('RETENTION_DRY_RUN', () => {
  /**
   * These four are the exact shapes that used to pass unnoticed: a write on a
   * method this file does not declare, on a delegate it does not declare, and
   * a raw-SQL delete. They are exercised against the mock directly rather
   * than through a sabotaged `retention.js`, so the guarantee is pinned here
   * where someone adding a tenth step will read it.
   */
  test.each([
    ['an undeclared method on a declared delegate', () => prismaMock.user.delete({ where: { id: 'x' } }), 'user.delete'],
    ['an undeclared delegate entirely', () => prismaMock.rebrandVote.deleteMany({}), 'rebrandVote.deleteMany'],
    ['a delete on the metrics delegate', () => prismaMock.metric.deleteMany({}), 'metric.deleteMany'],
    ['raw SQL', () => prismaMock.$executeRaw`DELETE FROM users`, 'prisma.$executeRaw'],
    ['a transaction', () => prismaMock.$transaction([]), 'prisma.$transaction'],
    ['a create', () => prismaMock.operationLog.create({ data: {} }), 'operationLog.create'],
  ])('the observer catches %s', (_label, call, expected) => {
    call();
    expect(writes).toEqual([expected]);
  });

  test('reads are not recorded as writes', () => {
    prismaMock.user.count({});
    prismaMock.user.findMany({});
    prismaMock.$queryRaw`SELECT 1`;
    prismaMock.someFutureDelegate.aggregate({});
    expect(writes).toEqual([]);
  });

  test('issues NO write at all', async () => {
    process.env.RETENTION_DRY_RUN = 'true';
    await runRetentionOnce(NOW);

    // `writes` is what the Proxy recorded, so a failure names the escaped
    // call — including one on a delegate or method this file never declared.
    expect(writes).toEqual([]);
  });

  test('still performs every count, so the numbers are real', async () => {
    process.env.RETENTION_DRY_RUN = 'true';
    await runRetentionOnce(NOW);

    expect(READING.filter((path) => at(path).mock.calls.length === 0)).toEqual([]);
    // Two user sweeps (disconnected, then dormant), each with its own `where`.
    expect(at('user.count')).toHaveBeenCalledTimes(2);
  });

  test('logs a `would remove N` line for every step, with the counted values', async () => {
    process.env.RETENTION_DRY_RUN = 'true';
    await runRetentionOnce(NOW);

    expect(logLines()).toEqual(expect.arrayContaining([
      '[INFO] [retention] DRY RUN (RETENTION_DRY_RUN=true) — counting only, nothing is written',
      '[INFO] [retention] library-cache-pages would remove 3',
      '[INFO] [retention] library-cache-states would remove 2',
      '[INFO] [retention] disconnected-users would remove 12',
      '[INFO] [retention] inactive-users would remove 12',
      '[INFO] [retention] operation-logs would remove 40',
      '[INFO] [retention] growth-actions would remove 7',
      '[INFO] [retention] feedback would remove 1',
      '[INFO] [retention] beta-signup-emails would remove 5',
      '[INFO] [retention] catalog-gone-metadata would remove 9',
      '[INFO] [retention] DRY RUN complete — no rows were deleted or updated',
    ]));
    // No line may claim something was removed.
    for (const line of logLines()) expect(line).not.toMatch(/\] \S+ removed /);
  });

  test('prints the same `will remove N users` line a real sweep would', async () => {
    // This is the line STATE.md tells Cole to read. If the dry run worded it
    // differently he would be comparing two things that only look alike.
    process.env.RETENTION_DRY_RUN = 'true';
    await runRetentionOnce(NOW);
    expect(logLines()).toEqual(expect.arrayContaining([
      '[INFO] [retention] disconnected-users will remove 12 users',
      '[INFO] [retention] inactive-users will remove 12 users',
    ]));
  });

  test('returns the counted values as the per-step result', async () => {
    process.env.RETENTION_DRY_RUN = 'true';
    const results = await runRetentionOnce(NOW);
    expect(results).toMatchObject({
      'library-cache-pages': 3,
      'disconnected-users': 12,
      'operation-logs': 40,
      'catalog-gone-metadata': 9,
    });
  });

  test('the lifetime metric is computed but not stored', async () => {
    process.env.RETENTION_DRY_RUN = 'true';
    const results = await runRetentionOnce(NOW);
    expect(declared.$queryRaw).toHaveBeenCalled();
    expect(at('metric.upsert')).not.toHaveBeenCalled();
    expect(results['lifetime-users-metric']).toBe(3);
  });

  test('the tracks total is computed but neither it nor its cursor is stored', async () => {
    process.env.RETENTION_DRY_RUN = 'true';
    declared.$queryRaw.mockImplementation(async (sql) => (
      /SUM\("trackCount"\)/.test(sql.strings.join('')) ? [{ tracks: 250n }] : [{ count: 3 }]));

    const results = await runRetentionOnce(NOW);

    expect(at('metric.upsert')).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(results['lifetime-tracks-metric']).toBe(250);
  });

  test('a failing count is isolated like any other step, and still writes nothing', async () => {
    process.env.RETENTION_DRY_RUN = 'true';
    at('operationLog.count').mockRejectedValue(new Error('boom'));

    const results = await runRetentionOnce(NOW);

    expect(results['operation-logs']).toBeNull();
    // The steps after it still ran.
    expect(results['catalog-gone-metadata']).toBe(9);
    expect(writes).toEqual([]);
  });

  test('without the flag the sweep writes normally — the guard is the flag, not the refactor', async () => {
    await runRetentionOnce(NOW);
    expect(MUTATING.filter((path) => at(path).mock.calls.length === 0)).toEqual([]);
    expect(logLines()).not.toEqual(expect.arrayContaining([
      expect.stringContaining('DRY RUN'),
    ]));
  });

  test.each([
    ['true', true],
    ['TRUE', true],
    ['  true  ', true],
    ['false', false],
    // '1' and 'yes' are NOT accepted: a dry run that silently became real
    // because of a plausible-looking value is the failure mode here.
    ['1', false],
    ['yes', false],
    ['', false],
  ])('RETENTION_DRY_RUN=%j is dry-run %s', (value, expected) => {
    expect(isRetentionDryRun({ RETENTION_DRY_RUN: value })).toBe(expected);
  });

  test('an unset variable is a real run', () => {
    expect(isRetentionDryRun({})).toBe(false);
  });

});

/**
 * Fake timers, like the scheduler cases in retention.test.js: the scheduler
 * arms a ten-minute `setTimeout` for the first run, and a real one holds the
 * Node process open long past the end of the suite.
 */
describe('RETENTION_DRY_RUN at boot', () => {
  beforeEach(() => { jest.useFakeTimers({ now: NOW }); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  test('RETENTION_ENABLED=false still schedules nothing, and says so', () => {
    process.env.RETENTION_ENABLED = 'false';
    try {
      expect(startRetentionScheduler()).toBeNull();
      const line = logLines().find((l) => l.includes('RETENTION_ENABLED=false'));
      // The message has to point at the thing that does produce counts, or the
      // next person repeats the mistake this flag was added to fix.
      expect(line).toContain('no run, and therefore no counts');
      expect(line).toContain('RETENTION_DRY_RUN=true');
    } finally {
      delete process.env.RETENTION_ENABLED;
    }
  });

  test('the scheduler names dry-run mode at boot', () => {
    process.env.RETENTION_DRY_RUN = 'true';
    startRetentionScheduler();
    expect(logLines().some((l) => l.includes('DRY RUN mode'))).toBe(true);
  });

  test('the scheduled run itself writes nothing while the flag is set', async () => {
    process.env.RETENTION_DRY_RUN = 'true';
    startRetentionScheduler();

    // Reach the first run the same way production would: by waiting.
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    for (let i = 0; i < 60; i++) await Promise.resolve();

    expect(logLines().some((l) => l.includes('DRY RUN complete'))).toBe(true);
    expect(writes).toEqual([]);
  });
});
