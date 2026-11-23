import { jest } from '@jest/globals';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

/**
 * Adversarial inputs for the post-login redirect (C4). Whatever the Origin,
 * Referer, app_url cookie or post_login_path cookie says, the Location the
 * callback sends must stay on APP_URL or an exact APP_URLS origin.
 * safeAppOrigin reads the environment on every call, so each test sets
 * APP_URL / APP_URLS itself.
 */

process.env.ENCRYPTION_KEY ||= 'x'.repeat(32);
process.env.SESSION_SECRET ||= 's'.repeat(40);

const exchangeCodeForTokens = jest.fn();
const getMe = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
  default: {
    user: { upsert: jest.fn().mockResolvedValue({ id: 'u1', soundcloudId: 1, username: 'dj' }) },
    token: { upsert: jest.fn().mockResolvedValue({}) },
  },
}));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: { exchangeCodeForTokens, getMe },
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
  signOut: jest.fn(async () => true),
  forgetRecentRotation: jest.fn(),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation: jest.fn(),
  startOperationTimer: () => () => 0,
  extractClientInfo: () => ({}),
  getAnalyticsWriteHealth: jest.fn(),
}));

const { default: authRoutes } = await import('../../server/routes/auth.js');

const app = express();
app.use(cookieParser());
app.use('/api/auth', authRoutes);
// One server bound to 127.0.0.1 for the whole file. request(server) opens a fresh
// ephemeral port per request on all interfaces, and with a hundred-plus
// requests one occasionally lands on a port another local process holds on
// 127.0.0.1, which answers 404.
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
afterAll(() => new Promise((r) => server.close(r)));

const ORIGINAL = { APP_URL: process.env.APP_URL, APP_URLS: process.env.APP_URLS };
const APP = 'https://tracktoolkit.example';
const DEV = 'http://localhost:5173';

beforeEach(() => {
  process.env.APP_URL = APP;
  process.env.APP_URLS = `${APP}, ${DEV}/`;
  exchangeCodeForTokens.mockReset().mockResolvedValue({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
  getMe.mockReset().mockResolvedValue({ id: 1, username: 'dj' });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function appUrlCookie(res) {
  const c = (res.headers['set-cookie'] || []).find((x) => x.startsWith('app_url='));
  return c ? decodeURIComponent(c.split(';')[0].slice('app_url='.length)) : undefined;
}

function cookieHeader(appUrl, extra = []) {
  return [`app_url=${encodeURIComponent(appUrl)}`, ...extra];
}

async function callbackLocation(appUrl, { branch = 'error', postLoginPath } = {}) {
  const extra = [];
  if (postLoginPath !== undefined) extra.push(`post_login_path=${encodeURIComponent(postLoginPath)}`);
  let req;
  if (branch === 'error') req = request(server).get('/api/auth/callback?error=access_denied');
  else if (branch === 'missing') req = request(server).get('/api/auth/callback?code=c');
  else {
    extra.push('pkce_verifier=v');
    if (branch === 'throw') exchangeCodeForTokens.mockRejectedValueOnce(new Error('boom'));
    req = request(server).get('/api/auth/callback?code=c');
  }
  const res = await req.set('Cookie', cookieHeader(appUrl, extra));
  expect(res.status).toBe(302);
  return res.headers.location;
}

const HOSTILE_ORIGINS = [
  ['different scheme of an allowlisted host', 'http://tracktoolkit.example'],
  ['allowlisted host on another port', 'https://tracktoolkit.example:8443'],
  ['userinfo trick', 'https://tracktoolkit.example@evil.example'],
  ['userinfo trick with dev host', 'http://localhost:5173@evil.example'],
  ['suffix look-alike', 'https://tracktoolkit.example.evil.example'],
  ['prefix look-alike', 'https://eviltracktoolkit.example'],
  ['the literal string null', 'null'],
  ['javascript: URL', 'javascript:alert(1)//tracktoolkit.example'],
  ['data: URL', 'data:text/html,<script>alert(1)</script>'],
  ['protocol-relative', '//evil.example'],
  ['backslash authority', 'https:\\\\evil.example'],
  ['scheme-less host', 'evil.example'],
  ['two origins in one value', 'https://tracktoolkit.example https://evil.example'],
  ['file URL', 'file:///etc/passwd'],
  ['empty', ''],
];

describe('callback: hostile app_url cookies always land on APP_URL', () => {
  for (const branch of ['error', 'missing', 'success', 'throw']) {
    test.each(HOSTILE_ORIGINS)(`[${branch}] %s`, async (_label, value) => {
      const loc = await callbackLocation(value, { branch });
      expect(new URL(loc).origin).toBe(APP);
    });
  }
});

describe('/login: hostile Origin / Referer headers store APP_URL', () => {
  test.each(HOSTILE_ORIGINS.filter(([, v]) => v))('Origin: %s', async (_label, value) => {
    const res = await request(server).get('/api/auth/login').set('Origin', value);
    expect(appUrlCookie(res)).toBe(APP);
  });

  test('a disallowed Origin is not rescued by an allowlisted Referer, and vice versa stays safe', async () => {
    const res = await request(server).get('/api/auth/login')
      .set('Origin', 'https://evil.example').set('Referer', `${DEV}/x`);
    expect(appUrlCookie(res)).toBe(APP);
  });
});

describe('allowlist normalisation', () => {
  test('uppercase scheme/host of an allowlisted origin is accepted as the canonical origin', async () => {
    const loc = await callbackLocation('HTTPS://TRACKTOOLKIT.EXAMPLE');
    expect(loc).toBe(`${APP}/login?error=access_denied`);
  });

  test('the default port written explicitly is the same origin', async () => {
    const loc = await callbackLocation('https://tracktoolkit.example:443/');
    expect(loc).toBe(`${APP}/login?error=access_denied`);
  });

  test('an APP_URLS entry with a trailing slash still matches', async () => {
    const loc = await callbackLocation(`${DEV}/anything`);
    expect(loc).toBe(`${DEV}/login?error=access_denied`);
  });

  test('an APP_URLS entry with a port does not admit the same host without it', async () => {
    process.env.APP_URLS = 'https://staging.example:8443';
    expect(new URL(await callbackLocation('https://staging.example:8443')).origin).toBe('https://staging.example:8443');
    expect(new URL(await callbackLocation('https://staging.example')).origin).toBe(APP);
  });

  test('an http APP_URLS entry does not admit https of the same host (and vice versa)', async () => {
    process.env.APP_URLS = 'http://mixed.example';
    expect(new URL(await callbackLocation('https://mixed.example')).origin).toBe(APP);
    expect(new URL(await callbackLocation('http://mixed.example')).origin).toBe('http://mixed.example');
  });

  test('empty APP_URLS: only APP_URL is allowed', async () => {
    process.env.APP_URLS = '';
    expect(new URL(await callbackLocation(DEV)).origin).toBe(APP);
    expect(new URL(await callbackLocation(APP)).origin).toBe(APP);
  });

  test('unset APP_URLS: only APP_URL is allowed', async () => {
    delete process.env.APP_URLS;
    expect(new URL(await callbackLocation(DEV)).origin).toBe(APP);
  });

  test('junk entries in APP_URLS (blank, unparseable, null-origin) admit nothing extra', async () => {
    process.env.APP_URLS = ' , not a url, javascript:alert(1), data:text/plain,x, ,';
    for (const v of ['null', 'javascript:alert(1)', 'data:text/plain,x', 'not a url']) {
      expect(new URL(await callbackLocation(v)).origin).toBe(APP);
    }
  });

  test('APP_URL with a trailing slash does not produce a double slash', async () => {
    process.env.APP_URL = `${APP}/`;
    const loc = await callbackLocation('https://evil.example', { branch: 'success' });
    expect(loc).toBe(`${APP}/dashboard`);
  });
});

describe('post_login_path cookie cannot move the redirect off-origin', () => {
  const HOSTILE_PATHS = [
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    '/\\/evil.example',
    '/%5Cevil.example',
    '/%2F%2Fevil.example',
    '/\t/evil.example',
    '/@evil.example',
    'https://evil.example',
    '/../../evil',
    '/' + 'a'.repeat(300),
    ' //evil.example',
  ];

  test.each(HOSTILE_PATHS)('%j stays on the allowlisted origin', async (p) => {
    const loc = await callbackLocation(DEV, { branch: 'success', postLoginPath: p });
    expect(new URL(loc).origin).toBe(DEV);
  });

  test.each(['//evil.example', '/\\evil.example', '/\\/evil.example', 'https://evil.example', '/../x'])(
    '%j is refused outright and falls back to /dashboard', async (p) => {
      const loc = await callbackLocation(DEV, { branch: 'success', postLoginPath: p });
      expect(loc).toBe(`${DEV}/dashboard`);
    },
  );

  test('a normal path is kept', async () => {
    const loc = await callbackLocation(DEV, { branch: 'success', postLoginPath: '/downloads?tab=queue' });
    expect(loc).toBe(`${DEV}/downloads?tab=queue`);
  });

  test.each(['/\\evil.example', '/%5C', '//x', '/a/../b'])('/login refuses redirect_path %j', async (p) => {
    const res = await request(server).get('/api/auth/login?redirect_path=' + encodeURIComponent(p));
    const cookies = res.headers['set-cookie'] || [];
    const stored = cookies.find((c) => c.startsWith('post_login_path='));
    if (p === '/%5C') {
      // An encoded backslash is a literal path segment, not a separator: harmless,
      // and the callback prefixes the allowlisted origin anyway.
      expect(stored).toBeDefined();
    } else {
      expect(stored).toBeUndefined();
    }
  });
});
