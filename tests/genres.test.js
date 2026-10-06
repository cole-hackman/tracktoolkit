import { matchesGenreFocus, normalizeGenreToken } from '../server/lib/genres.js';

const m = (token, slug) => matchesGenreFocus(new Set([token]), slug);

describe('normalizeGenreToken', () => {
  test('lowercases, maps & to and, collapses punctuation, trims dashes', () => {
    expect(normalizeGenreToken('Drum & Bass')).toBe('drum-and-bass');
    expect(normalizeGenreToken('  --R&B / Soul-- ')).toBe('r-and-b-soul');
  });
  test('strips diacritics', () => {
    expect(normalizeGenreToken('electrónica')).toBe('electronica');
  });
});

describe('matchesGenreFocus', () => {
  test.each([
    ['housewife', 'house'],
    ['tech-house', 'techno'],
    ['trip-hop', 'hip-hop'],
    ['popcorn', 'pop'],
  ])('%s does not match %s', (token, slug) => {
    expect(m(token, slug)).toBe(false);
  });

  test.each([
    ['deep-house', 'house'],
    ['deephouse', 'house'],
    ['techhouse', 'house'],
    ['housemusic', 'house'],
    ['psytrance', 'trance'],
    ['drumandbass', 'drum-and-bass'],
    ['drumnbass', 'drum-and-bass'],
    ['dnb', 'drum-and-bass'],
    ['jungle', 'drum-and-bass'],
    ['metalcore', 'metal'],
    ['synthpop', 'pop'],
    ['kpop', 'pop'],
    ['hyperpop', 'pop'],
    ['brostep', 'dubstep'],
    ['neoclassical', 'classical'],
    ['indietronica', 'indie'],
    ['indietronica', 'electronic'],
    ['electrónica', 'electronic'],
    ['house party', 'house'],
    ['pop punk', 'pop'],
  ])('%s matches %s', (token, slug) => {
    expect(m(token, slug)).toBe(true);
  });
});
