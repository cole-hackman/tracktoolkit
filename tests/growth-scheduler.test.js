import { jest } from '@jest/globals';
import { Response } from 'node-fetch';

/**
 * The daily follow-back scheduler runs from a boot-time timer, so there is no
 * request and no AsyncLocalStorage store unless it opens one itself.
 *
 * That is not a tidiness point. Without a token context a 401 inside
 * `getFollowers` reaches the refresh choke point with no userId: SoundCloud
 * rotates the refresh token, there is nobody to persist the replacement
 * against, and the row is left holding a token SoundCloud has already
 * consumed. The user's next request presents it, is refused `invalid_grant`,
 * and — because the stored token really is the one presented — the revocation
 * classifier concludes "revoked" and deletes their tokens, starting the
 * six-day account-deletion clock. A daily job against users whose access
 * token is nearly always expired made that the common case.
 *
 * These tests use the REAL soundcloud client with a mocked `fetch`, so the
 * refresh path they exercise is the production one.
 */

const growthActionFindMany = jest.fn();
const growthActionUpdate = jest.fn().mockResolvedValue({});
const userFindUnique = jest.fn();
const tokenUpdate = jest.fn().mockResolvedValue({});
const tokenFindUnique = jest.fn().mockResolvedValue(null);

jest.unstable_mockModule('../server/lib/prisma.js', () => ({
  default: {
    growthAction: { findMany: growthActionFindMany, update: growthActionUpdate },
    user: { findUnique: userFindUnique },
    token: { update: tokenUpdate, findUnique: tokenFindUnique },
  },
}));
// The scheduler paces itself between users; one user per test, but keep the
// suite honest about not sleeping.
jest.unstable_mockModule('../server/lib/pacing.js', () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
  SC_WRITE_PACING_MS: 0,
}));

const { encrypt } = await import('../server/lib/crypto.js');
const { soundcloudClient, clearRecentRotations } =
  await import('../server/lib/soundcloud-client.js');
const { runScheduledFollowbackChecks, startGrowthScheduler } = await import('../server/lib/growth-scheduler.js');

const KEY = process.env.ENCRYPTION_KEY;
const ORIGINAL_FETCH = global.fetch;

/** SoundCloud as it really behaves: every exchange rotates the refresh token. */
function mockRotatingSoundCloud() {
  const state = { oauthCalls: 0, presented: [] };
  global.fetch = jest.fn(async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/oauth/token')) {
      state.oauthCalls += 1;
      state.presented.push(new URLSearchParams(String(options.body)).get('refresh_token'));
      return new Response(JSON.stringify({
        access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600,
      }), { status: 200 });
    }
    if ((options.headers?.Authorization || '') === 'OAuth stale-access') {
      return new Response('', { status: 401 });
    }
    return new Response(JSON.stringify({ collection: [{ id: 42 }], next_href: null }), { status: 200 });
  });
  return state;
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  growthActionFindMany.mockReset().mockResolvedValue([
    { id: 'ga-1', userId: 'user-1', targetId: 42n },
  ]);
  growthActionUpdate.mockClear();
  tokenUpdate.mockClear();
  userFindUnique.mockReset().mockResolvedValue({
    id: 'user-1',
    tokens: [{
      encrypted: encrypt('stale-access', KEY),
      refresh: encrypt('good-refresh', KEY),
    }],
  });
  clearRecentRotations();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe('the scheduled follow-back check refreshes inside a token context', () => {
  test('a 401 during the scheduled crawl PERSISTS the rotated pair', async () => {
    const sc = mockRotatingSoundCloud();

    const result = await runScheduledFollowbackChecks(soundcloudClient);

    // The exchange happened...
    expect(sc.oauthCalls).toBe(1);
    expect(sc.presented).toEqual(['good-refresh']);
    // ...and, crucially, the replacement was written. Without a token context
    // this is 0: the token is spent upstream and the row keeps the dead one,
    // which the revocation classifier later reads as a revocation.
    expect(tokenUpdate).toHaveBeenCalledTimes(1);
    expect(tokenUpdate.mock.calls[0][0].where).toEqual({ userId: 'user-1' });

    // And the job still did its job.
    expect(result).toEqual({ usersChecked: 1, actionsChecked: 1 });
    expect(growthActionUpdate.mock.calls[0][0].data.followedBack).toBe(true);
  });

  test('the stored refresh token is never left as one SoundCloud has spent', async () => {
    // The property stated without reference to how it is achieved: whatever
    // the job presented upstream, the row must not still hold it afterwards.
    const sc = mockRotatingSoundCloud();

    await runScheduledFollowbackChecks(soundcloudClient);

    const written = tokenUpdate.mock.calls[0][0].data;
    for (const spent of sc.presented) {
      expect(written.refresh).not.toBe(spent);       // not the plaintext
      expect(written.refresh).not.toBe(encrypt(spent, KEY)); // nor a re-encrypt
    }
  });

  test('a user whose token row has gone is skipped, not crashed on', async () => {
    mockRotatingSoundCloud();
    userFindUnique.mockResolvedValueOnce({ id: 'user-1', tokens: [] });

    const result = await runScheduledFollowbackChecks(soundcloudClient);

    expect(result).toEqual({ usersChecked: 0, actionsChecked: 0 });
    expect(tokenUpdate).not.toHaveBeenCalled();
  });

  test('nothing pending means no SoundCloud call at all', async () => {
    const sc = mockRotatingSoundCloud();
    growthActionFindMany.mockResolvedValueOnce([]);

    const result = await runScheduledFollowbackChecks(soundcloudClient);

    expect(result).toEqual({ usersChecked: 0, actionsChecked: 0 });
    expect(sc.oauthCalls).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('startGrowthScheduler', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { process.env.NODE_ENV = originalNodeEnv; jest.clearAllTimers(); jest.useRealTimers(); });

  test.each(['development', 'test', ''])('NODE_ENV=%p schedules nothing', (nodeEnv) => {
    process.env.NODE_ENV = nodeEnv;
    expect(startGrowthScheduler(soundcloudClient)).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('production schedules the daily check', () => {
    process.env.NODE_ENV = 'production';
    const interval = startGrowthScheduler(soundcloudClient);
    expect(interval).not.toBeNull();
    clearInterval(interval);
  });
});
