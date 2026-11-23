import { jest } from '@jest/globals';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

process.env.ENCRYPTION_KEY ||= 'x'.repeat(32);
process.env.SESSION_SECRET ||= 's'.repeat(40);
process.env.APP_URL ||= 'https://www.soundcloudtoolkit.com';
// The `app_url` cookie may only ever name one of these origins (or APP_URL).
// The second entry exercises the trim and the trailing-slash normalisation.
process.env.APP_URLS = 'https://app.example.com, http://localhost:5173/';

const userUpsert = jest.fn().mockResolvedValue({
  id: 'user-1',
  soundcloudId: 555,
  username: 'dj',
  displayName: 'DJ',
  avatarUrl: 'https://cdn/a.jpg',
});
const tokenUpsert = jest.fn().mockResolvedValue({});
const exchangeCodeForTokens = jest.fn();
const getMe = jest.fn();

jest.unstable_mockModule('../../server/lib/prisma.js', () => ({
  default: { user: { upsert: userUpsert }, token: { upsert: tokenUpsert } },
}));
jest.unstable_mockModule('../../server/lib/soundcloud-client.js', () => ({
  soundcloudClient: { exchangeCodeForTokens, getMe },
  // routes/api.js imports this alongside soundcloudClient for the oEmbed
  // supplement; the mock must provide it or the module fails to link.
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 503 })),
  // routes/auth.js imports signOut for the disconnect/delete paths.
  signOut: jest.fn(async () => true),
  // account-lifecycle.js drops the rotation memo alongside the auth memo.
  forgetRecentRotation: jest.fn(),
}));
jest.unstable_mockModule('../../server/lib/analytics.js', () => ({
  logOperation: jest.fn(),
  startOperationTimer: () => () => 0,
  extractClientInfo: () => ({}),
  getAnalyticsWriteHealth: jest.fn(),
}));

const { default: authRoutes } = await import('../../server/routes/auth.js');
const { unsignSession, parseSessionData } = await import('../../server/lib/session.js');

const app = express();
app.use(cookieParser());
app.use('/api/auth', authRoutes);

beforeEach(() => {
  userUpsert.mockClear();
  tokenUpsert.mockClear();
  exchangeCodeForTokens.mockClear().mockResolvedValue({
    access_token: 'at', refresh_token: 'rt', expires_in: 3600,
  });
  getMe.mockClear().mockResolvedValue({
    id: 555, username: 'dj', display_name: 'DJ', avatar_url: 'https://cdn/a.jpg',
  });
});

describe('OAuth callback — happy path', () => {
  test('upserts the user, stores encrypted tokens, and sets a valid signed session cookie', async () => {
    const res = await request(app)
      .get('/api/auth/callback?code=abc123')
      .set('Cookie', ['pkce_verifier=verifier-value', 'app_url=https://app.example.com']);

    expect(res.status).toBe(302);
    expect(exchangeCodeForTokens).toHaveBeenCalledWith('abc123', 'verifier-value');

    // user upserted by soundcloudId, not by any client-supplied value
    expect(userUpsert).toHaveBeenCalledTimes(1);
    expect(userUpsert.mock.calls[0][0].where).toEqual({ soundcloudId: 555 });

    // tokens persisted, and NOT in plaintext
    expect(tokenUpsert).toHaveBeenCalledTimes(1);
    const tokenData = tokenUpsert.mock.calls[0][0].create;
    expect(tokenData.encrypted).not.toBe('at');
    expect(tokenData.refresh).not.toBe('rt');

    // session cookie is signed and carries iat
    const setCookie = res.headers['set-cookie'].find((c) => c.startsWith('session='));
    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(/HttpOnly/i);
    const raw = decodeURIComponent(setCookie.split(';')[0].slice('session='.length));
    const payload = parseSessionData(unsignSession(raw, process.env.SESSION_SECRET));
    expect(payload).toMatchObject({ userId: 'user-1', soundcloudId: 555 });
    expect(typeof payload.iat).toBe('number');
  });

  test('stamps lastLoginAt and clears disconnectedAt on both branches of the upsert', async () => {
    await request(app)
      .get('/api/auth/callback?code=abc123')
      .set('Cookie', ['pkce_verifier=verifier-value', 'app_url=https://app.example.com']);

    const { create, update } = userUpsert.mock.calls[0][0];

    // Returning after a disconnect must un-disconnect the account, or the
    // retention job would delete a user who just logged back in.
    expect(update.lastLoginAt).toBeInstanceOf(Date);
    expect(update.disconnectedAt).toBeNull();

    expect(create.lastLoginAt).toBeInstanceOf(Date);
    expect(create.disconnectedAt).toBeNull();
  });
});

describe('OAuth callback — failure paths never create a session', () => {
  test('a provider error redirects to /login with the error and sets no session', async () => {
    const res = await request(app)
      .get('/api/auth/callback?error=access_denied')
      .set('Cookie', ['app_url=https://app.example.com']);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://app.example.com/login?error=access_denied');
    expect(userUpsert).not.toHaveBeenCalled();
    const cookies = res.headers['set-cookie'] || [];
    expect(cookies.some((c) => c.startsWith('session='))).toBe(false);
  });

  test('a missing PKCE verifier cookie cannot complete the exchange', async () => {
    const res = await request(app)
      .get('/api/auth/callback?code=abc123')
      .set('Cookie', ['app_url=https://app.example.com']);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      'https://app.example.com/login?error=missing_code_or_verifier'
    );
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(userUpsert).not.toHaveBeenCalled();
  });

  test('a missing code cannot complete the exchange', async () => {
    const res = await request(app)
      .get('/api/auth/callback')
      .set('Cookie', ['pkce_verifier=verifier-value', 'app_url=https://app.example.com']);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      'https://app.example.com/login?error=missing_code_or_verifier'
    );
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
  });
});

describe('OAuth login — PKCE challenge', () => {
  test('sets an httpOnly pkce_verifier cookie and redirects with an S256 challenge', async () => {
    const res = await request(app)
      .get('/api/auth/login')
      .set('Origin', 'https://app.example.com');

    expect(res.status).toBe(302);
    const cookies = res.headers['set-cookie'];
    const pkce = cookies.find((c) => c.startsWith('pkce_verifier='));
    expect(pkce).toMatch(/HttpOnly/i);

    const target = new URL(res.headers.location);
    expect(target.origin).toBe('https://secure.soundcloud.com');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('code_challenge')).toBeTruthy();
    // the challenge is a hash, never the verifier itself
    const verifier = decodeURIComponent(pkce.split(';')[0].slice('pkce_verifier='.length));
    expect(target.searchParams.get('code_challenge')).not.toBe(verifier);
  });
});

describe('OAuth redirect target — only allowlisted origins (open-redirect guard)', () => {
  const APP_URL = () => process.env.APP_URL.replace(/\/+$/, '');

  function appUrlCookie(res) {
    const c = (res.headers['set-cookie'] || []).find((x) => x.startsWith('app_url='));
    return c ? decodeURIComponent(c.split(';')[0].slice('app_url='.length)) : undefined;
  }

  test('/login with a cross-site Referer stores APP_URL, not the attacker origin', async () => {
    const res = await request(app)
      .get('/api/auth/login')
      .set('Referer', 'https://evil.example/phish');

    expect(res.status).toBe(302);
    expect(appUrlCookie(res)).toBe(APP_URL());
  });

  test('/login with a cross-site Origin stores APP_URL', async () => {
    const res = await request(app)
      .get('/api/auth/login')
      .set('Origin', 'https://evil.example');
    expect(appUrlCookie(res)).toBe(APP_URL());
  });

  test('/login with a look-alike Origin (allowlisted host as a prefix) stores APP_URL', async () => {
    const res = await request(app)
      .get('/api/auth/login')
      .set('Origin', 'https://app.example.com.evil.example');
    expect(appUrlCookie(res)).toBe(APP_URL());
  });

  test('/login keeps an allowlisted origin (the dev-port case the cookie exists for)', async () => {
    const res = await request(app)
      .get('/api/auth/login')
      .set('Referer', 'http://localhost:5173/login');
    expect(appUrlCookie(res)).toBe('http://localhost:5173');
  });

  test('/login with an unparseable Origin stores APP_URL', async () => {
    const res = await request(app).get('/api/auth/login').set('Origin', 'null');
    expect(appUrlCookie(res)).toBe(APP_URL());
  });

  test('a forged app_url cookie on a successful callback lands on APP_URL', async () => {
    const res = await request(app)
      .get('/api/auth/callback?code=abc123')
      .set('Cookie', ['pkce_verifier=verifier-value', 'app_url=https://evil.example']);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_URL()}/dashboard`);
  });

  test('a forged app_url cookie on the ?error= branch lands on APP_URL', async () => {
    const res = await request(app)
      .get('/api/auth/callback?error=access_denied')
      .set('Cookie', ['app_url=https://evil.example']);

    expect(res.headers.location).toBe(`${APP_URL()}/login?error=access_denied`);
  });

  test('a forged app_url cookie on the missing-verifier branch lands on APP_URL', async () => {
    const res = await request(app)
      .get('/api/auth/callback?code=abc123')
      .set('Cookie', ['app_url=//evil.example']);

    expect(res.headers.location).toBe(`${APP_URL()}/login?error=missing_code_or_verifier`);
  });

  test('a forged app_url cookie on the exception branch lands on APP_URL', async () => {
    exchangeCodeForTokens.mockRejectedValueOnce(new Error('upstream down'));
    const res = await request(app)
      .get('/api/auth/callback?code=abc123')
      .set('Cookie', ['pkce_verifier=verifier-value', 'app_url=https://evil.example']);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_URL()}/login?error=callback_failed`);
  });

  test('an app_url cookie carrying a path keeps only the allowlisted origin', async () => {
    const res = await request(app)
      .get('/api/auth/callback?error=access_denied')
      .set('Cookie', ['app_url=https://app.example.com/x']);
    expect(res.headers.location).toBe('https://app.example.com/login?error=access_denied');
  });

  test('a post_login_path with a backslash falls back to /dashboard', async () => {
    const res = await request(app)
      .get('/api/auth/callback?code=abc123')
      .set('Cookie', [
        'pkce_verifier=verifier-value',
        'app_url=https://app.example.com',
        `post_login_path=${encodeURIComponent('/\\evil.example')}`,
      ]);
    expect(res.headers.location).toBe('https://app.example.com/dashboard');
  });

  test('/login does not store a redirect_path containing a backslash', async () => {
    const res = await request(app)
      .get('/api/auth/login?redirect_path=' + encodeURIComponent('/\\evil.example'))
      .set('Origin', 'https://app.example.com');
    const cookies = res.headers['set-cookie'] || [];
    expect(cookies.some((c) => c.startsWith('post_login_path='))).toBe(false);
  });
});
