import { classifyScError, scErrorResponse, tagPlaylistReadFailure } from '../server/lib/sc-errors.js';

describe('classifyScError', () => {
  test.each([
    [{ status: 404 }, 'not_found'],
    [{ status: 502 }, 'upstream_unavailable'],
    [{ status: 503 }, 'upstream_unavailable'],
    [{ status: 504 }, 'upstream_unavailable'],
    [{ code: 'SC_TIMEOUT' }, 'upstream_unavailable'],
    [{ code: 'SC_TIMEOUT', status: 504 }, 'upstream_unavailable'],
    [{ status: 429 }, 'rate_limited'],
    [{ status: 500 }, null],
    [{ status: 403 }, null],
    [new Error('boom'), null],
    [null, null],
    [undefined, null],
    ['str', null],
  ])('%j -> %s', (err, expected) => {
    expect(classifyScError(err)).toBe(expected);
  });
});

describe('scErrorResponse', () => {
  const nf = { status: 409, playlistId: 5, error: 'gone' };

  test('a 404 with a notFound spec maps to it, with code and playlistId', () => {
    expect(scErrorResponse({ status: 404 }, { notFound: nf })).toEqual({
      status: 409, code: 'PLAYLIST_NOT_FOUND', body: { code: 'PLAYLIST_NOT_FOUND', playlistId: 5, error: 'gone' },
    });
  });

  test('a 404 without a notFound spec (a write) maps to nothing', () => {
    expect(scErrorResponse({ status: 404 })).toBeNull();
  });

  test('playlistId is omitted when the spec has none', () => {
    const r = scErrorResponse({ status: 404 }, { notFound: { status: 404, error: 'x' } });
    expect(r.body).toEqual({ code: 'PLAYLIST_NOT_FOUND', error: 'x' });
  });

  test('an outage names whether a write may have landed', () => {
    expect(scErrorResponse({ status: 502 }).body.error).toMatch(/nothing was changed/i);
    expect(scErrorResponse({ code: 'SC_TIMEOUT' }, { writeAttempted: true }).body.error).toMatch(/some changes may have been made/i);
    expect(scErrorResponse({ status: 503 }, { readOnly: true }).body.error).not.toMatch(/chang/i);
  });

  test.each([[{ status: 429 }], [{ status: 500 }], [new Error('boom')], [null]])('%j maps to nothing', (err) => {
    expect(scErrorResponse(err, { notFound: nf })).toBeNull();
  });
});

describe('tagPlaylistReadFailure', () => {
  test('tags and rethrows the same error', async () => {
    const err = new Error('x');
    await expect(Promise.reject(err).catch(tagPlaylistReadFailure(9))).rejects.toBe(err);
    expect(err.scPlaylistId).toBe(9);
  });

  test('rethrows a non-object untouched', async () => {
    await expect(Promise.reject('str').catch(tagPlaylistReadFailure(9))).rejects.toBe('str');
  });
});
