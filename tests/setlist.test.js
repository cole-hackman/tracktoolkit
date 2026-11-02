import { buildSetlistDescription, dedupeTracks, isAllowedSourceUrl, SC_PLAYLIST_DESCRIPTION_MAX } from '../server/lib/setlist.js';

describe('dedupeTracks', () => {
  test('keeps the first occurrence, in order, and reports the rest', () => {
    const { kept, duplicates } = dedupeTracks([
      { id: 1, label: 'A - One' },
      { id: 2, label: 'B - Two' },
      { id: 1, label: 'A - One (again)' },
      { id: 3, label: 'C - Three' },
    ]);
    expect(kept.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(duplicates).toEqual([{ id: 1, label: 'A - One (again)' }]);
  });
});

describe('buildSetlistDescription', () => {
  test('one line per track, in order, then the source link', () => {
    const { description, omitted } = buildSetlistDescription(['A - One', 'B -  Two\n'], {
      sourceUrl: 'https://1001.tl/23pzf2u1',
    });
    expect(description).toBe('A - One\nB - Two\n\nTracklist: https://1001.tl/23pzf2u1');
    expect(omitted).toBe(0);
  });

  test('no source link when none is given', () => {
    expect(buildSetlistDescription(['A - One']).description).toBe('A - One');
  });

  test('over the cap: whole lines only, a count of the rest, and the reserve respected', () => {
    const labels = Array.from({ length: 200 }, (_, i) => `Artist ${i + 1} - A Reasonably Long Track Title ${i + 1}`);
    const reserve = 70;
    const { description, omitted } = buildSetlistDescription(labels, { sourceUrl: 'https://1001.tl/x', reserve });

    expect(description.length + reserve).toBeLessThanOrEqual(SC_PLAYLIST_DESCRIPTION_MAX);
    expect(omitted).toBeGreaterThan(0);
    const lines = description.split('\n');
    const listed = lines.filter((l) => l.startsWith('Artist '));
    expect(listed).toEqual(labels.slice(0, listed.length));
    expect(listed.length + omitted).toBe(200);
    expect(description).toContain(`…and ${omitted} more — the playlist order continues`);
    expect(description.endsWith('Tracklist: https://1001.tl/x')).toBe(true);
  });

  test('a tight budget still yields a note rather than an empty description', () => {
    const { description, omitted } = buildSetlistDescription(['x'.repeat(100), 'y'], { max: 60 });
    expect(omitted).toBe(2);
    expect(description).toBe('…and 2 more — the playlist order continues');
  });
});

describe('isAllowedSourceUrl', () => {
  test.each([
    ['https://www.1001tracklists.com/tracklist/23pzf2u1/x.html', true],
    ['https://1001tracklists.com/tracklist/23pzf2u1/x.html', true],
    ['https://1001.tl/23pzf2u1', true],
    ['http://www.1001tracklists.com/tracklist/x.html', false],
    ['https://1001tracklists.com.evil.example/x', false],
    ['javascript:alert(1)', false],
    [['https://1001.tl/x'], false],
  ])('%s → %s', (value, expected) => {
    expect(isAllowedSourceUrl(value)).toBe(expected);
  });
});
