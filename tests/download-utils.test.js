import {
  downloadTrackIdFromUrl,
  isAllowedDownloadRedirectTarget,
  isAllowedDownloadUrl,
} from '../server/lib/download-utils.js';

describe('download URL safety helpers', () => {
  test('accepts SoundCloud API track download URLs only', () => {
    expect(isAllowedDownloadUrl('https://api.soundcloud.com/tracks/123/download')).toBe(true);
    expect(isAllowedDownloadUrl('https://api.soundcloud.com/tracks/123/download?client_id=x')).toBe(true);
    expect(isAllowedDownloadUrl('https://foo.soundcloud.com/tracks/123/download')).toBe(false);
    expect(isAllowedDownloadUrl('https://soundcloud.com/artist/track')).toBe(false);
    expect(isAllowedDownloadUrl('https://api.soundcloud.com/playlists/123/download')).toBe(false);
    expect(isAllowedDownloadUrl('http://api.soundcloud.com/tracks/123/download')).toBe(false);
    expect(isAllowedDownloadUrl('')).toBe(false);
    expect(isAllowedDownloadUrl(null)).toBe(false);
    expect(isAllowedDownloadUrl(123)).toBe(false);
    expect(isAllowedDownloadUrl('::bad::')).toBe(false);
    expect(isAllowedDownloadUrl('https://api.soundcloud.com/tracks/123/download/')).toBe(false);
  });

  // Every downloadable track in production carried this shape when the
  // numeric-only check was found rejecting all of them (2026-10-07).
  test('accepts the URN form SoundCloud actually serves', () => {
    const urn = 'https://api.soundcloud.com/tracks/soundcloud:tracks:1897670478/download';
    expect(isAllowedDownloadUrl(urn)).toBe(true);
    expect(isAllowedDownloadUrl(`${urn}?secret_token=s-abc`)).toBe(true);
    expect(isAllowedDownloadUrl('https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A1897670478/download')).toBe(true);
  });

  test('the URN form does not loosen anything else', () => {
    expect(isAllowedDownloadUrl('https://api.soundcloud.com/tracks/soundcloud:playlists:1/download')).toBe(false);
    expect(isAllowedDownloadUrl('https://api.soundcloud.com/tracks/soundcloud:users:1/download')).toBe(false);
    expect(isAllowedDownloadUrl('https://api.soundcloud.com/tracks/soundcloud:tracks:/download')).toBe(false);
    expect(isAllowedDownloadUrl('https://api.soundcloud.com/tracks/soundcloud:tracks:12/streams')).toBe(false);
    expect(isAllowedDownloadUrl('https://api.soundcloud.com/tracks/soundcloud:tracks:12/../streams/download')).toBe(false);
    expect(isAllowedDownloadUrl('https://api.soundcloud.com/tracks/x:soundcloud:tracks:12/download')).toBe(false);
    expect(isAllowedDownloadUrl('https://evil.example/tracks/soundcloud:tracks:12/download')).toBe(false);
  });

  test('extracts the numeric track id from either shape', () => {
    expect(downloadTrackIdFromUrl('https://api.soundcloud.com/tracks/123/download')).toBe(123);
    expect(downloadTrackIdFromUrl('https://api.soundcloud.com/tracks/soundcloud:tracks:1897670478/download')).toBe(1897670478);
    expect(downloadTrackIdFromUrl('https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A77/download?x=1')).toBe(77);
    expect(downloadTrackIdFromUrl('https://api.soundcloud.com/playlists/1/download')).toBe(null);
    expect(downloadTrackIdFromUrl(null)).toBe(null);
  });

  test('allows CDN redirects but rejects SoundCloud error-page redirects', () => {
    expect(isAllowedDownloadRedirectTarget('https://download-media.sndcdn.com/file.mp3')).toBe(true);
    expect(isAllowedDownloadRedirectTarget('https://d1.cloudfront.net/file.mp3')).toBe(true);
    expect(isAllowedDownloadRedirectTarget('https://soundcloud.com/error?code=download')).toBe(false);
    expect(isAllowedDownloadRedirectTarget('https://evil.example/file.mp3')).toBe(false);
    expect(isAllowedDownloadRedirectTarget('')).toBe(false);
    expect(isAllowedDownloadRedirectTarget(null)).toBe(false);
    expect(isAllowedDownloadRedirectTarget(123)).toBe(false);
    expect(isAllowedDownloadRedirectTarget('::bad::')).toBe(false);
  });
});
