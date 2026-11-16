import express from 'express';
import request from 'supertest';
import { securityHeaders, isSortLikesPagePath, SORT_LIKES_MEDIA_SRC } from '../../server/middleware/security.js';

// Sort Likes previews tracks with SoundCloud's embed player (frame-src) and
// with our own <audio> element on SoundCloud's stream CDNs (media-src). Both
// allowances belong to the /sort-likes document only.

const app = express();
app.use(securityHeaders);
app.get('*', (req, res) => res.send('ok'));

function directive(res, name) {
  const csp = res.headers['content-security-policy'] || '';
  const found = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `) || d === name);
  return found ? found.slice(name.length).trim() : null;
}

describe('CSP for the Sort Likes document', () => {
  test('frames only the SoundCloud player and plays only from SoundCloud CDNs', async () => {
    expect(SORT_LIKES_MEDIA_SRC).toEqual(["'self'", 'https://*.sndcdn.com', 'https://*.cloudfront.net', 'blob:']);
    for (const path of ['/sort-likes', '/sort-likes/', '/sort-likes/index.html']) {
      const res = await request(app).get(path);
      expect(directive(res, 'frame-src')).toBe('https://w.soundcloud.com');
      expect(directive(res, 'media-src')).toBe("'self' https://*.sndcdn.com https://*.cloudfront.net blob:");
    }
  });

  test('every other page and the API keep frame-src none and media-src self', async () => {
    for (const path of ['/', '/likes-to-playlist/', '/sort-likesx/', '/api/tracks/1/stream']) {
      const res = await request(app).get(path);
      expect(directive(res, 'frame-src')).toBe("'none'");
      expect(directive(res, 'media-src')).toBe("'self'");
    }
  });

  test('only frame-src and media-src differ from the base policy', async () => {
    const strip = (csp) => csp.split(';').map((d) => d.trim()).filter((d) => !d.startsWith('frame-src') && !d.startsWith('media-src')).sort();
    const sort = await request(app).get('/sort-likes/');
    const home = await request(app).get('/');
    expect(strip(sort.headers['content-security-policy'])).toEqual(strip(home.headers['content-security-policy']));
  });

  test('isSortLikesPagePath matches the document path only', () => {
    expect(isSortLikesPagePath('/sort-likes')).toBe(true);
    expect(isSortLikesPagePath('/sort-likes/')).toBe(true);
    expect(isSortLikesPagePath('/sort-likesx')).toBe(false);
    expect(isSortLikesPagePath('/api/sort/apply')).toBe(false);
  });
});
