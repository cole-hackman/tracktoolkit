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

  test('every write keeps the floor as its prefix and the last write is the full list', async () => {
    const ids = range(480);
    const { lengths, writes } = await run(ids, 450);
    expect(lengths).toEqual([480]);
    expect(writes[writes.length - 1]).toEqual(ids);
    for (const w of writes) expect(w).toEqual(ids.slice(0, w.length));
  });

  test('floor 150, n 350, batch 100 writes 250 then 350', async () => {
    const { lengths } = await run(range(350), 150);
    expect(lengths).toEqual([250, 350]);
  });

  test('a floor of 0 grows by batchSize from the first batch', async () => {
    expect((await run(range(250), 0)).lengths).toEqual([100, 200, 250]);
    expect((await run(range(40), 0)).lengths).toEqual([40]);
  });

  test('n equal to floor means nothing new: no write', async () => {
    expect((await run(range(30), 30)).lengths).toEqual([]);
  });

  test('an empty list makes no write', async () => {
    expect((await run([], 0)).lengths).toEqual([]);
  });

  test.each([NaN, -1, 1.5, '3', Infinity])('floor %p is rejected with a TypeError and writes nothing', async (floor) => {
    const write = jest.fn();
    await expect(writeGrowingPrefix({ ids: range(10), floor, batchSize: 100, write })).rejects.toThrow(TypeError);
    expect(write).not.toHaveBeenCalled();
  });

  test('floor greater than ids.length is rejected, not capped', async () => {
    const write = jest.fn();
    await expect(writeGrowingPrefix({ ids: range(10), floor: 11, batchSize: 100, write })).rejects.toThrow(RangeError);
    expect(write).not.toHaveBeenCalled();
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
