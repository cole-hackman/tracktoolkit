import express from 'express';
import request from 'supertest';
import http from 'http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

import { mountStaticSite } from '../../server/lib/static-site.js';

let buildPath;
let app;

/**
 * A raw GET against a listening server, bypassing supertest/superagent's
 * own URL-resolution step — which (per the WHATWG URL spec's "remove
 * dot segments" pass) collapses BOTH `/../x` and `/%2e%2e/x` down to
 * `/x` before the request ever leaves the client. That makes
 * `request(app).get('/../package.json')` useless for testing the
 * traversal guard: the path Express actually sees is already harmless.
 * A raw `http.request({ path })` call sends the given bytes verbatim, the
 * way a client that doesn't normalize dot segments (curl --path-as-is,
 * a hand-rolled socket, plenty of libraries) would.
 */
function rawGet(server, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, location: res.headers.location }));
    });
    req.on('error', reject);
    req.end();
  });
}

// A file just outside buildPath — stands in for anything an attacker might
// want to read off disk (source, .env, etc.). Its content must never appear
// in a response.
let outsideFile;
let server;

beforeAll(async () => {
  buildPath = mkdtempSync(join(tmpdir(), 'static-site-test-'));
  writeFileSync(join(buildPath, 'index.html'), '<html><body>home</body></html>');
  mkdirSync(join(buildPath, 'about'));
  writeFileSync(join(buildPath, 'about', 'index.html'), '<html><body>about page</body></html>');
  writeFileSync(join(buildPath, '404.html'), '<html><body>not found</body></html>');
  mkdirSync(join(buildPath, '404'));
  writeFileSync(join(buildPath, '404', 'index.html'), '<html><body>not found</body></html>');

  outsideFile = join(dirname(buildPath), 'package.json');
  writeFileSync(outsideFile, 'SENTINEL_SHOULD_NEVER_BE_SERVED');

  app = express();
  mountStaticSite(app, buildPath, {
    aliases: {
      '/sc-toolkit': '/faq/#rebrand',
      '/soundcloud-toolkit': '/faq/#rebrand',
      '/rebrand': '/faq/#rebrand',
    },
  });
  // Registered after mountStaticSite, like server/index.js's real 404 API
  // handler and /health route — proves the static middleware passes these
  // through instead of swallowing them.
  app.get('/api/x', (req, res) => res.json({ ok: true }));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
});

afterAll(async () => {
  rmSync(buildPath, { recursive: true, force: true });
  rmSync(outsideFile, { force: true });
  await new Promise((resolve) => server.close(resolve));
});

describe('mountStaticSite', () => {
  test('serves a route directory\'s index.html with 200', async () => {
    const res = await request(app).get('/about/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('about page');
  });

  test('serves out/404.html with a real 404 status for an unknown path', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.text).toContain('not found');
  });

  test('301s /sc-toolkit to /faq/#rebrand', async () => {
    const res = await request(app).get('/sc-toolkit');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/faq/#rebrand');
  });

  test('301s /sc-toolkit/ (trailing slash normalized) to /faq/#rebrand', async () => {
    const res = await request(app).get('/sc-toolkit/');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/faq/#rebrand');
  });

  test('leaves /api/* paths to a handler mounted after it', async () => {
    const res = await request(app).get('/api/x');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('leaves /health untouched', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('mountStaticSite directory traversal guard', () => {
  test('rejects a raw ".." segment: 404, never the file outside buildPath', async () => {
    const res = await rawGet(server, '/../package.json');
    expect(res.status).toBe(404);
    expect(res.body).toContain('not found');
    expect(res.body).not.toContain('SENTINEL_SHOULD_NEVER_BE_SERVED');
  });

  test('rejects a percent-encoded ".." segment: 404, never the file outside buildPath', async () => {
    const res = await rawGet(server, '/%2e%2e/package.json');
    expect(res.status).toBe(404);
    expect(res.body).toContain('not found');
    expect(res.body).not.toContain('SENTINEL_SHOULD_NEVER_BE_SERVED');
  });

  test('a normal nested path still resolves (guard is not overbroad)', async () => {
    const res = await rawGet(server, '/about/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('about page');
  });

  test('malformed percent-encoding is a 400, not a 404 or a crash', async () => {
    const res = await rawGet(server, '/%');
    expect(res.status).toBe(400);
  });
});

describe('mountStaticSite gives each page one URL', () => {
  test.each(['/404.html', '/404', '/404/', '/404/index.html'])(
    'a direct request for the 404 page (%s) is itself a 404',
    async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.text).toContain('not found');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  );

  test.each([
    ['/index.html', '/'],
    ['/about/index.html', '/about/'],
    ['/about/index.html?ref=x', '/about/?ref=x'],
  ])('%s 301s to %s', async (path, location) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe(location);
  });

  test('the route itself is still served', async () => {
    const res = await request(app).get('/about/');
    expect(res.status).toBe(200);
  });
});

describe('mountStaticSite never redirects off-site', () => {
  // A Location of `//evil.example/` is protocol-relative, and browsers read
  // `/\\evil.example/` the same way. Raw requests, because supertest would
  // normalize the path before sending it.
  test.each(['//evil.example/index.html', '/\\evil.example/index.html'])(
    '%s stays on this site',
    async (path) => {
      const res = await rawGet(server, path);
      expect(res.status).toBe(301);
      expect(res.location).toBe('/evil.example/');
    }
  );

  test('an RSC payload navigation stays on this site', async () => {
    const res = await rawGet(server, '//evil.example/index.txt', { 'Sec-Fetch-Dest': 'document' });
    expect(res.status).toBe(302);
    expect(res.location).toBe('/evil.example/');
  });
});
