import { jest } from '@jest/globals';

/**
 * ADVERSARIAL (independent verifier) — the in-memory follow ledger behind
 * getGrowthBudget. Exercised directly, with an empty mocked GrowthAction table,
 * which is exactly the state after "delete account, log in again".
 */

const count = jest.fn().mockResolvedValue(0);
const findFirst = jest.fn().mockResolvedValue(null);
jest.unstable_mockModule('../server/lib/prisma.js', () => ({
  default: { growthAction: { count, findFirst } },
}));

const {
  getGrowthBudget, recordGrowthEvent, GROWTH_DAILY_FOLLOW_CAP, GROWTH_SESSION_COOLDOWN_MS,
  startEngagementJob, getEngagementJob,
} = await import('../server/lib/growth-engine.js');
const prisma = (await import('../server/lib/prisma.js')).default;

const DAY = 24 * 60 * 60 * 1000;
let nextId = 50000;
const freshScId = () => { nextId += 1; return nextId; };

afterEach(() => {
  jest.restoreAllMocks();
  count.mockReset().mockResolvedValue(0);
  findFirst.mockReset().mockResolvedValue(null);
});

describe('ledger keys', () => {
  test('a number and its string spelling are the same account', async () => {
    const sc = freshScId();
    for (let i = 0; i < 7; i += 1) recordGrowthEvent(sc, 'follow');
    const asString = await getGrowthBudget(prisma, 'new-user', String(sc));
    expect(asString.used24h).toBe(7);
    recordGrowthEvent(String(sc), 'follow');
    const asNumber = await getGrowthBudget(prisma, 'new-user', sc);
    expect(asNumber.used24h).toBe(8);
  });

  test.each([[null], [undefined], ['']])('soundcloudId %p records nothing and reads nothing (no shared bucket)', async (missing) => {
    recordGrowthEvent(missing, 'follow');
    recordGrowthEvent(missing, 'follow');
    const a = await getGrowthBudget(prisma, 'u-a', missing);
    const b = await getGrowthBudget(prisma, 'u-b', null);
    expect(a.used24h).toBe(0);
    expect(a.cooldownRemainingMs).toBe(0);
    expect(b.used24h).toBe(0);
  });

  test('an old caller that omits soundcloudId still gets the DB-only budget, without crashing', async () => {
    count.mockResolvedValue(12);
    const b = await getGrowthBudget(prisma, 'u-c');
    expect(b.used24h).toBe(12);
    expect(b.remaining).toBe(GROWTH_DAILY_FOLLOW_CAP - 12);
  });

  test('two different accounts never see each other', async () => {
    const a = freshScId();
    const b = freshScId();
    for (let i = 0; i < GROWTH_DAILY_FOLLOW_CAP; i += 1) recordGrowthEvent(a, 'follow');
    const other = await getGrowthBudget(prisma, 'u', b);
    expect(other.used24h).toBe(0);
    expect(other.cooldownRemainingMs).toBe(0);
  });
});

describe('max(DB, ledger) and cooldown', () => {
  test('DB higher than ledger wins; ledger higher than DB wins', async () => {
    const sc = freshScId();
    for (let i = 0; i < 5; i += 1) recordGrowthEvent(sc, 'follow');
    count.mockResolvedValue(9);
    expect((await getGrowthBudget(prisma, 'u', sc)).used24h).toBe(9);
    count.mockResolvedValue(2);
    expect((await getGrowthBudget(prisma, 'u', sc)).used24h).toBe(5);
  });

  test('cooldown comes from the later of DB and ledger', async () => {
    const sc = freshScId();
    const t0 = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    recordGrowthEvent(sc, 'action');
    // DB says the last action was 20 minutes earlier; the ledger's is now.
    findFirst.mockResolvedValue({ createdAt: new Date(t0 - 20 * 60 * 1000), sessionId: 's' });
    const b = await getGrowthBudget(prisma, 'u', sc);
    expect(b.cooldownRemainingMs).toBe(GROWTH_SESSION_COOLDOWN_MS);
    expect(b.lastSessionId).toBe('s');
  });

  test('a like alone (kind "action") starts the cooldown but does not spend the cap', async () => {
    const sc = freshScId();
    recordGrowthEvent(sc, 'action');
    const b = await getGrowthBudget(prisma, 'u', sc);
    expect(b.used24h).toBe(0);
    expect(b.cooldownRemainingMs).toBeGreaterThan(0);
  });

  test('cooldown expires after exactly 30 minutes', async () => {
    const sc = freshScId();
    const t0 = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    recordGrowthEvent(sc, 'follow');
    Date.now.mockReturnValue(t0 + GROWTH_SESSION_COOLDOWN_MS - 1);
    expect((await getGrowthBudget(prisma, 'u', sc)).cooldownRemainingMs).toBe(1);
    Date.now.mockReturnValue(t0 + GROWTH_SESSION_COOLDOWN_MS);
    expect((await getGrowthBudget(prisma, 'u', sc)).cooldownRemainingMs).toBe(0);
  });
});

describe('24-hour window', () => {
  test('a follow just inside 24h still counts; one at exactly 24h does not', async () => {
    const sc = freshScId();
    const t0 = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    recordGrowthEvent(sc, 'follow');
    Date.now.mockReturnValue(t0 + DAY - 1);
    expect((await getGrowthBudget(prisma, 'u', sc)).used24h).toBe(1);
    Date.now.mockReturnValue(t0 + DAY);
    expect((await getGrowthBudget(prisma, 'u', sc)).used24h).toBe(0);
  });

  test('a rolling window: old follows drop out one by one, new ones stay', async () => {
    const sc = freshScId();
    const t0 = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    for (let i = 0; i < 30; i += 1) recordGrowthEvent(sc, 'follow');
    Date.now.mockReturnValue(t0 + 12 * 60 * 60 * 1000);
    for (let i = 0; i < 20; i += 1) recordGrowthEvent(sc, 'follow');
    expect((await getGrowthBudget(prisma, 'u', sc)).remaining).toBe(0);
    Date.now.mockReturnValue(t0 + DAY + 1);
    const b = await getGrowthBudget(prisma, 'u', sc);
    expect(b.used24h).toBe(20);
    expect(b.remaining).toBe(GROWTH_DAILY_FOLLOW_CAP - 20);
  });
});

describe('bounded memory', () => {
  test('a write sweeps out accounts whose events are all older than 24h', async () => {
    const t0 = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    const stale = [];
    for (let i = 0; i < 200; i += 1) { const sc = freshScId(); stale.push(sc); recordGrowthEvent(sc, 'follow'); }
    Date.now.mockReturnValue(t0 + DAY + 1);
    recordGrowthEvent(freshScId(), 'follow');
    // Indirect check (the map is private): none of the stale accounts reports
    // anything, and a heap-proportional probe of the sweep is the timing below.
    for (const sc of stale.slice(0, 5)) {
      expect((await getGrowthBudget(prisma, 'u', sc)).used24h).toBe(0);
    }
  });

  test('reads of unknown accounts do not create entries (no growth from GET /growth/limits)', async () => {
    // 10k reads should be cheap and leave nothing behind; if they inserted,
    // a later write's sweep would have to walk them all.
    for (let i = 0; i < 10000; i += 1) await getGrowthBudget(prisma, 'u', `probe-${i}`);
    const t = process.hrtime.bigint();
    recordGrowthEvent(freshScId(), 'follow');
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    expect(ms).toBeLessThan(50);
  });
});

describe('startEngagementJob', () => {
  test('JOB_RUNNING does not record a session start for the refused request', async () => {
    const sc = freshScId();
    let release;
    const engine = { runEngagementBatch: () => new Promise((r) => { release = r; }) };
    const base = { prisma, userId: `job-${sc}`, soundcloudId: sc, accessToken: 'a', refreshToken: 'r', targets: [] };
    const t0 = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    startEngagementJob(engine, base);
    Date.now.mockReturnValue(t0 + 60 * 1000);
    expect(() => startEngagementJob(engine, base)).toThrow(/already running/);
    // The cooldown still runs from the FIRST start, not the refused second one.
    const b = await getGrowthBudget(prisma, 'u', sc);
    expect(b.cooldownRemainingMs).toBe(GROWTH_SESSION_COOLDOWN_MS - 60 * 1000);
    getEngagementJob(`job-${sc}`).status = 'complete';
    release();
  });
});
