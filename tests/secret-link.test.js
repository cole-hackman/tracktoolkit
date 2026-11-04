import { extractSecretToken, stripSecretToken } from '../server/lib/secret-link.js';

describe('secret-link', () => {
  test('finds the token in a path or a query', () => {
    expect(extractSecretToken('https://soundcloud.com/u/sets/mix/s-AbC123')).toBe('s-AbC123');
    expect(extractSecretToken('soundcloud.com/u/sets/mix/s-AbC123')).toBe('s-AbC123');
    expect(extractSecretToken('https://soundcloud.com/u/sets/mix?secret_token=s-AbC123')).toBe('s-AbC123');
  });

  test('does not mistake a profile or playlist named s-… for a token', () => {
    expect(extractSecretToken('https://soundcloud.com/s-1234')).toBeNull();
    expect(extractSecretToken('https://soundcloud.com/u/sets/s-1234')).toBeNull();
    expect(extractSecretToken('https://soundcloud.com/u/sets/mix')).toBeNull();
    expect(extractSecretToken('not a url at all %%')).toBeNull();
  });

  test('strip removes the token and leaves everything else', () => {
    expect(stripSecretToken('https://soundcloud.com/u/sets/mix/s-AbC123')).toBe('https://soundcloud.com/u/sets/mix');
    expect(stripSecretToken('https://soundcloud.com/u/sets/mix?secret_token=s-AbC123&a=1')).toBe('https://soundcloud.com/u/sets/mix?a=1');
    expect(stripSecretToken('https://soundcloud.com/u/sets/mix')).toBe('https://soundcloud.com/u/sets/mix');
  });
});
