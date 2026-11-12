/**
 * Pacing for sequential SoundCloud API writes. SoundCloud's rate limits are
 * undocumented; 300ms between mutating calls is the empirically safe floor
 * used across merge, clone, and bulk operations.
 */
export const SC_WRITE_PACING_MS = 300;

/**
 * Longer pause taken between *playlists* rather than between batches within
 * one playlist — creating a playlist is heavier than appending to one, and
 * these sites were previously an unnamed `sleep(500)` repeated nine times.
 */
export const SC_PLAYLIST_PACING_MS = 500;

/**
 * Pacing for bulk like/unlike/unfollow/unrepost loops. Lighter than
 * SC_WRITE_PACING_MS because these are single-resource DELETEs and POSTs
 * rather than whole-playlist PUTs.
 */
export const SC_BULK_PACING_MS = 150;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` over `items` with at most `limit` in flight at once.
 *
 * Reads are the case this exists for. SoundCloud's cursor pagination forces
 * page-by-page sequencing, but independent resources (N playlists, N URLs to
 * resolve) have no such constraint — those loops were either fully serial
 * (slow) or an unbounded Promise.all (a burst straight into the rate limit).
 * Bounded concurrency is the middle that is neither.
 *
 * Results come back in input order regardless of completion order. A rejection
 * propagates, so callers that want per-item failures should return a result
 * object from `fn` rather than throwing.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit    Maximum concurrent calls (clamped to >= 1)
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];

  const width = Math.max(1, Math.min(Math.floor(limit) || 1, list.length));
  const results = new Array(list.length);
  let cursor = 0;

  async function worker() {
    while (cursor < list.length) {
      const index = cursor++;
      results[index] = await fn(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/**
 * Concurrency used for independent SoundCloud reads. Deliberately modest:
 * the point is to stop being serial, not to burst. SoundCloud's limits are
 * undocumented, and the previous unbounded fan-out demonstrably drew 429s.
 */
export const SC_READ_CONCURRENCY = 5;

// THROWAWAY: deliberate undefined identifier (inside an uncalled function, so only lint can see it)
export function throwawayProof() {
  return SC_WRITE_PACING_MS_TYPO * 2;
}
