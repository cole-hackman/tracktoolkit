import { jest } from '@jest/globals';
import { Response } from 'node-fetch';

// A refresh persists, so the paths that refresh need a database. Mocked rather
// than stubbed out, because `_refreshAndPersistNow` now REFUSES to exchange
// without a user context — there would be nowhere to put the rotated pair —
// and the tests below that refresh therefore run inside a context, exactly as
// `authenticateUser` (and, since C1-b, the growth scheduler) opens one.
const tokenUpdate = jest.fn().mockResolvedValue({});
const tokenFindUnique = jest.fn().mockResolvedValue(null);
jest.unstable_mockModule('../server/lib/prisma.js', () => ({
  default: { token: { update: tokenUpdate, findUnique: tokenFindUnique } },
}));

// We will import the client file and monkey patch fetch
const { soundcloudClient, clearRecentRotations } =
  await import('../server/lib/soundcloud-client.js');
const { runWithTokenContext } = await import('../server/lib/token-context.js');

/** What every real caller does: refresh inside a context that can persist. */
const asUser = (fn) => runWithTokenContext({ userId: 'user-1' }, fn);

describe('soundcloud client behaviors', () => {
  const endpoint = '/me';
  const okJson = { ok: true };

  beforeEach(() => {
    global.fetch = jest.fn();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    tokenUpdate.mockClear();
    // Module state: a rotation remembered by one test would otherwise answer
    // the next test's refresh without a fetch.
    clearRecentRotations();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('refreshes on 401 and retries once', async () => {
    const first = Promise.resolve(new Response('', { status: 401 }));
    const tokenResponse = Promise.resolve(new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2' }), { status: 200 }));
    const second = Promise.resolve(new Response(JSON.stringify(okJson), { status: 200 }));

    // order: first call 401, token refresh 200, retry 200
    fetch
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(tokenResponse)
      .mockReturnValueOnce(second);

    const res = await asUser(() => soundcloudClient.scRequest(endpoint, 'old', 'r1'));
    expect(res).toEqual(okJson);
    expect(fetch).toHaveBeenCalledTimes(3);
    // The rotated pair is stored, which is the whole point of having a context.
    expect(tokenUpdate).toHaveBeenCalledTimes(1);
  });

  test('backs off on 429 and retries', async () => {
    jest.useFakeTimers();
    const first = Promise.resolve(new Response('', { status: 429, headers: { 'Retry-After': '1' } }));
    const second = Promise.resolve(new Response(JSON.stringify(okJson), { status: 200 }));
    fetch.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const p = soundcloudClient.scRequest(endpoint, 'a', 'r');
    await jest.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res).toEqual(okJson);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('stops retrying after repeated 429 responses', async () => {
    jest.useFakeTimers();
    fetch
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 429 })))
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 429 })));

    const request = soundcloudClient.scRequest(endpoint, 'a', 'r', { max429Retries: 1 });
    // Attach the rejection handler BEFORE advancing timers: the request now
    // rejects during the advance, and an unattached rejection would be unhandled.
    const rejects = expect(request).rejects.toThrow('API request failed: 429');
    await jest.advanceTimersByTimeAsync(1000);

    await rejects;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('an exhausted 429 carries status 429 so callers can stop instead of string-matching', async () => {
    jest.useFakeTimers();
    fetch
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 429 })))
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 429 })));

    const request = soundcloudClient.scRequest(endpoint, 'a', 'r', { max429Retries: 1 });
    const rejects = expect(request).rejects.toMatchObject({ status: 429 });
    await jest.advanceTimersByTimeAsync(1000);

    await rejects;
  });

  test('refreshes download token only once on repeated 401 responses', async () => {
    fetch
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 401 })))
      .mockReturnValueOnce(Promise.resolve(new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2' }), { status: 200 })))
      .mockReturnValueOnce(Promise.resolve(new Response('', { status: 401 })));

    await expect(asUser(() =>
      soundcloudClient.getDownloadLink('old', 'r1', 'https://api.soundcloud.com/tracks/123/download')
    )).rejects.toThrow('Download request failed: 401');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('a refresh with no token context refuses instead of spending the token', async () => {
    // C1-b. A context-free exchange rotates the refresh token upstream and has
    // nowhere to store the replacement, leaving the database holding a token
    // SoundCloud has already consumed — which the revocation classifier then
    // correctly reads as "revoked" on the user's next request, and deletes
    // their account's tokens. Refusing keeps the stored pair usable and makes
    // the caller's mistake loud.
    fetch.mockReturnValueOnce(Promise.resolve(new Response('', { status: 401 })));

    await expect(soundcloudClient.scRequest(endpoint, 'old', 'r1'))
      .rejects.toThrow('Token refresh failed');

    // One call: the 401. The token endpoint was never reached.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('oauth/token'))).toBe(false);
    expect(tokenUpdate).not.toHaveBeenCalled();
  });

  test('fetches a followed user liked tracks page with linked pagination', async () => {
    const payload = {
      collection: [{ id: 123, title: 'Track' }],
      next_href: 'https://api.soundcloud.com/users/42/likes/tracks?cursor=next',
      total_results: 10,
    };
    fetch.mockReturnValueOnce(Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })));

    const page = await soundcloudClient.getUserLikedTracksPage('a', 'r', 42, { limit: 25 });

    expect(page).toEqual(payload);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://api.soundcloud.com/users/42/likes/tracks?limit=25&linked_partitioning=1');
    expect(options.headers.Authorization).toBe('OAuth a');
  });

  test('continues a followed user liked tracks page from a next_href cursor', async () => {
    const payload = { collection: [{ id: 456, title: 'Next Track' }], next_href: null };
    const nextHref = 'https://api.soundcloud.com/users/42/likes/tracks?cursor=abc&limit=25';
    fetch.mockReturnValueOnce(Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })));

    const page = await soundcloudClient.getUserLikedTracksPage('a', 'r', 42, { next: nextHref });

    expect(page).toEqual(payload);
    const [url] = fetch.mock.calls[0];
    expect(url).toBe('https://api.soundcloud.com/users/42/likes/tracks?cursor=abc&limit=25');
  });

  describe('getPlaylistWithTracks access levels', () => {
    const okPlaylist = () => Promise.resolve(new Response(JSON.stringify({ id: 1, tracks: [] }), { status: 200 }));

    test('allAccess asks SoundCloud for blocked tracks too', async () => {
      fetch.mockReturnValueOnce(okPlaylist());
      await soundcloudClient.getPlaylistWithTracks('a', 'r', 1, { allAccess: true });
      const [url] = fetch.mock.calls[0];
      expect(url).toBe('https://api.soundcloud.com/playlists/1?show_tracks=true&access=playable,preview,blocked');
    });

    test('the default sends no access parameter', async () => {
      fetch.mockReturnValueOnce(okPlaylist());
      await soundcloudClient.getPlaylistWithTracks('a', 'r', 1);
      const [url] = fetch.mock.calls[0];
      expect(url).toBe('https://api.soundcloud.com/playlists/1?show_tracks=true');
      expect(url).not.toContain('access=');
    });
  });

  test('fetches a followed user playlists page without embedded tracks', async () => {
    const payload = { collection: [{ id: 99, title: 'Set', track_count: 12 }], next_href: null };
    fetch.mockReturnValueOnce(Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })));

    await soundcloudClient.getUserPlaylistsPage('a', 'r', 42, { limit: 50 });

    const [url] = fetch.mock.calls[0];
    expect(url).toBe('https://api.soundcloud.com/users/42/playlists?limit=50&linked_partitioning=1&show_tracks=false');
  });

  // Regression guard: unfollowUser/unlikeTrack take tokens FIRST (unlike their
  // id-first inverses followUser/likeTrack). A swapped call sends the target id
  // as the OAuth token — the growth-reversal bug fixed in July 2026.
  describe('unfollow / unlike argument order', () => {
    test('unfollowUser targets the user id and authenticates with the access token', async () => {
      fetch.mockReturnValueOnce(Promise.resolve(new Response(JSON.stringify(okJson), { status: 200 })));

      await soundcloudClient.unfollowUser('tok', 'ref', 42);

      const [url, options] = fetch.mock.calls[0];
      expect(url).toBe('https://api.soundcloud.com/me/followings/42');
      expect(options.method).toBe('DELETE');
      expect(options.headers.Authorization).toBe('OAuth tok');
    });

    test('unlikeTrack targets the track id and authenticates with the access token', async () => {
      fetch.mockReturnValueOnce(Promise.resolve(new Response(JSON.stringify(okJson), { status: 200 })));

      await soundcloudClient.unlikeTrack('tok', 'ref', 77);

      const [url, options] = fetch.mock.calls[0];
      expect(url).toBe('https://api.soundcloud.com/likes/tracks/77');
      expect(options.method).toBe('DELETE');
      expect(options.headers.Authorization).toBe('OAuth tok');
    });

    test('likeTrack is id-first: track id in the path, access token in the header', async () => {
      fetch.mockReturnValueOnce(Promise.resolve(new Response(JSON.stringify(okJson), { status: 200 })));

      await soundcloudClient.likeTrack(77, 'tok', 'ref');

      const [url, options] = fetch.mock.calls[0];
      expect(url).toBe('https://api.soundcloud.com/likes/tracks/77');
      expect(options.method).toBe('POST');
      expect(options.headers.Authorization).toBe('OAuth tok');
    });
  });

  describe('paginate crawl bounds', () => {
    const page = (start, count, nextHref) => Promise.resolve(new Response(JSON.stringify({
      collection: Array.from({ length: count }, (_, i) => ({ id: start + i })),
      next_href: nextHref,
    }), { status: 200 }));

    test('follows next_href to exhaustion when no options are passed', async () => {
      fetch
        .mockReturnValueOnce(page(0, 2, 'https://api.soundcloud.com/x?cursor=2'))
        .mockReturnValueOnce(page(2, 1, null));

      const items = await soundcloudClient.paginate('/x', 'a', 'r', 2);

      expect(items).toHaveLength(3);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    test('stops at maxItems and slices an overshooting page', async () => {
      fetch.mockReturnValueOnce(page(0, 200, 'https://api.soundcloud.com/x?cursor=2'));

      const items = await soundcloudClient.paginate('/x', 'a', 'r', 200, { maxItems: 150 });

      expect(items).toHaveLength(150);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('retries a 429 page honoring Retry-After and continues crawling', async () => {
      jest.useFakeTimers();
      fetch
        .mockReturnValueOnce(Promise.resolve(new Response('', { status: 429, headers: { 'Retry-After': '1' } })))
        .mockReturnValueOnce(page(0, 1, null));

      const p = soundcloudClient.paginate('/x', 'a', 'r', 50);
      await jest.advanceTimersByTimeAsync(1000);
      const items = await p;

      expect(items).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    test('throws after exhausting 429 retries', async () => {
      jest.useFakeTimers();
      fetch
        .mockReturnValueOnce(Promise.resolve(new Response('', { status: 429 })))
        .mockReturnValueOnce(Promise.resolve(new Response('', { status: 429 })));

      const request = soundcloudClient.paginate('/x', 'a', 'r', 50, { max429Retries: 1 });
      const rejects = expect(request).rejects.toThrow('API request failed: 429');
      await jest.advanceTimersByTimeAsync(1000);

      await rejects;
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    test('stops at the deadline and returns the partial crawl', async () => {
      const t0 = Date.now();
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(t0)          // loop check before page 1: within budget
        .mockReturnValue(t0 + 100);       // every later check: past the deadline
      fetch.mockReturnValueOnce(page(0, 2, 'https://api.soundcloud.com/x?cursor=2'));

      const items = await soundcloudClient.paginate('/x', 'a', 'r', 2, { deadlineAt: t0 + 50 });

      expect(items).toHaveLength(2);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
});



describe('paginate crawl bounds', () => {
  // Without these, the per-fetch AbortController deadline resets every page, so
  // a large or slow crawl could hold one HTTP response open for minutes.
  const page = (items, next) => new Response(
    JSON.stringify({ collection: items, next_href: next }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  test('stops at maxPages and reports the result as truncated', async () => {
    global.fetch = jest.fn(async () => page([1, 2], 'https://api.soundcloud.com/next'));

    const items = await soundcloudClient.paginate('/me/likes/tracks', 'at', 'rt', 200, { maxPages: 3 });

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(items).toHaveLength(6);
    expect(items.truncated).toBe(true);
    expect(items.truncatedReason).toBe('page-cap');
  });

  test('a crawl that finishes naturally is NOT marked truncated', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(page([1], 'https://api.soundcloud.com/next'))
      .mockResolvedValueOnce(page([2], null));

    const items = await soundcloudClient.paginate('/me/likes/tracks', 'at', 'rt', 200, { maxPages: 10 });

    expect(items).toEqual([1, 2]);
    expect(items.truncated).toBeUndefined();
  });

  test('the truncated flag does not leak into JSON responses', async () => {
    global.fetch = jest.fn(async () => page([1], 'https://api.soundcloud.com/next'));
    const items = await soundcloudClient.paginate('/me/likes/tracks', 'at', 'rt', 200, { maxPages: 1 });
    // Non-enumerable: existing callers keep treating this as a plain array.
    expect(JSON.parse(JSON.stringify(items))).toEqual([1]);
    expect(items.truncated).toBe(true);
  });

  test('a persistently 401ing endpoint gives up instead of refreshing forever', async () => {
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('oauth/token')) {
        return new Response(
          JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 401 });
    });

    await expect(runWithTokenContext({ userId: 'user-1' }, () =>
      soundcloudClient.paginate('/me/likes/tracks', 'at', 'rt', 200, { max401Retries: 2 })
    )).rejects.toThrow(/401/);

    // Bounded: 2 refresh attempts, not an unbounded spin.
    const refreshCalls = global.fetch.mock.calls.filter(c => String(c[0]).includes('oauth/token'));
    expect(refreshCalls.length).toBeLessThanOrEqual(2);
  });
});
