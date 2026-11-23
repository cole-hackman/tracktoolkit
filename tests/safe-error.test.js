import { jest } from '@jest/globals';

/**
 * `safeErrorBrief` describes a thrown value for a summary log line. It is an
 * allowlist: an error's name, code and status when they look like a name, a
 * code and a status, and its message only when the message is one of the
 * SoundCloud client's own fixed templates. Nothing else a thrower wrote is
 * copied, so there is nothing to redact, and it cannot throw.
 */

const { safeErrorBrief, logFailure, rawErrorMessage } = await import('../server/lib/safe-error.js');

const SECRETS = [
  '2-AB', 'CDTOKEN', 'BEARERSECRET1', 'JSONSECRET2', 'SPACEDSECRET3', 's-SCHEMELESS4', 's-ENCODED5',
  'someone@example.com', 's-CODE6', 's-STATUS7', 'user-SECRET8', 'CIPHERTEXT9', 'db.internal', '5432',
  'NAMESECRET10', 'CAUSESECRET11', 'STACKSECRET12',
];

const HOSTILE_TEXT = [
  // undici, for an Authorization header holding a NUL
  () => new TypeError('Headers.append: "OAuth 2-AB\0CDTOKEN" is an invalid header value.'),
  () => new Error('Bearer BEARERSECRET1 was rejected'),
  () => new Error('{"access_token":"JSONSECRET2","scope":""}'),
  () => new Error('access_token: SPACEDSECRET3'),
  () => new Error('GET soundcloud.com/artist/track/s-SCHEMELESS4 failed'),
  () => new Error('fetch https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack%2Fs-ENCODED5 failed'),
  () => new Error('no account for someone@example.com'),
  () => Object.assign(new Error('x'), { code: 'https://soundcloud.com/a/b/s-CODE6', status: 'https://x.test/s-STATUS7' }),
  () => Object.assign(new Error(
    'Invalid `prisma.token.update()` invocation: { where: { userId: "user-SECRET8" }, data: { refresh: "CIPHERTEXT9==" } }',
  ), { name: 'PrismaClientValidationError' }),
  () => Object.assign(new Error("Can't reach database server at `db.internal:5432`"), { code: 'P1001' }),
  () => Object.assign(new Error('x'), { name: 'NAMESECRET10 with spaces' }),
  () => Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect CAUSESECRET11'), { code: 'ECONNREFUSED' }) }),
  () => Object.assign(new Error('x'), { stack: 'Error: x\n    at STACKSECRET12 (file.js:1:1)' }),
  // A template, with something before or after it
  () => new Error('API request failed: 500 for https://api.soundcloud.com/x?secret_token=s-CODE6'),
  () => new Error('BEARERSECRET1 API request failed: 500'),
];

describe('safeErrorBrief copies nothing a thrower wrote', () => {
  test.each(HOSTILE_TEXT.map((make, i) => [i, make]))('hostile text %i', (_i, make) => {
    const text = JSON.stringify(safeErrorBrief(make()));

    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });

  test('every value it returns is a short name, a short code, an HTTP status or a fixed message', () => {
    for (const make of HOSTILE_TEXT) {
      const brief = safeErrorBrief(make());
      const { cause, ...top } = brief;
      for (const part of [top, cause ?? {}]) {
        for (const [key, value] of Object.entries(part)) {
          if (key === 'status') expect(Number.isInteger(value) && value >= 100 && value <= 599).toBe(true);
          else if (key === 'message') expect(value).toMatch(/^[A-Za-z ()]+(: \d{3}|: no user context| \(status \d{3}\))?$/);
          else if (key === 'name') expect(value).toMatch(/^[A-Za-z][A-Za-z0-9]{0,63}$/);
          else if (key === 'code') expect(String(value)).toMatch(/^-?[A-Z0-9_]{1,40}$/);
          else if (key === 'thrown') expect(value).toBe('object');
          else throw new Error(`unexpected key ${key}`);
        }
      }
    }
  });

  test('no stack, in any environment', () => {
    const before = process.env.NODE_ENV;
    try {
      for (const env of ['development', 'test', 'production']) {
        process.env.NODE_ENV = env;
        const brief = safeErrorBrief(new Error('API request failed: 500'));
        expect(Object.keys(brief).sort()).toEqual(['message', 'name']);
        expect(JSON.stringify(brief)).not.toContain('safe-error.test');
      }
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

describe('safeErrorBrief keeps what identifies a failure', () => {
  test.each([
    [Object.assign(new Error('API request failed: 403'), { status: 403 }), { name: 'Error', status: 403, message: 'API request failed: 403' }],
    [new Error('Resolve error: 404'), { name: 'Error', message: 'Resolve error: 404' }],
    [new Error('Resolve follow error: 410'), { name: 'Error', message: 'Resolve follow error: 410' }],
    [new Error('Token refresh failed'), { name: 'Error', message: 'Token refresh failed' }],
    [new Error('Token refresh failed: 400'), { name: 'Error', message: 'Token refresh failed: 400' }],
    [new Error('Token refresh failed: no user context'), { name: 'Error', message: 'Token refresh failed: no user context' }],
    [new Error('API request failed after token refresh: 401'), { name: 'Error', message: 'API request failed after token refresh: 401' }],
    [
      Object.assign(new Error('The operation was aborted.'), { name: 'AbortError', code: 'SC_TIMEOUT', status: 504 }),
      { name: 'AbortError', code: 'SC_TIMEOUT', status: 504 },
    ],
    [
      Object.assign(new Error("Can't reach database server at `db.internal:5432`"), { name: 'PrismaClientKnownRequestError', code: 'P1001' }),
      { name: 'PrismaClientKnownRequestError', code: 'P1001' },
    ],
    [
      Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }) }),
      { name: 'TypeError', message: 'fetch failed', cause: { name: 'Error', code: 'ECONNREFUSED' } },
    ],
    // parseScJson names the endpoint first; only its fixed ending is kept.
    [new Error('/likes/tracks/123: invalid JSON response (status 200)'), { name: 'Error', message: 'invalid JSON response (status 200)' }],
    [new Error('resolve: empty response (status 204)'), { name: 'Error', message: 'empty response (status 204)' }],
    [Object.assign(new Error('x'), { code: 23505 }), { name: 'Error', code: 23505 }],
    [Object.assign(new Error('x'), { code: '57P01' }), { name: 'Error', code: '57P01' }],
  ])('%#', (err, expected) => {
    expect(safeErrorBrief(err)).toEqual(expected);
  });

  test.each([
    ['a template with a longer number', 'API request failed: 5000'],
    ['a template with text after it', 'Resolve error: 404 for x'],
    ['a template with text before it', 'x Resolve error: 404'],
    ['a template in another case', 'api request failed: 500'],
    ['a template across lines', 'x\nResolve error: 404'],
    ['a fixed ending with text after it', 'x: invalid JSON response (status 200) y'],
  ])('%s is not a template: no message', (_name, message) => {
    expect(safeErrorBrief(new Error(message))).toEqual({ name: 'Error' });
  });

  test('whatever comes before a fixed ending, only the ending is kept', () => {
    const err = new Error('GET /x?secret_token=s-CODE6\nBEARERSECRET1: invalid JSON response (status 502)');

    expect(safeErrorBrief(err)).toEqual({ name: 'Error', message: 'invalid JSON response (status 502)' });
  });

  test.each([
    ['a lower-case code', { code: 'p1001' }],
    ['a code with a dash', { code: '2-294758-ABC' }],
    ['a code that is too long', { code: 'A'.repeat(41) }],
    ['a huge numeric code', { code: 12345678901 }],
    ['a fractional code', { code: 1.5 }],
    ['a status outside HTTP', { status: 99 }],
    ['a status above HTTP', { status: 600 }],
    ['a string status', { status: '500' }],
    ['a fractional status', { status: 500.5 }],
    ['a name that is too long', { name: 'N'.repeat(65) }],
    ['a name with a space', { name: 'Not A Name' }],
    ['an object for a code', { code: { toString: () => 'P1001' } }],
  ])('%s is dropped', (_name, fields) => {
    const brief = safeErrorBrief(Object.assign(new Error('x'), fields));

    expect(brief).toEqual('name' in fields ? { thrown: 'object' } : { name: 'Error' });
  });

  test.each([
    [null, { thrown: 'null' }],
    [undefined, { thrown: 'undefined' }],
    ['a string that may hold BEARERSECRET1', { thrown: 'string' }],
    [42, { thrown: 'number' }],
    [Symbol('s'), { thrown: 'symbol' }],
    [Object.create(null), { thrown: 'object' }],
    [{}, { thrown: 'object' }],
  ])('a thrown non-error %#: only what kind of thing it was', (thrown, expected) => {
    expect(safeErrorBrief(thrown)).toEqual(expected);
  });
});

const explode = () => { throw new Error('GETTER-TEXT'); };
const HOSTILE_VALUES = [
  ['an object with no prototype', () => Object.create(null)],
  ['throwing getters', () => Object.defineProperties({}, {
    name: { get: explode }, message: { get: explode }, code: { get: explode },
    status: { get: explode }, cause: { get: explode }, stack: { get: explode },
  })],
  ['a throwing toString', () => ({ toString: explode, valueOf: explode, [Symbol.toPrimitive]: explode })],
  ['a proxy that throws on every read', () => new Proxy({}, { get: explode, has: explode, ownKeys: explode, getOwnPropertyDescriptor: explode })],
  ['a cause that throws', () => Object.assign(new Error('x'), { cause: new Proxy({}, { get: explode }) })],
  ['a cause that is itself', () => { const e = new Error('x'); e.cause = e; return e; }],
  ['a revoked proxy', () => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; }],
];

describe('none of it can throw', () => {
  test.each(HOSTILE_VALUES)('safeErrorBrief: %s', (_name, make) => {
    let brief;
    expect(() => { brief = safeErrorBrief(make()); }).not.toThrow();
    expect(JSON.stringify(brief)).not.toContain('GETTER-TEXT');
  });

  test.each(HOSTILE_VALUES)('rawErrorMessage: %s gives the fallback', (name, make) => {
    const expected = name.startsWith('a cause') ? 'x' : 'Like failed';
    expect(rawErrorMessage(make(), 'Like failed')).toBe(expected);
  });

  test('rawErrorMessage: a string message, else the fallback', () => {
    expect(rawErrorMessage(new Error('API request failed: 403'), 'f')).toBe('API request failed: 403');
    expect(rawErrorMessage(new Error(''), 'f')).toBe('f');
    expect(rawErrorMessage({ message: 5 }, 'f')).toBe('f');
    expect(rawErrorMessage(null, 'f')).toBe('f');
  });

  describe('logFailure', () => {
    let warn;
    beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => jest.restoreAllMocks());

    test('one warn line: the counts, and each error as its brief', () => {
      logFailure('Bulk like: items failed', { failed: 2 }, { first: Object.assign(new Error('API request failed: 403'), { status: 403 }) });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe('[WARN] Bulk like: items failed');
      expect(warn.mock.calls[0][1]).toEqual({
        failed: '2',   // the logger prints numbers as text
        first: { name: 'Error', status: '403', message: 'API request failed: 403' },
      });
    });

    test.each(HOSTILE_VALUES)('%s', (_name, make) => {
      expect(() => logFailure('x: items failed', { failed: 1 }, { first: make() })).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    test('a console that throws', () => {
      warn.mockImplementation(() => { throw new Error('EPIPE'); });

      expect(() => logFailure('x: items failed', { failed: 1 }, { first: new Error('x') })).not.toThrow();
    });

    test('hostile counts or a hostile error map', () => {
      expect(() => logFailure('x', new Proxy({}, { ownKeys: explode }), { first: new Error('x') })).not.toThrow();
      expect(() => logFailure('x', { failed: 1 }, new Proxy({}, { ownKeys: explode }))).not.toThrow();
      expect(() => logFailure('x', null, null)).not.toThrow();
    });
  });
});
