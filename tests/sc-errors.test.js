import { classifyScError } from '../server/lib/sc-errors.js';

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
