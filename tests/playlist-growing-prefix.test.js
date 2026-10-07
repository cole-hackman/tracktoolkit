import { jest } from '@jest/globals';

jest.unstable_mockModule('../server/lib/pacing.js', () => ({
  SC_WRITE_PACING_MS: 0,
  SC_PLAYLIST_PACING_MS: 0,
  SC_BULK_PACING_MS: 0,
  SC_READ_CONCURRENCY: 5,
  sleep: jest.fn(async () => {}),
  mapWithConcurrency: async (items, _l, fn) => Promise.all(items.map(fn)),
}));

const { writeGrowingPrefix } = await import('../server/lib/playlist-transfer.js');
const { sleep } = await import('../server/lib/pacing.js');

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

async function run(ids, floor, batchSize = 100) {
  const lengths = [];
  const writes = [];
  await writeGrowingPrefix({
    ids,
    floor,
    batchSize,
    write: async (prefix) => { lengths.push(prefix.length); writes.push(prefix); },
  });
  return { lengths, writes };
}

describe('writeGrowingPrefix', () => {
  beforeEach(() => sleep.mockClear());

  test('never writes a prefix shorter than the floor, and ends with the full list', async () => {
    const ids = range(480);
    const { lengths, writes } = await run(ids, 450);
    expect(lengths.every((n) => n >= 450)).toBe(true);
    expect(writes[writes.length - 1]).toEqual(ids);
    // every write is a true prefix, so existing order is preserved
    for (const w of writes) expect(w).toEqual(ids.slice(0, w.length));
  });

  test('a floor of 0 grows by batchSize from the first batch', async () => {
    const { lengths } = await run(range(250), 0);
    expect(lengths).toEqual([100, 200, 250]);
  });

  test('a list shorter than one batch is a single write', async () => {
    expect((await run(range(40), 0)).lengths).toEqual([40]);
  });

  test('a floor at or beyond the list length gives a single full write', async () => {
    expect((await run(range(30), 30)).lengths).toEqual([30]);
    expect((await run(range(30), 500)).lengths).toEqual([30]);
  });

  test('an empty list makes no write', async () => {
    expect((await run([], 0)).lengths).toEqual([]);
    expect((await run([], 10)).lengths).toEqual([]);
  });

  test('paces between writes only, not before the first or after the last', async () => {
    const { lengths } = await run(range(250), 0);
    expect(sleep).toHaveBeenCalledTimes(lengths.length - 1);
  });

  test('a rejected write propagates and stops further writes', async () => {
    const write = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('429'));
    await expect(writeGrowingPrefix({ ids: range(450), floor: 0, batchSize: 100, write })).rejects.toThrow('429');
    expect(write).toHaveBeenCalledTimes(2);
  });
});
