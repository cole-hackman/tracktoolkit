import { jest } from '@jest/globals';
const { default: logger } = await import('../server/lib/logger.js');

let logSpy;
beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { logSpy.mockRestore(); });

describe('logger.info message sanitization', () => {
  test('redacts token= in the message string', () => {
    logger.info('refresh failed token=super-secret-value retrying');
    expect(logSpy.mock.calls[0][0]).toContain('token=***');
    expect(logSpy.mock.calls[0][0]).not.toContain('super-secret-value');
  });

  test('redacts oauth_token embedded in a URL query string', () => {
    logger.info('resolving https://api.soundcloud.com/me?oauth_token=SECRET123&limit=5');
    expect(logSpy.mock.calls[0][0]).not.toContain('SECRET123');
  });

  test('leaves ordinary messages untouched', () => {
    logger.info('200 GET /api/playlists 154ms');
    expect(logSpy.mock.calls[0][0]).toBe('[INFO] 200 GET /api/playlists 154ms');
  });

  test.each([
    'Token refresh failed: no user context',
    'API request failed after token refresh: 401',
    '[auth] invalid_grant for a superseded refresh token',
  ])('leaves a message that only mentions a token untouched: %s', (message) => {
    logger.info(message);
    expect(logSpy.mock.calls[0][0]).toBe(`[INFO] ${message}`);
  });
});

describe('redaction removes the secret, not only marks it', () => {
  // The replacement used to be "everything before the first = or :", plus
  // "=***". For a pattern with neither ("OAuth X", "Bearer X") that was the
  // whole match, so the credential was printed with "=***" after it.
  const line = () => logSpy.mock.calls[0].map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');

  test.each([
    ['an OAuth credential', 'Headers.append: "OAuth 2-AB\0CDTOKEN" is an invalid header value.', ['2-AB', 'CDTOKEN']],
    ['a Bearer credential', 'upstream rejected Bearer BEARERSECRET1', ['BEARERSECRET1']],
    ['an Authorization header', 'Authorization: OAuth HEADERSECRET2 sent', ['HEADERSECRET2']],
    ['a JSON body', '{"access_token":"JSONSECRET3","refresh_token":"JSONSECRET4"}', ['JSONSECRET3', 'JSONSECRET4']],
    ['a key, a colon and a space', 'access_token: SPACEDSECRET5', ['SPACEDSECRET5']],
    ['a key, spaces and an equals sign', 'client_secret = SPACEDSECRET6', ['SPACEDSECRET6']],
    ['a quoted value', "password='QUOTEDSECRET7'", ['QUOTEDSECRET7']],
    ['a value holding a comma', 'password=HALF8,OTHERHALF8 next', ['HALF8', 'OTHERHALF8']],
    ['a query string', 'GET /cb?code=QUERYSECRET9&state=x', ['QUERYSECRET9']],
  ])('%s, in the message', (_name, text, secrets) => {
    logger.info(text);
    for (const secret of secrets) expect(line()).not.toContain(secret);
    expect(line()).toContain('***');
  });

  test.each([
    ['an OAuth credential', 'Headers.append: "OAuth 2-AB\0CDTOKEN" is an invalid header value.', ['2-AB', 'CDTOKEN']],
    ['a Bearer credential', 'upstream rejected Bearer BEARERSECRET1', ['BEARERSECRET1']],
    ['a JSON body', '{"access_token":"JSONSECRET3"}', ['JSONSECRET3']],
    ['a key, a colon and a space', 'access_token: SPACEDSECRET5', ['SPACEDSECRET5']],
  ])('%s, in an error object and in a nested string', (_name, text, secrets) => {
    logger.info('failed', { error: new Error(text), detail: { message: text } });
    for (const secret of secrets) expect(line()).not.toContain(secret);
  });

  test('the scheme and the key stay readable', () => {
    logger.info('sent OAuth abc and Bearer def with token=ghi');
    expect(logSpy.mock.calls[0][0]).toBe('[INFO] sent OAuth *** and Bearer *** with token=***');
  });
});
