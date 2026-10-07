import { cursorEndpoint, isSoundCloudApiUrl, InvalidCursorError } from '../server/lib/sc-cursor.js';

// Shapes SoundCloud actually returned for next_href on 2026-10-07.
const live = {
  meLikes: 'https://api.soundcloud.com/me/likes/tracks?cursor=abc&linked_partitioning=1&page_size=50',
  userLikes: 'https://api.soundcloud.com/users/123/likes/tracks?cursor=abc&linked_partitioning=1&page_size=50',
  userPlaylists: 'https://api.soundcloud.com/users/123/playlists?cursor=abc&linked_partitioning=1&page_size=50&show_tracks=false',
};

describe('cursorEndpoint: a cursor may only continue the request it came from', () => {
  test('real SoundCloud cursors pass, as path + query', () => {
    expect(cursorEndpoint(live.meLikes, '/me/likes/tracks')).toBe('/me/likes/tracks?cursor=abc&linked_partitioning=1&page_size=50');
    expect(cursorEndpoint(live.userLikes, '/users/123/likes/tracks?limit=50&linked_partitioning=1')).toMatch(/^\/users\/123\/likes\/tracks\?/);
    expect(cursorEndpoint(live.userPlaylists, '/users/123/playlists')).toMatch(/show_tracks=false/);
    // The same user in URN form, literal or encoded.
    expect(() => cursorEndpoint('https://api.soundcloud.com/users/soundcloud:users:123/likes/tracks?cursor=x', '/users/123/likes/tracks')).not.toThrow();
    expect(() => cursorEndpoint('https://api.soundcloud.com/users/soundcloud%3Ausers%3A123/likes/tracks?cursor=x', '/users/123/likes/tracks')).not.toThrow();
  });

  test.each([
    ['another endpoint', 'https://api.soundcloud.com/tracks/1/streams', '/me/likes/tracks'],
    ['a traversal', 'https://api.soundcloud.com/me/likes/tracks/../../tracks/1/streams', '/me/likes/tracks'],
    ['an encoded traversal', 'https://api.soundcloud.com/me/likes/tracks/%2e%2e/%2e%2e/tracks/1/streams', '/me/likes/tracks'],
    ['another user (past assertFollowedUser)', 'https://api.soundcloud.com/users/999/likes/tracks?cursor=x', '/users/123/likes/tracks'],
    ['another host', 'https://evil.example/me/likes/tracks?cursor=x', '/me/likes/tracks'],
    ['plain http', 'http://api.soundcloud.com/me/likes/tracks?cursor=x', '/me/likes/tracks'],
    ['a port', 'https://api.soundcloud.com:8443/me/likes/tracks?cursor=x', '/me/likes/tracks'],
    ['userinfo', 'https://x@api.soundcloud.com/me/likes/tracks?cursor=x', '/me/likes/tracks'],
    ['an unknown parameter', 'https://api.soundcloud.com/me/likes/tracks?cursor=x&client_id=y', '/me/likes/tracks'],
    ['not a URL', '/me/likes/tracks?cursor=x', '/me/likes/tracks'],
    ['a malformed escape', 'https://api.soundcloud.com/me/likes/%E0%A4%A/tracks', '/me/likes/tracks'],
  ])('refuses %s', (_label, next, expected) => {
    expect(() => cursorEndpoint(next, expected)).toThrow(InvalidCursorError);
  });

  test('the error is a 400', () => {
    try {
      cursorEndpoint('https://evil.example/', '/me/likes/tracks');
    } catch (e) {
      expect(e.status).toBe(400);
    }
  });

  test('isSoundCloudApiUrl is the validator-level gate', () => {
    expect(isSoundCloudApiUrl(live.meLikes)).toBe(true);
    expect(isSoundCloudApiUrl('https://evil.example/x')).toBe(false);
    expect(isSoundCloudApiUrl('nonsense')).toBe(false);
  });
});
