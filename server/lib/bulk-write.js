/**
 * The loop behind bulk unlike and bulk unfollow: one SoundCloud DELETE per id,
 * sequential, paced at SC_BULK_PACING_MS.
 *
 * Two production failures shaped it (operation_logs, 2026-11-09..16):
 *
 * - **It stops at the first 429 that survives scRequest's own retries.** Once
 *   SoundCloud is limiting the account every later id fails the same way, and
 *   each one still costs ~4.5 s of retries: seven 100-track unlike runs took
 *   5-7.7 minutes each and removed nothing. The untried ids come back as
 *   `skipped` and the response says `rateLimited`, so the client stops too.
 *   bulk-like has done this since 2026-09-22.
 * - **A 404 means the like or follow is already gone, which is what was
 *   asked for.** One account ran the same 100-track unlike twice at once; the
 *   second copy got 404 for every track, reported "failed" and the page told
 *   them nothing was removed. It is `ok` with `alreadyGone: true`.
 *
 * Also stops when the client disconnects, so an abandoned tab is not left
 * working unseen.
 */
import { sleep, SC_BULK_PACING_MS } from './pacing.js';
import { scItemErrorText } from './sc-errors.js';

/**
 * @param {object} opts
 * @param {Array<number>} opts.ids
 * @param {string} opts.idKey            result field name (`trackId`, `userId`)
 * @param {(id: number) => Promise<unknown>} opts.write
 * @param {string} opts.failLabel        what failed, shown for an unclassified error
 * @param {() => boolean} [opts.isAborted]
 * @param {number} [opts.pacingMs]
 * @returns `results[].error` is fixed text (scItemErrorText), safe to send.
 *   `firstErrorMessage` is the first failure's raw message: for the
 *   operation log only, never for a response.
 */
export async function runBulkDelete({
  ids,
  idKey,
  write,
  failLabel,
  isAborted = () => false,
  pacingMs = SC_BULK_PACING_MS,
}) {
  const results = [];
  let rateLimited = false;
  let aborted = false;
  let firstErrorMessage;

  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (!rateLimited && !aborted && isAborted()) aborted = true;
    if (rateLimited || aborted) {
      results.push({ [idKey]: id, status: 'skipped' });
      continue;
    }
    try {
      await write(id);
      results.push({ [idKey]: id, status: 'ok' });
    } catch (err) {
      if (err?.status === 404) {
        results.push({ [idKey]: id, status: 'ok', alreadyGone: true });
      } else {
        firstErrorMessage ??= err?.message || failLabel;
        results.push({ [idKey]: id, status: 'error', error: scItemErrorText(err, failLabel) });
        if (err?.status === 429) {
          rateLimited = true;
          continue;
        }
      }
    }
    if (i < ids.length - 1) await sleep(pacingMs);
  }

  return { results, rateLimited, aborted, firstErrorMessage };
}

/** Counts for logging and for the response's own summary. */
export function summarizeBulk(results) {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let alreadyGone = 0;
  for (const r of results) {
    if (r.status === 'ok') {
      succeeded += 1;
      if (r.alreadyGone) alreadyGone += 1;
    } else if (r.status === 'skipped') {
      skipped += 1;
    } else {
      failed += 1;
    }
  }
  return { succeeded, failed, skipped, alreadyGone };
}

/**
 * One run per user per action at a time. In-process is enough because the app
 * is pinned to one worker (infra/main.bicep, server/lib/social-cache.js).
 */
export function createUserRunLock() {
  const running = new Set();
  return {
    tryAcquire(userId) {
      if (running.has(userId)) return false;
      running.add(userId);
      return true;
    },
    release(userId) {
      running.delete(userId);
    },
  };
}
