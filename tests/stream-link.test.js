import { isAllowedStreamUrl } from '../server/lib/download-utils.js';

// The token is sent only to api.soundcloud.com stream paths; anything else
// SoundCloud might hand back is either a CDN link (returned as is) or refused.
describe('isAllowedStreamUrl', () => {
  test.each([
    'https://api.soundcloud.com/tracks/123/stream',
    'https://api.soundcloud.com/tracks/123/streams/http_mp3_128_url',
    'https://api.soundcloud.com/tracks/soundcloud:tracks:123/streams/hls',
    'https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A123/stream',
  ])('accepts %s', (url) => expect(isAllowedStreamUrl(url)).toBe(true));

  test.each([
    'http://api.soundcloud.com/tracks/123/stream',
    'https://evil.example.com/tracks/123/stream',
    'https://api.soundcloud.com.evil.example/tracks/123/stream',
    'https://api.soundcloud.com/me',
    'https://api.soundcloud.com/tracks/123/download',
    'https://api.soundcloud.com/tracks/123/streams/../../me',
    '',
    null,
  ])('refuses %s', (url) => expect(isAllowedStreamUrl(url)).toBe(false));
});
