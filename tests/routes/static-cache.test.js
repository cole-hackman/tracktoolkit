import express from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { mountStaticSite } from '../../server/lib/static-site.js';

/**
 * Route HTML and RSC payloads keep their names across deploys while naming
 * that deploy's hashed chunks. Served with a day of max-age, a browser that
 * visited before a deploy mixed its stale `/dashboard/index.txt` with the new
 * chunks after it, and the client router crashed into a hard navigation to the
 * raw payload. These must revalidate; the hashed chunks must not need to.
 */

let buildPath;
let app;

beforeAll(() => {
  buildPath = mkdtempSync(join(tmpdir(), 'static-cache-test-'));
  writeFileSync(join(buildPath, 'index.html'), '<html>home</html>');
  writeFileSync(join(buildPath, 'index.txt'), 'rsc home');
  writeFileSync(join(buildPath, '404.html'), '<html>not found</html>');
  writeFileSync(join(buildPath, 'robots.txt'), 'User-agent: *');
  writeFileSync(join(buildPath, 'manifest.json'), '{}');
  writeFileSync(join(buildPath, 'legal.html'), '<html>legal</html>');
  mkdirSync(join(buildPath, 'dashboard'));
  writeFileSync(join(buildPath, 'dashboard', 'index.html'), '<html>dashboard</html>');
  writeFileSync(join(buildPath, 'dashboard', 'index.txt'), 'rsc dashboard');
  mkdirSync(join(buildPath, '_next', 'static', 'chunks'), { recursive: true });
  writeFileSync(join(buildPath, '_next', 'static', 'chunks', 'webpack-abc123.js'), '/* chunk */');

  app = express();
  mountStaticSite(app, buildPath);
});

afterAll(() => {
  rmSync(buildPath, { recursive: true, force: true });
});

describe('static export cache headers', () => {
  it.each([
    ['/', 'route HTML via express.static directory index'],
    ['/dashboard/', 'route HTML via express.static directory index'],
    ['/legal', 'route HTML via the <path>.html lookup'],
    ['/dashboard/index.txt', 'RSC payload'],
    ['/dashboard/index.txt?_rsc=abc123', 'RSC payload as the client router requests it'],
    ['/index.txt', 'root RSC payload'],
  ])('%s (%s) revalidates on every use', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers.etag).toBeTruthy();
  });

  it('the 404 page is not cached for a day either', async () => {
    const res = await request(app).get('/no-such-page/');
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('hashed build output under /_next/static/ is immutable', async () => {
    const res = await request(app).get('/_next/static/chunks/webpack-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('a revalidation with a matching ETag is a 304, not a re-download', async () => {
    const first = await request(app).get('/dashboard/index.txt');
    const second = await request(app)
      .get('/dashboard/index.txt')
      .set('If-None-Match', first.headers.etag);
    expect(second.status).toBe(304);
  });

  it('other unhashed files keep the one-day default', async () => {
    const res = await request(app).get('/manifest.json');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
  });

  it('robots.txt revalidates like any other .txt', async () => {
    const res = await request(app).get('/robots.txt');
    expect(res.headers['cache-control']).toBe('no-cache');
  });
});
