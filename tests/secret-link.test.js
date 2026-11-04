import { canonicalSoundCloudUrl, extractSecretToken, redactSecretToken, stripSecretToken } from '../server/lib/secret-link.js';

describe('secret-link', () => {
  test('finds the token in a path or a query', () => {
    expect(extractSecretToken('https://soundcloud.com/u/sets/mix/s-AbC123')).toBe('s-AbC123');
    expect(extractSecretToken('soundcloud.com/u/sets/mix/s-AbC123')).toBe('s-AbC123');
    expect(extractSecretToken('https://soundcloud.com/u/sets/mix?secret_token=s-AbC123')).toBe('s-AbC123');
  });

  test('does not mistake a profile or playlist named s-… for a token', () => {
    expect(extractSecretToken('https://soundcloud.com/s-1234')).toBeNull();
    expect(extractSecretToken('https://soundcloud.com/u/sets/s-1234')).toBeNull();
    expect(extractSecretToken('https://soundcloud.com/u/sets/mix')).toBeNull();
    expect(extractSecretToken('not a url at all %%')).toBeNull();
  });

  test('strip removes the token and leaves everything else', () => {
    expect(stripSecretToken('https://soundcloud.com/u/sets/mix/s-AbC123')).toBe('https://soundcloud.com/u/sets/mix');
    expect(stripSecretToken('https://soundcloud.com/u/sets/mix?secret_token=s-AbC123&a=1')).toBe('https://soundcloud.com/u/sets/mix?a=1');
    expect(stripSecretToken('https://soundcloud.com/u/sets/mix')).toBe('https://soundcloud.com/u/sets/mix');
  });

  // The shape SoundCloud's share menu copies (fake token, fake si).
  const SHARED = 'https://soundcloud.com/dj-x/sets/late-mix/s-AbCdEf12345'
    + '?ref=clipboard&p=i&c=1&si=0123456789abcdef0123456789abcdef'
    + '&utm_source=clipboard&utm_medium=text&utm_campaign=social_sharing';

  test('a share-menu link: token from the path despite the tracking query', () => {
    expect(extractSecretToken(SHARED)).toBe('s-AbCdEf12345');
  });

  test('canonical drops every query param and keeps the token in the path', () => {
    expect(canonicalSoundCloudUrl(SHARED)).toBe('https://soundcloud.com/dj-x/sets/late-mix/s-AbCdEf12345');
    expect(canonicalSoundCloudUrl('https://m.soundcloud.com/u/sets/mix?secret_token=s-AbC123'))
      .toBe('https://soundcloud.com/u/sets/mix/s-AbC123');
    expect(canonicalSoundCloudUrl('https://soundcloud.com/some-dj?si=abc&utm_source=x')).toBe('https://soundcloud.com/some-dj');
    expect(canonicalSoundCloudUrl('https://on.soundcloud.com/AbCd1234?si=x')).toBe('https://on.soundcloud.com/AbCd1234');
    expect(canonicalSoundCloudUrl('')).toBe('');
  });

  test('stripping the canonical form leaves no token and no tracking', () => {
    expect(stripSecretToken(canonicalSoundCloudUrl(SHARED))).toBe('https://soundcloud.com/dj-x/sets/late-mix');
  });

  test('redact hides a token in a query or a path, and nothing else', () => {
    expect(redactSecretToken('/playlists/5?show_tracks=true&secret_token=s-AbC123&access=x'))
      .toBe('/playlists/5?show_tracks=true&secret_token=[redacted]&access=x');
    expect(redactSecretToken('https://soundcloud.com/u/sets/m/s-AbC123?x=1')).toBe('https://soundcloud.com/u/sets/m/s-[redacted]?x=1');
    expect(redactSecretToken('/playlists/5?show_tracks=true')).toBe('/playlists/5?show_tracks=true');
  });
});
