import express from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { mountStaticSite } from '../../server/lib/static-site.js';

/**
 * When the App Router cannot use an RSC payload (a stale cached copy from
 * another deploy, a deploy race, a network error) it falls back to a hard
 * navigation — to the payload URL itself, `/dashboard/index.txt`, not the
 * route. Served as-is, that lands the user on raw RSC text. A top-level
 * navigation to `<route>/index.txt` is never what anyone wants, so it goes
 * to the route; the router's own fetches of the same file are untouched.
 */

let buildPath;
let app;

beforeAll(() => {
  buildPath = mkdtempSync(join(tmpdir(), 'rsc-fallback-test-'));
  writeFileSync(join(buildPath, 'index.html'), '<html>home</html>');
  writeFileSync(join(buildPath, 'index.txt'), 'rsc home');
  writeFileSync(join(buildPath, 'robots.txt'), 'User-agent: *');
  writeFileSync(join(buildPath, '404.html'), '<html>not found</html>');
  mkdirSync(join(buildPath, 'dashboard'));
  writeFileSync(join(buildPath, 'dashboard', 'index.html'), '<html>dashboard</html>');
  writeFileSync(join(buildPath, 'dashboard', 'index.txt'), 'rsc dashboard');

  app = express();
  mountStaticSite(app, buildPath);
});

afterAll(() => {
  rmSync(buildPath, { recursive: true, force: true });
});

const NAVIGATION = { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
const RSC_FETCH = { RSC: '1', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', Accept: '*/*' };

describe('a page navigation to an RSC payload goes to its route', () => {
  it.each([
    ['/dashboard/index.txt', '/dashboard/'],
    ['/dashboard/index.txt?_rsc=abc123', '/dashboard/'],
    ['/dashboard/index.txt?_rsc=abc123&tab=likes', '/dashboard/?tab=likes'],
    ['/index.txt', '/'],
  ])('%s -> %s', async (path, location) => {
    const res = await request(app).get(path).set(NAVIGATION);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(location);
  });

  it('recognises a navigation by Accept when Sec-Fetch-* is absent', async () => {
    const res = await request(app).get('/dashboard/index.txt').set('Accept', 'text/html,*/*;q=0.8');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard/');
  });
});

describe('everything else still gets the payload', () => {
  it('the client router fetch (RSC: 1) gets the payload', async () => {
    const res = await request(app).get('/dashboard/index.txt?_rsc=abc123').set(RSC_FETCH);
    expect(res.status).toBe(200);
    expect(res.text).toBe('rsc dashboard');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('an RSC request is never redirected, even with an HTML Accept', async () => {
    const res = await request(app).get('/dashboard/index.txt').set({ RSC: '1', Accept: 'text/html' });
    expect(res.status).toBe(200);
  });

  it('a plain fetch with no navigation signals (curl, prefetch) gets the payload', async () => {
    const res = await request(app).get('/dashboard/index.txt');
    expect(res.status).toBe(200);
    expect(res.text).toBe('rsc dashboard');
  });

  it('other .txt files are served even as a navigation', async () => {
    const res = await request(app).get('/robots.txt').set(NAVIGATION);
    expect(res.status).toBe(200);
    expect(res.text).toBe('User-agent: *');
  });
});
