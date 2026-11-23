import { jest } from '@jest/globals';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { Response } from 'node-fetch';

// Capture original env before overwriting
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ORIGINAL_SESSION_SECRET = process.env.SESSION_SECRET;

process.env.ENCRYPTION_KEY = 'x'.repeat(32);
process.env.SESSION_SECRET = 's'.repeat(40);

// A deliberately faithful little fake of the `tokens` row, because the whole
// point of the fix under test is that the refresh path CONSULTS the stored
// pair before believing SoundCloud's `invalid_grant`. A mock that always
// answers with the row the request started from would make the two cases that
// matter indistinguishable — which is exactly the bug.
let storedTokenRow;

const writeTokenRow = async (args) => {
  storedTokenRow = {
    encrypted: args.data.encrypted,
    refresh: args.data.refresh,
    expiresAt: args.data.expiresAt,
  };
  return {};
};
const tokenUpdate = jest.fn(writeTokenRow);
const tokenFindUnique = jest.fn(async () => storedTokenRow ?? null);
const tokenDeleteMany = jest.fn(async () => { storedTokenRow = null; return { count: 1 }; });
const userUpdate = jest.fn().mockResolvedValue({});
const findUnique = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
  default: {
    user: { findUnique, update: userUpdate },
    token: { update: tokenUpdate, deleteMany: tokenDeleteMany, findUnique: tokenFindUnique },
  },
}));
// account-lifecycle drops the durable library tier on disconnect; that tier is
// not what this suite is about, and it would otherwise try to reach Postgres.
jest.unstable_mockModule('../../server/lib/snapshot-cache.js', () => ({
  dropSnapshots: jest.fn().mockResolvedValue(undefined),
  readSnapshot: jest.fn(),
  writeSnapshot: jest.fn(),
  invalidateSnapshot: jest.fn().mockResolvedValue({ count: 0 }),
  SNAPSHOT_RESOURCES: ['likes', 'playlists', 'followings', 'followers', 'reposts'],
}));

const { encrypt, decrypt } = await import('../../server/lib/crypto.js');
const { signSession } = await import('../../server/lib/session.js');
const { authenticateUser } = await import('../../server/middleware/auth.js');
const { clearAuthCache } = await import('../../server/lib/auth-cache.js');
const { soundcloudClient, clearRecentRotations, forgetRecentRotation } =
  await import('../../server/lib/soundcloud-client.js');

const KEY = process.env.ENCRYPTION_KEY;

const app = express();
app.use(cookieParser());
app.get('/probe', authenticateUser, async (req, res) => {
  try {
    const data = await soundcloudClient.scRequest('/me', req.accessToken, req.refreshToken);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The shape every multi-call route has: authenticateUser captures the pair
// once and BOTH calls are handed that same captured pair. `paginate` rotates
// its local copy after a refresh; nothing else does, so the second call here
// presents a refresh token the first one already spent. This is the merge loop
// (routes/api.js) and every fan-out dashboard read, in eight lines.
app.get('/two-calls', authenticateUser, async (req, res) => {
  try {
    const first = await soundcloudClient.scRequest('/me', req.accessToken, req.refreshToken);
    if (req.query.cold) clearRecentRotations();   // as if the memo had expired
    const second = await soundcloudClient.scRequest('/me/playlists', req.accessToken, req.refreshToken);
    res.json({ ok: true, first, second });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function sessionCookie(userId = 'user-1') {
  const value = JSON.stringify({ userId, soundcloudId: 111, iat: Date.now() });
  return `session=${encodeURIComponent(signSession(value, process.env.SESSION_SECRET))}`;
}

const originalFetch = global.fetch;

/** Move the clock forward for TTL assertions, without fake timers. */
let clockSpy = null;
function advanceClock(ms) {
  const base = clockSpy ? Date.now() : Date.now();
  clockSpy?.mockRestore();
  clockSpy = jest.spyOn(Date, 'now').mockImplementation(() => base + ms);
}

beforeEach(() => {
  // mockReset, not mockClear: a test that queues failures with
  // mockImplementationOnce must not leak an unconsumed one into the next.
  tokenUpdate.mockReset();
  tokenUpdate.mockImplementation(writeTokenRow);
  tokenDeleteMany.mockClear();
  tokenFindUnique.mockClear();
  userUpdate.mockClear();
  findUnique.mockClear();
  findUnique.mockResolvedValue({
    id: 'user-1',
    soundcloudId: 111,
    tokens: [{
      encrypted: encrypt('stale-access', KEY),
      refresh: encrypt('good-refresh', KEY),
    }],
  });
  // The database agrees with what authenticateUser just handed out, and the
  // access token is past its expiry — the ordinary hourly boundary.
  storedTokenRow = {
    encrypted: encrypt('stale-access', KEY),
    refresh: encrypt('good-refresh', KEY),
    expiresAt: new Date(Date.now() - 60_000),
  };
  clearAuthCache();
  clearRecentRotations();
  clockSpy?.mockRestore();
  clockSpy = null;
  global.fetch = jest.fn();
});

afterAll(() => {
  if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
  if (ORIGINAL_SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = ORIGINAL_SESSION_SECRET;
  global.fetch = originalFetch;
});

describe('401 → refresh → persist → retry, through the real middleware', () => {
  test('the refreshed token pair is persisted for the session user and the retry succeeds', async () => {
    fetch
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 401 })))
      .mockReturnValueOnce(Promise.resolve(new Response(
        JSON.stringify({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 }),
        { status: 200 }
      )))
      .mockReturnValueOnce(Promise.resolve(new Response(
        JSON.stringify({ id: 111, username: 'dj' }), { status: 200 }
      )));

    const res = await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 111, username: 'dj' });
    expect(fetch).toHaveBeenCalledTimes(3);

    // persisted against the SESSION's user, sourced from the token context
    expect(tokenUpdate).toHaveBeenCalledTimes(1);
    const call = tokenUpdate.mock.calls[0][0];
    expect(call.where).toEqual({ userId: 'user-1' });

    // stored encrypted, never in plaintext
    expect(call.data.encrypted).not.toBe('fresh-access');
    expect(call.data.refresh).not.toBe('fresh-refresh');
    expect(call.data.expiresAt).toBeInstanceOf(Date);
  });

  test('the first request carries the DECRYPTED access token, not the ciphertext', async () => {
    fetch.mockReturnValue(Promise.resolve(new Response(JSON.stringify({ id: 111 }), { status: 200 })));

    await request(app).get('/probe').set('Cookie', sessionCookie());

    const auth = fetch.mock.calls[0][1].headers.Authorization;
    expect(auth).toBe('OAuth stale-access');
  });

  test('a failed refresh surfaces a generic error and persists nothing', async () => {
    fetch
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 401 })))
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 400 })));

    const res = await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Token refresh failed');
    expect(res.body.error).not.toMatch(/good-refresh|fresh-access/);
    expect(tokenUpdate).not.toHaveBeenCalled();
  });
});

describe('revocation detection at the refresh choke point', () => {
  // The distinction that matters: SoundCloud saying "this grant is gone" must
  // tear the connection down, and SoundCloud merely being unwell must not.

  test('invalid_grant destroys the stored tokens and stamps disconnectedAt', async () => {
    fetch
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 401 })))
      .mockReturnValueOnce(Promise.resolve(new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'revoked' }),
        { status: 400 }
      )));

    const res = await request(app).get('/probe').set('Cookie', sessionCookie());

    // The request still fails exactly as it always has.
    expect(res.body.error).toBe('Token refresh failed');

    expect(tokenDeleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    const update = userUpdate.mock.calls[0][0];
    expect(update.where).toEqual({ id: 'user-1' });
    expect(update.data.disconnectedAt).toBeInstanceOf(Date);

    // Nothing was persisted as a "refreshed" pair.
    expect(tokenUpdate).not.toHaveBeenCalled();
  });

  test('a 401 with an empty body counts as revocation', async () => {
    fetch
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 401 })))
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 401 })));

    await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(tokenDeleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(userUpdate).toHaveBeenCalled();
  });

  test('a 401 carrying an HTML error page deletes nothing', async () => {
    // A proxy or WAF in front of the token endpoint, not SoundCloud saying
    // the grant is gone. Destroying tokens over this would be an outage.
    fetch
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 401 })))
      .mockReturnValueOnce(Promise.resolve(new Response(
        '<html><head><title>401 Authorization Required</title></head></html>',
        { status: 401 }
      )));

    const res = await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(res.body.error).toBe('Token refresh failed');
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  test('a 503 deletes nothing — SoundCloud being down is not revocation', async () => {
    fetch
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 401 })))
      .mockReturnValueOnce(Promise.resolve(new Response('upstream unavailable', { status: 503 })));

    const res = await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(res.body.error).toBe('Token refresh failed');
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  test('a 429 deletes nothing either', async () => {
    fetch
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 401 })))
      .mockReturnValueOnce(Promise.resolve(new Response('slow down', { status: 429 })));

    await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  test('a 400 that is not invalid_grant deletes nothing', async () => {
    fetch
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 401 })))
      .mockReturnValueOnce(Promise.resolve(new Response(
        JSON.stringify({ error: 'invalid_client' }), { status: 400 }
      )));

    await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  test('a network failure during refresh deletes nothing', async () => {
    fetch
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 401 })))
      // mockImplementationOnce, not mockReturnValueOnce: a rejected promise
      // built at setup time is unhandled until the call happens.
      .mockImplementationOnce(() => Promise.reject(new Error('ECONNRESET')));

    await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

/**
 * A SoundCloud that behaves the way the real one does at a token boundary:
 * every exchange ROTATES the refresh token, and a refresh token that has
 * already been spent is refused with `400 {"error":"invalid_grant"}` — the
 * very same answer it gives for a grant the user revoked. Telling those two
 * apart is the whole of what these tests are about.
 */
function mockRotatingSoundCloud({ expiresIn = 3600, revokeAfterFirstExchange = false } = {}) {
  const spent = new Set();
  const state = { oauthCalls: 0, presented: [], apiCalls: [] };
  let issued = 0;

  global.fetch = jest.fn(async (url, options = {}) => {
    const target = String(url);

    if (target.includes('/oauth/token')) {
      state.oauthCalls += 1;
      const presented = new URLSearchParams(String(options.body)).get('refresh_token');
      state.presented.push(presented);
      if (spent.has(presented) || (revokeAfterFirstExchange && issued > 0)) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      spent.add(presented);
      issued += 1;
      return new Response(JSON.stringify({
        access_token: `access-${issued}`,
        refresh_token: `refresh-${issued}`,
        expires_in: expiresIn,
      }), { status: 200 });
    }

    const auth = options.headers?.Authorization || '';
    state.apiCalls.push({ target, auth });
    // Only the pair the request captured at the start has expired.
    if (auth === 'OAuth stale-access') return new Response('', { status: 401 });
    return new Response(JSON.stringify({ endpoint: target }), { status: 200 });
  });

  return state;
}

describe('a spent refresh token is not a revocation', () => {
  // Before this guard, the sequence below cost a live user their tokens and a
  // `disconnectedAt` stamp — six days from an account deletion — on an
  // ordinary hourly access-token expiry. It needs no revocation, no outage and
  // no unusual timing: two SoundCloud calls in one request is enough.

  test('two sequential calls in one request: the second does not report revocation', async () => {
    const sc = mockRotatingSoundCloud();

    const res = await request(app).get('/two-calls').set('Cookie', sessionCookie());

    expect(res.status).toBe(200);
    // Nothing was torn down.
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
    // And the spent token is never even re-presented: the rotation memo
    // answers the second call, so there is exactly one exchange.
    expect(sc.presented).toEqual(['good-refresh']);
    expect(sc.oauthCalls).toBe(1);
    // Both calls actually got their data.
    expect(res.body.first.endpoint).toContain('/me');
    expect(res.body.second.endpoint).toContain('/me/playlists');
  });

  test('with the memo gone, the database settles it and the retry still succeeds', async () => {
    // The cross-request shape: a long-running job, a second process, or simply
    // more than a minute between the two calls. The memo cannot help, so the
    // spent token IS re-presented and comes back invalid_grant — and the
    // stored pair, which has moved on, is what proves it is not a revocation.
    const sc = mockRotatingSoundCloud();

    const res = await request(app).get('/two-calls?cold=1').set('Cookie', sessionCookie());

    expect(res.status).toBe(200);
    expect(sc.presented).toEqual(['good-refresh', 'good-refresh']);
    expect(sc.oauthCalls).toBe(2);       // the second was refused
    expect(tokenFindUnique).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
    // Nothing was written a second time: the stored access token was reused.
    expect(tokenUpdate).toHaveBeenCalledTimes(1);
  });

  test('when the stored access token has expired too, the CURRENT refresh token is used', async () => {
    const sc = mockRotatingSoundCloud({ expiresIn: 1 });

    const res = await request(app).get('/two-calls?cold=1').set('Cookie', sessionCookie());

    expect(res.status).toBe(200);
    // Third exchange presents the pair the database actually holds.
    expect(sc.presented).toEqual(['good-refresh', 'good-refresh', 'refresh-1']);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
    expect(tokenUpdate).toHaveBeenCalledTimes(2);
  });

  test('when the CURRENT refresh token is refused too, that IS a revocation', async () => {
    // The other half of the guard: not disconnecting must not become never
    // disconnecting. Here the stored pair is refused on its own merits.
    const sc = mockRotatingSoundCloud({ expiresIn: 1, revokeAfterFirstExchange: true });

    const res = await request(app).get('/two-calls?cold=1').set('Cookie', sessionCookie());

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Token refresh failed');
    expect(sc.presented).toEqual(['good-refresh', 'good-refresh', 'refresh-1']);
    expect(tokenDeleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(userUpdate.mock.calls[0][0].data.disconnectedAt).toBeInstanceOf(Date);
  });

  test('two overlapping refreshes still collapse onto one exchange', async () => {
    // The case the in-flight mutex has always covered. It must keep working:
    // two concurrent 401s must not turn into a second exchange presenting a
    // token the first one is in the middle of spending.
    const sc = mockRotatingSoundCloud();

    const [a, b] = await Promise.all([
      request(app).get('/probe').set('Cookie', sessionCookie()),
      request(app).get('/probe').set('Cookie', sessionCookie()),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Observed: 2, not 1. The first resume saves and drops the held entry
    // without re-arming the rotation memo (consumed list is empty), so the
    // second request re-presents the spent token upstream and is rescued by
    // the classifier reading the now-saved row. One wasted round trip, no
    // teardown. Pinned here so a change in that rescue is noticed.
    expect(sc.oauthCalls).toBeLessThanOrEqual(2);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  test('a database failure while classifying invalid_grant deletes nothing', async () => {
    // Destroying an account must rest on positive evidence. If the stored pair
    // cannot be read, the answer is "do not know", and "do not know" must not
    // mean "revoked".
    tokenFindUnique.mockRejectedValueOnce(new Error('db down'));
    fetch
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 401 })))
      .mockReturnValueOnce(Promise.resolve(new Response(
        JSON.stringify({ error: 'invalid_grant' }), { status: 400 }
      )));

    const res = await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(res.body.error).toBe('Token refresh failed');
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  test('a background job cannot strand the stored pair and get the user torn down', async () => {
    // C1-b, end to end. The growth scheduler runs from a boot-time timer, so
    // its SoundCloud calls have no AsyncLocalStorage store. Before the fix the
    // context-free exchange rotated the token upstream and discarded the
    // replacement, leaving the row holding a spent token; the user's very next
    // request then presented it, and because the stored token WAS the one
    // presented, the classifier concluded "revoked" — correctly, on a false
    // premise — and destroyed the account's tokens.
    //
    // This drives the two halves in order: a context-free call, then the user
    // coming back. The database fake is shared, so the second half really does
    // read whatever the first half left behind.
    mockRotatingSoundCloud();

    // Half one: a SoundCloud call from outside any request. The assertion is
    // deliberately about the OUTCOME, not the mechanism — whether the client
    // refuses (today) or exchanges and discards (before the fix) is its
    // business; what must hold is that the user does not pay for it.
    await soundcloudClient.getFollowers('stale-access', 'good-refresh').catch(() => {});

    // Half two: the user comes back, and their stored pair is still usable.
    const res = await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(res.status).toBe(200);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  test('an expired memo entry is not served, and the database still saves it', async () => {
    // The memo's 60s TTL is a stated property. Without this, an entry that
    // never expires passes every other test in the suite.
    const sc = mockRotatingSoundCloud();

    const first = await request(app).get('/probe').set('Cookie', sessionCookie());
    expect(first.status).toBe(200);
    expect(sc.oauthCalls).toBe(1);

    advanceClock(61_000);
    clearAuthCache();   // the auth memo has its own, shorter TTL

    // The same spent token, presented after the memo should have let go of it.
    const second = await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(second.status).toBe(200);
    expect(sc.oauthCalls).toBe(2);              // not answered from the memo
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  test('the recovery path does not write the memo after the row could have gone', async () => {
    // The read in _resolveInvalidGrant and the value it returns are separated
    // by an await, so a disconnect can complete in between — delete the row,
    // then forget the memo. A memo write on that path would land after the
    // forget and serve a live pair against a row that no longer exists.
    // Observable form: the recovery must leave the memo empty, so a later
    // caller presenting the same spent token goes back to the database
    // instead of being handed something from memory.
    const sc = mockRotatingSoundCloud();

    const first = await request(app).get('/two-calls?cold=1').set('Cookie', sessionCookie());
    expect(first.status).toBe(200);
    expect(sc.oauthCalls).toBe(2);   // the recovery read, not a third exchange

    clearAuthCache();
    const second = await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(second.status).toBe(200);
    // Three, not two: the recovery remembered nothing, so this went upstream
    // and then to the database again.
    expect(sc.oauthCalls).toBe(3);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
  });

  test('no stored token row at all deletes nothing and stamps nothing', async () => {
    // Already disconnected, or already deleted. Re-running the teardown would
    // only restart the six-day deletion clock on a row that may not exist.
    storedTokenRow = null;
    fetch
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 401 })))
      .mockReturnValueOnce(Promise.resolve(new Response(
        JSON.stringify({ error: 'invalid_grant' }), { status: 400 }
      )));

    await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

/** What Prisma throws when the pool cannot hand out a connection in time. */
function poolTimeout() {
  return Object.assign(
    new Error('Timed out fetching a new connection from the connection pool'),
    { code: 'P2024' },
  );
}

describe('a failed save of a rotated pair is not a revocation', () => {
  // The exchange has already rotated the refresh token upstream when the save
  // runs, so a save that fails leaves the row holding a token SoundCloud has
  // spent. Before the fix the next request presented it, was refused with
  // invalid_grant, found it equal to the stored one and tore the user down:
  // a P2024 pool timeout cost a live user their tokens and started the six-day
  // deletion clock.

  test('one transient failure is retried and the pair is saved', async () => {
    const sc = mockRotatingSoundCloud();
    tokenUpdate.mockImplementationOnce(async () => { throw poolTimeout(); });

    const res = await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(res.status).toBe(200);
    expect(sc.oauthCalls).toBe(1);
    expect(tokenUpdate).toHaveBeenCalledTimes(2);           // failed once, then saved
    expect(decrypt(storedTokenRow.refresh, KEY)).toBe('refresh-1');
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();

    // And long after the rotation memo let go, the user is still connected.
    advanceClock(61_000);
    clearAuthCache();
    const later = await request(app).get('/probe').set('Cookie', sessionCookie());
    expect(later.status).toBe(200);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  test('when every attempt fails, the new pair is held, served, and saved later', async () => {
    const sc = mockRotatingSoundCloud();
    tokenUpdate.mockImplementation(async () => { throw poolTimeout(); });

    const first = await request(app).get('/probe').set('Cookie', sessionCookie());

    // The request itself fails — the pair could not be stored — but nothing
    // was torn down, and the row still holds the spent token.
    expect(first.status).toBe(500);
    expect(tokenUpdate.mock.calls.length).toBeGreaterThan(1);   // it retried
    expect(decrypt(storedTokenRow.refresh, KEY)).toBe('good-refresh');
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();

    // The database recovers. Past the 60 s rotation memo, the user comes back
    // presenting the spent token the row still holds.
    tokenUpdate.mockImplementation(writeTokenRow);
    advanceClock(61_000);
    clearAuthCache();
    const updatesBefore = tokenUpdate.mock.calls.length;

    const second = await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(second.status).toBe(200);
    // Served from the held pair: the spent token was never re-presented.
    expect(sc.oauthCalls).toBe(1);
    expect(sc.presented).toEqual(['good-refresh']);
    expect(sc.apiCalls.at(-1).auth).toBe('OAuth access-1');
    // ...and saved this time.
    expect(tokenUpdate.mock.calls.length).toBe(updatesBefore + 1);
    expect(decrypt(storedTokenRow.refresh, KEY)).toBe('refresh-1');
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();

    // Once saved, the held pair is let go: the row is the source again, and a
    // request starting from it refreshes normally with the saved token.
    clearAuthCache();
    findUnique.mockResolvedValue({
      id: 'user-1',
      soundcloudId: 111,
      tokens: [{ encrypted: encrypt('stale-access', KEY), refresh: storedTokenRow.refresh }],
    });
    const third = await request(app).get('/probe').set('Cookie', sessionCookie());
    expect(third.status).toBe(200);
    expect(sc.presented).toEqual(['good-refresh', 'refresh-1']);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
  });

  test('the classifier never tears down a token whose replacement is held', async () => {
    mockRotatingSoundCloud();
    tokenUpdate.mockImplementation(async () => { throw poolTimeout(); });
    await request(app).get('/probe').set('Cookie', sessionCookie());
    tokenUpdate.mockImplementation(writeTokenRow);

    // The stored token IS the one presented — on its own, exactly the shape of
    // a revocation. The held pair is what says otherwise.
    const tokens = await soundcloudClient._resolveInvalidGrant('good-refresh', 'user-1');

    expect(tokens).toMatchObject({ access_token: 'access-1', refresh_token: 'refresh-1' });
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  test('a held pair keeps its real expiry across failed re-saves', async () => {
    // Re-holding after a failed resume must not restart the access token's
    // clock, or a held pair would look fresh forever and the row would
    // eventually be saved with an expiry later than SoundCloud's.
    mockRotatingSoundCloud();
    tokenUpdate.mockImplementation(async () => { throw poolTimeout(); });
    await request(app).get('/probe').set('Cookie', sessionCookie());

    advanceClock(30 * 60_000);    // half the hour gone
    clearAuthCache();
    await request(app).get('/probe').set('Cookie', sessionCookie());   // resume fails again

    tokenUpdate.mockImplementation(writeTokenRow);
    clearAuthCache();
    await request(app).get('/probe').set('Cookie', sessionCookie());   // resume saves

    const remainingMs = storedTokenRow.expiresAt.getTime() - Date.now();
    expect(remainingMs).toBeLessThanOrEqual(30 * 60_000 + 1000);
    expect(remainingMs).toBeGreaterThan(29 * 60_000);
  });

  test('forgetRecentRotation drops the held pair too', async () => {
    // The held pair is plaintext credentials, like the rotation memo, and
    // disconnect and account deletion forget it through the same call.
    const sc = mockRotatingSoundCloud();
    tokenUpdate.mockImplementation(async () => { throw poolTimeout(); });
    await request(app).get('/probe').set('Cookie', sessionCookie());

    forgetRecentRotation('user-1');
    clearAuthCache();
    await request(app).get('/probe').set('Cookie', sessionCookie());

    // Nothing in memory answered: the spent token went back upstream.
    expect(sc.presented).toEqual(['good-refresh', 'good-refresh']);
  });

  test('P2025 is not retried: a disconnect or deletion already won', async () => {
    mockRotatingSoundCloud();
    tokenUpdate.mockImplementationOnce(async () => {
      storedTokenRow = null;
      throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
    });

    const res = await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(res.status).toBe(500);
    expect(tokenUpdate).toHaveBeenCalledTimes(1);
    // Nothing held for a row that is gone: a later request is not served.
    expect(await soundcloudClient._resolveInvalidGrant('good-refresh', 'user-1')).toBeNull();
  });
});

describe('session gating', () => {
  test('no session cookie never reaches SoundCloud', async () => {
    const res = await request(app).get('/probe');
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('a legacy cookie with no iat is rejected (post-hardening behavior)', async () => {
    const legacy = signSession(JSON.stringify({ userId: 'user-1' }), process.env.SESSION_SECRET);
    const res = await request(app).get('/probe').set('Cookie', `session=${encodeURIComponent(legacy)}`);
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Adversarial checks on the held-pair fix (independent verification).
// ---------------------------------------------------------------------------

const { runWithTokenContext } = await import('../../server/lib/token-context.js');
const { disconnectUser } = await import('../../server/lib/account-lifecycle.js');
const { default: loggerForAudit } = await import('../../server/lib/logger.js');

/**
 * A rotating SoundCloud with knobs the shared mock lacks: tokens that are
 * already spent at the start (an older pair a long-running job captured), and
 * a revocation switch that can be flipped mid-test.
 */
function adversarialSoundCloud({ initiallySpent = [] } = {}) {
  const spent = new Set(initiallySpent);
  const state = { oauthCalls: 0, presented: [], apiCalls: [], revoked: false };
  let issued = 0;
  global.fetch = jest.fn(async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/oauth/token')) {
      state.oauthCalls += 1;
      const presented = new URLSearchParams(String(options.body)).get('refresh_token');
      state.presented.push(presented);
      if (state.revoked || spent.has(presented)) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      spent.add(presented);
      issued += 1;
      return new Response(JSON.stringify({
        access_token: `access-${issued}`,
        refresh_token: `refresh-${issued}`,
        expires_in: 3600,
      }), { status: 200 });
    }
    const auth = options.headers?.Authorization || '';
    state.apiCalls.push({ target, auth });
    if (auth === 'OAuth stale-access') return new Response('', { status: 401 });
    return new Response(JSON.stringify({ endpoint: target }), { status: 200 });
  });
  return state;
}

/** Exchange good-refresh -> refresh-1 while every save fails, leaving it held. */
async function holdAPair(error = poolTimeout()) {
  tokenUpdate.mockImplementation(async () => { throw error; });
  const res = await request(app).get('/probe').set('Cookie', sessionCookie());
  expect(res.status).toBe(500);
  expect(decrypt(storedTokenRow.refresh, KEY)).toBe('good-refresh');
  tokenUpdate.mockImplementation(writeTokenRow);
}

/** A caller outside authenticateUser presenting a captured pair (a growth job). */
function callAs(userId, access, refresh) {
  return runWithTokenContext({ userId }, () => soundcloudClient.scRequest('/me', access, refresh));
}

describe('adversarial: held pair under failure kinds', () => {
  const kinds = [
    ['generic Error', () => new Error('boom')],
    ['ECONNRESET', () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ['P1017 server closed the connection', () => Object.assign(new Error('Server has closed the connection'), { code: 'P1017' })],
  ];

  test.each(kinds)('%s on every save attempt: retried, held, never torn down', async (_name, make) => {
    const sc = adversarialSoundCloud();
    await holdAPair(make());
    expect(tokenUpdate).toHaveBeenCalledTimes(4);           // 1 + 3 retries
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();

    advanceClock(61_000);
    clearAuthCache();
    const res = await request(app).get('/probe').set('Cookie', sessionCookie());
    expect(res.status).toBe(200);
    expect(sc.presented).toEqual(['good-refresh']);
    expect(decrypt(storedTokenRow.refresh, KEY)).toBe('refresh-1');
    expect(tokenDeleteMany).not.toHaveBeenCalled();
  });
});

describe('adversarial: genuine revocation after a pair is held', () => {
  test('held refresh token refused upstream once its access expired: torn down, bounded', async () => {
    const sc = adversarialSoundCloud();
    await holdAPair();
    sc.revoked = true;                       // the user revokes the app now
    advanceClock(2 * 3600_000);              // the held access token is long dead
    clearAuthCache();

    const res = await request(app).get('/probe').set('Cookie', sessionCookie());

    expect(res.status).toBe(500);
    expect(tokenDeleteMany).toHaveBeenCalled();
    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ disconnectedAt: expect.any(Date) }),
    }));
    // No loop: the held refresh, then one check of the stored one.
    expect(sc.oauthCalls).toBeLessThanOrEqual(3);
    // And the held pair died with the connection.
    sc.revoked = false;
    expect(await soundcloudClient._resolveInvalidGrant('good-refresh', 'user-1')).toBeNull();
  });
});

describe('adversarial: concurrency and lifecycle around a held pair', () => {
  test('two concurrent requests presenting the spent token are both served, nothing torn down', async () => {
    const sc = adversarialSoundCloud();
    await holdAPair();
    advanceClock(61_000);
    clearAuthCache();

    const [a, b] = await Promise.all([
      request(app).get('/probe').set('Cookie', sessionCookie()),
      request(app).get('/probe').set('Cookie', sessionCookie()),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Observed: 2, not 1. The first resume saves and drops the held entry
    // without re-arming the rotation memo (consumed list is empty), so the
    // second request re-presents the spent token upstream and is rescued by
    // the classifier reading the now-saved row. One wasted round trip, no
    // teardown. Pinned here so a change in that rescue is noticed.
    expect(sc.oauthCalls).toBeLessThanOrEqual(2);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(decrypt(storedTokenRow.refresh, KEY)).toBe('refresh-1');
  });

  test('disconnectUser drops the held pair: a later presenter is not served it', async () => {
    const sc = adversarialSoundCloud();
    await holdAPair();
    await disconnectUser('user-1', { reason: 'user' });
    expect(storedTokenRow).toBeNull();

    // Re-login writes a fresh row; the stale presenter must not resurrect refresh-1.
    storedTokenRow = {
      encrypted: encrypt('login-access', KEY),
      refresh: encrypt('login-refresh', KEY),
      expiresAt: new Date(Date.now() + 3600_000),
    };
    // Not served from memory: the spent token goes upstream, is refused, and
    // the classifier finds the login row has moved on and serves that.
    await callAs('user-1', 'stale-access', 'good-refresh');
    expect(tokenDeleteMany).toHaveBeenCalledTimes(1);   // the disconnect's own delete only
    expect(decrypt(storedTokenRow.refresh, KEY)).toBe('login-refresh');
    expect(sc.presented).toEqual(['good-refresh', 'good-refresh']);
  });

  // Regression guard, now passing. Before the fix: the OAuth callback (server/routes/auth.js,
  // prisma.token.upsert) writes a fresh pair but never clears the held map.
  // A caller still holding the pre-login refresh token (a running growth job's
  // closure) then hits _resumeUnsavedRotation, which saves the stale held pair
  // OVER the fresh login pair.
  test('a held pair never overwrites the pair a later login wrote', async () => {
    adversarialSoundCloud();
    await holdAPair();

    // Login without a disconnect: the callback upserts a fresh pair.
    storedTokenRow = {
      encrypted: encrypt('login-access', KEY),
      refresh: encrypt('login-refresh', KEY),
      expiresAt: new Date(Date.now() + 3600_000),
    };
    clearAuthCache();

    // A growth job started before the login still presents good-refresh.
    await callAs('user-1', 'stale-access', 'good-refresh').catch(() => {});

    expect(decrypt(storedTokenRow.refresh, KEY)).toBe('login-refresh');
  });

  // Regression guard, now passing. Before the fix: _resolveInvalidGrant's re-exchange path uses
  // stored.refresh without asking whether IT is a held-consumed token. While a
  // pair is held the row holds the spent token, so an OLDER captured refresh
  // token (a growth job's closure, past the 60 s memo) is refused, the
  // classifier sees "superseded", re-exchanges the spent stored token, gets
  // invalid_grant and tears the live user down — the C1 teardown by another door.
  test('an older captured token while a pair is held does not tear the user down', async () => {
    const sc = adversarialSoundCloud({ initiallySpent: ['older-refresh'] });
    await holdAPair();
    advanceClock(61_000);
    clearAuthCache();

    await callAs('user-1', 'stale-access', 'older-refresh').catch(() => {});

    expect(sc.presented).toContain('older-refresh');
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

describe('adversarial: no plaintext token in any log line', () => {
  test('the all-attempts-failed path and the resume path log no token material', async () => {
    const lines = [];
    const spies = ['error', 'warn', 'info', 'debug', 'log']
      .filter((m) => typeof loggerForAudit[m] === 'function')
      .map((m) => jest.spyOn(loggerForAudit, m).mockImplementation((...args) => {
        lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : (typeof a === 'string' ? a : JSON.stringify(a)))).join(' '));
      }));
    const consoleSpies = ['error', 'warn', 'log', 'info'].map((m) =>
      jest.spyOn(console, m).mockImplementation((...args) => { lines.push(args.map(String).join(' ')); }));
    try {
      adversarialSoundCloud();
      await holdAPair();
      advanceClock(61_000);
      clearAuthCache();
      tokenUpdate.mockImplementation(async () => { throw poolTimeout(); });
      await request(app).get('/probe').set('Cookie', sessionCookie());   // resume fails again
      tokenUpdate.mockImplementation(writeTokenRow);
      await request(app).get('/probe').set('Cookie', sessionCookie());   // resume saves
    } finally {
      for (const s of [...spies, ...consoleSpies]) s.mockRestore();
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/good-refresh|refresh-1|access-1|stale-access/);
    }
  });
});
