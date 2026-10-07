/**
 * Daily retention purge.
 *
 * Every row this service keeps has a stated lifetime; this is the job that
 * actually enforces them, rather than the privacy page describing a policy
 * nothing implements. It runs once ten minutes after boot and then daily.
 *
 * Design notes:
 *   - Each step is one bulk statement and is isolated: a step that throws is
 *     logged and the rest still run. A failing step must not be able to hold
 *     the whole policy hostage, and the next run retries it anyway.
 *   - Nothing here ever throws to its caller, so the interval cannot die.
 *   - The user deletes rely on the same onDelete: Cascade that the account
 *     deletion route relies on (tests/account-deletion-cascade.test.js), so
 *     removing a user row removes its tokens, logs, votes and cache pages.
 *   - Step 0 snapshots the lifetime distinct-user count before ANY delete in
 *     the run. Not just before the operation-log purge: the user sweeps
 *     cascade into operation_logs too, so counting after them would drop the
 *     departing users from the all-time figure that exists to remember them.
 *   - Right after it, step 0 adds the tracks processed since the previous
 *     run to a running total (accumulateTracksProcessed). Those two metrics
 *     are what GET /api/stats/public serves, so the public figures move once
 *     a day, when this job runs.
 *   - Every user delete logs its size before it runs. That is useful *during*
 *     a run, but it is not a preview: the line lands microseconds before the
 *     delete it describes, in the same pass. Reviewing before anything is
 *     destroyed is what RETENTION_DRY_RUN is for — see below.
 *
 * RETENTION_DRY_RUN=true makes a scheduled run count everything and write
 * nothing: every step reports `would remove N`, the user sweeps still print
 * their `will remove N users` line, and no deleteMany, updateMany or upsert is
 * issued at all. It exists because "deploy inert, read the counts, then
 * enable" was the intended first-production-run procedure and there was no way
 * to actually do it — RETENTION_ENABLED=false schedules nothing, so it
 * produces silence, which reads exactly like "nothing to delete".
 * tests/retention-dry-run.test.js mocks the client with a Proxy that records
 * every call whose method starts with delete/update/upsert/create, plus
 * $executeRaw and $transaction, on ANY delegate — declared by that file or
 * not — and fails if the set is non-empty under the flag. That phrasing is
 * load-bearing: the first version listed nine method names and a rogue
 * user.delete, rebrandVote.deleteMany, metric.deleteMany or $executeRaw
 * DELETE all left it green, because the mock had no such property and runStep
 * swallows the TypeError.
 *
 * Windows (env-overridable where the brief calls for it):
 *   library cache   CACHE_TTL_DAYS         7 days
 *   disconnected    (constant)             6 days
 *   inactive        INACTIVE_MONTHS        24 months
 *   operation logs  OPLOG_RETENTION_DAYS   365 days
 *   growth actions  (constant)             365 days
 *   feedback        (constant)             730 days
 */
import { Prisma } from '@prisma/client';
import prisma from './prisma.js';
import logger from './logger.js';
import { safeError } from './safe-error.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const numFromEnv = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

/** Grace period between a disconnect and the row being removed. Short on
 *  purpose — the tokens are already gone, so this is the window in which
 *  logging back in still restores the account rather than starting over.
 *
 *  SIX, not seven, and the difference is the whole point. The SoundCloud
 *  terms give a hard ceiling — deletion "without undue delay, but in any case
 *  within 7 days" (docs/internal/TERMS-CHECK.md, finding B). This sweep runs
 *  once a day, so a row stamped just after a run waits out its grace period
 *  AND then up to a further RETENTION_INTERVAL_MS before the next sweep sees
 *  it. At seven the worst case is 7 days + one interval — over the ceiling.
 *  At six the same worst case is 6 days + one daily interval ≈ 7, so every
 *  row is gone inside the deadline rather than just after it.
 *
 *  Consequences of touching this: raising it back to 7 reopens the breach;
 *  raising RETENTION_INTERVAL_MS past 24h used to do the same by eating the
 *  day of margin this number buys, which is why that variable is now clamped
 *  (see resolveIntervalMs) rather than merely documented. Both are compliance
 *  changes, not tuning. */
const DISCONNECTED_GRACE_DAYS = 6;
const GROWTH_RETENTION_DAYS = 365;
const FEEDBACK_RETENTION_DAYS = 730;

/** The counter that has to outlive the operation logs it is derived from. */
export const LIFETIME_METRIC_KEY = 'lifetime_distinct_users';

/** Running total of tracks processed, and the createdAt it has counted up to.
 *  Two keys because the total is an accumulation, not a high-water mark — see
 *  accumulateTracksProcessed. */
export const TRACKS_METRIC_KEY = 'lifetime_tracks_processed';
export const TRACKS_CURSOR_KEY = 'lifetime_tracks_processed_through';

/** How far behind `now` the tracks cursor stops. A log row's createdAt is
 *  stamped before its insert commits, and the app and database clocks are not
 *  the same clock; a row landing behind the cursor would never be counted. */
const TRACKS_SETTLE_MS = 5 * 60 * 1000;

/** Ten minutes: long enough for a cold Neon compute and the first wave of
 *  requests to settle before a job that issues large deletes. */
const INITIAL_DELAY_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Hard ceiling on the sweep period. The default is already the maximum —
 *  see resolveIntervalMs for why a longer one breaks the deletion deadline. */
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

const daysAgo = (now, days) => new Date(now - days * DAY_MS);

/** Calendar-month subtraction, not 30-day arithmetic: "24 months" in a privacy
 *  policy means the same date two years earlier.
 *
 *  UTC deliberately. Local-time setMonth shifts the cutoff by an hour whenever
 *  the window crosses a DST boundary, which would make the same input produce
 *  different cutoffs depending on the host's timezone and the time of year. */
function monthsAgo(now, months) {
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
}

/**
 * True when this run must report what it would do and change nothing.
 *
 * Read per run rather than captured at import, so a long-lived process picks
 * up an App Service setting change on its next sweep, and so a test can flip
 * it without re-importing the module.
 *
 * Strictly `'true'`: anything else — including `'1'`, `'yes'` and a typo — is
 * a real run. A dry run that silently became real because someone wrote
 * `RETENTION_DRY_RUN=1` is the failure this guards against, and refusing the
 * near-misses is cheaper than accepting them.
 */
export function isRetentionDryRun(env = process.env) {
  return String(env.RETENTION_DRY_RUN ?? '').trim().toLowerCase() === 'true';
}

/**
 * Run one step, logging its row count in the shape the whole job uses, and
 * swallowing its failure so the following steps still run.
 * @param {string} name  short identifier for the log line
 * @param {() => Promise<{count: number}|number|undefined>} fn
 * @param {object} results  accumulator, null for a step that failed
 * @param {string} [verb]  'removed' for the purges; the metric snapshot
 *   removes nothing, and saying it did in the one log that evidences this
 *   job ran correctly would be worse than a little asymmetry
 */
async function runStep(name, fn, results, verb = 'removed') {
  try {
    const outcome = await fn();
    const count = typeof outcome === 'number' ? outcome : (outcome?.count ?? 0);
    logger.info(`[retention] ${name} ${verb} ${count}`);
    results[name] = count;
  } catch (error) {
    logger.error(`[retention] ${name} failed:`, safeError(error));
    results[name] = null;
  }
}

/**
 * A purge step, expressed as a PAIR: `count` is the read that says how many
 * rows match, `mutate` is the write that acts on them.
 *
 * The pair is the whole mechanism behind the dry run, and it is deliberately
 * not an `if (dryRun) return` inside each mutation. Structuring it this way
 * means there is exactly **one** place in this file that can call `mutate`,
 * so "no write happens in a dry run" is a property of nine lines rather than
 * a promise repeated at nine call sites — and a tenth step added later cannot
 * forget to honour the flag, because it has no mutation to run until it hands
 * one to this function.
 *
 * `count` must describe the same rows as `mutate`. They take the same `where`
 * at every call site below for that reason.
 */
async function purgeStep(name, { count, mutate }, results, dryRun) {
  if (!dryRun) return runStep(name, mutate, results);
  try {
    const pending = await count();
    logger.info(`[retention] ${name} would remove ${pending}`);
    results[name] = pending;
  } catch (error) {
    logger.error(`[retention] ${name} failed:`, safeError(error));
    results[name] = null;
  }
}

/**
 * Snapshot the lifetime distinct-user count.
 *
 * Runs as the FIRST step of every sweep — before the disconnected and dormant
 * user deletes, not merely before the operation-log purge. Those deletes
 * cascade to `operation_logs`, so counting after them would lose every user
 * the same run is about to remove: precisely the people the all-time figure
 * exists to remember.
 *
 * The metric is monotonic: a run raises it to the current distinct count and
 * never lowers it, so the number survives every later purge.
 *
 * Raw SQL, matching the aggregates in routes/admin.js: `COUNT(DISTINCT ...)`
 * is one row out of Postgres, where `findMany({ distinct })` would drag back
 * one row per user to be counted in Node. `::int` because an uncast COUNT
 * arrives as BigInt.
 */
async function snapshotLifetimeUsers(dryRun = false) {
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT COUNT(DISTINCT "userId")::int AS count
    FROM operation_logs
  `);
  const current = Number(rows?.[0]?.count ?? 0);

  const stored = await prisma.metric.findUnique({ where: { key: LIFETIME_METRIC_KEY } });
  const previous = stored ? Number(stored.value) : 0;
  const next = Math.max(previous, current);

  // The upsert is a write, so a dry run skips it and reports the value it
  // would have stored. Harmless to have written, but "changes nothing" has to
  // mean nothing, or the flag is a judgement call instead of a guarantee.
  if (dryRun) return next;

  await prisma.metric.upsert({
    where: { key: LIFETIME_METRIC_KEY },
    create: { key: LIFETIME_METRIC_KEY, value: BigInt(current) },
    update: { value: BigInt(next) },
  });

  return next;
}

/**
 * Add the tracks processed since the last run to the lifetime total.
 *
 * NOT a high-water mark like snapshotLifetimeUsers. SUM("trackCount") over
 * operation_logs is a sum over whatever the 365-day purge has left, so once
 * that purge starts deleting, the live sum falls and then only climbs back as
 * fast as old rows leave. `max(stored, live)` would freeze at the day the
 * purge began. Instead each run sums only the rows created since the cursor —
 * rows no earlier run has seen — adds them to the stored total, and moves the
 * cursor. Every row is counted once, on the first run after it is written,
 * which is days before any purge can reach it (the earliest is the 6-day
 * disconnect sweep). The one row this misses is an operation whose user
 * deletes their account before the next run.
 *
 * The first run has no cursor and sums the whole table, which is the all-time
 * figure for as long as nothing has aged out of it.
 *
 * Runs before any delete in the sweep, for the same reason as the user
 * snapshot: the user sweeps cascade into operation_logs.
 *
 * `view:*` and `read:*` rows are excluded to match tracksProcessed in
 * routes/admin.js — page opens and latency probes are not operations.
 *
 * The total and the cursor are written in one transaction. Writing one without
 * the other would either count the same window twice or skip it.
 */
async function accumulateTracksProcessed(now, dryRun = false) {
  const [storedTotal, storedCursor] = await Promise.all([
    prisma.metric.findUnique({ where: { key: TRACKS_METRIC_KEY } }),
    prisma.metric.findUnique({ where: { key: TRACKS_CURSOR_KEY } }),
  ]);
  const previous = storedTotal ? BigInt(storedTotal.value) : 0n;
  const since = new Date(storedCursor ? Number(storedCursor.value) : 0);
  const through = new Date(now - TRACKS_SETTLE_MS);

  // A cursor at or past `through` (an earlier `now`, or a clock that moved
  // backwards) has nothing new to count. Writing here would move the cursor
  // back and count that window a second time.
  if (through <= since) return Number(previous);

  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT COALESCE(SUM("trackCount"), 0)::bigint AS tracks
    FROM operation_logs
    WHERE "createdAt" > ${since}
      AND "createdAt" <= ${through}
      AND action NOT LIKE 'view:%'
      AND action NOT LIKE 'read:%'
  `);
  const next = previous + BigInt(rows?.[0]?.tracks ?? 0);

  if (dryRun) return Number(next);

  const cursorValue = BigInt(through.getTime());
  await prisma.$transaction([
    prisma.metric.upsert({
      where: { key: TRACKS_METRIC_KEY },
      create: { key: TRACKS_METRIC_KEY, value: next },
      update: { value: next },
    }),
    prisma.metric.upsert({
      where: { key: TRACKS_CURSOR_KEY },
      create: { key: TRACKS_CURSOR_KEY, value: cursorValue },
      update: { value: cursorValue },
    }),
  ]);

  return Number(next);
}

/**
 * Delete users matching `where`, announcing the size of the sweep first.
 *
 * The count is not decoration. These deletes cascade across every per-user
 * table and are irreversible, so an unexpectedly large sweep has to be
 * visible in the log as something other than its own aftermath. The extra
 * COUNT is negligible against an indexed range scan.
 *
 * It is a running commentary, not a preview — the line is written
 * microseconds before the delete, in the same pass, so by the time anyone
 * reads it the rows are gone. Seeing the numbers *before* they are acted on
 * is RETENTION_DRY_RUN's job (file header), which is why `count` and `mutate`
 * below both emit the identical line: the dry run's log is the real sweep's
 * log, not a differently-worded approximation of it.
 */
async function sweepUsers(name, where, results, dryRun) {
  await purgeStep(name, {
    count: async () => {
      // The same line a real run prints, so the dry run's log is literally
      // what the sweep would say — not a differently-worded approximation
      // that has to be mentally translated before it can be trusted.
      const pending = await prisma.user.count({ where });
      logger.info(`[retention] ${name} will remove ${pending} users`);
      return pending;
    },
    mutate: async () => {
      const pending = await prisma.user.count({ where });
      logger.info(`[retention] ${name} will remove ${pending} users`);
      return prisma.user.deleteMany({ where });
    },
  }, results, dryRun);
}

/**
 * Execute the full sweep once. Exported so tests can drive it directly and so
 * an operator can trigger it from a REPL without waiting for the interval.
 *
 * @param {number} [now] epoch millis, injectable for deterministic tests
 * @returns {Promise<object>} per-step row counts (null where the step failed)
 */
export async function runRetentionOnce(now = Date.now(), { dryRun = isRetentionDryRun() } = {}) {
  const results = {};

  if (dryRun) {
    logger.info('[retention] DRY RUN (RETENTION_DRY_RUN=true) — counting only, nothing is written');
  }

  // 0. Lifetime snapshot, FIRST — before the user deletes below, which cascade
  //    to operation_logs and would otherwise erase the very users this figure
  //    exists to remember.
  await runStep('lifetime-users-metric', () => snapshotLifetimeUsers(dryRun), results, 'snapshot');
  //    The tracks total, for the same reason. It also feeds the public stats
  //    endpoint, which is why that endpoint changes once a day.
  await runStep('lifetime-tracks-metric', () => accumulateTracksProcessed(now, dryRun), results, 'snapshot');

  // 1. Library cache tier. Pages are immutable once written, so they age by
  //    createdAt; the state row is rewritten on every sync, so it ages by
  //    updatedAt.
  const cacheCutoff = daysAgo(now, numFromEnv('CACHE_TTL_DAYS', 7));
  const cachePageWhere = { createdAt: { lt: cacheCutoff } };
  await purgeStep('library-cache-pages', {
    count: () => prisma.libraryCachePage.count({ where: cachePageWhere }),
    mutate: () => prisma.libraryCachePage.deleteMany({ where: cachePageWhere }),
  }, results, dryRun);
  const cacheStateWhere = { updatedAt: { lt: cacheCutoff } };
  await purgeStep('library-cache-states', {
    count: () => prisma.libraryCacheState.count({ where: cacheStateWhere }),
    mutate: () => prisma.libraryCacheState.deleteMany({ where: cacheStateWhere }),
  }, results, dryRun);

  // 2. Accounts that disconnected and did not come back. Logging in clears
  //    disconnectedAt, so anything still stamped six days later is settled.
  //    Six, not seven: see DISCONNECTED_GRACE_DAYS — the daily cadence has to
  //    fit inside the terms' 7-day deletion ceiling, not start at it.
  const disconnectedCutoff = daysAgo(now, DISCONNECTED_GRACE_DAYS);
  await sweepUsers('disconnected-users',
    { disconnectedAt: { lt: disconnectedCutoff } }, results, dryRun);

  // 3. Dormant accounts. Rows created before lastLoginAt existed have it null;
  //    updatedAt is the best available proxy for those, and the OAuth callback
  //    touches it on every login.
  const inactiveCutoff = monthsAgo(now, numFromEnv('INACTIVE_MONTHS', 24));
  await sweepUsers('inactive-users', {
    OR: [
      { lastLoginAt: { lt: inactiveCutoff } },
      { AND: [{ lastLoginAt: null }, { updatedAt: { lt: inactiveCutoff } }] },
    ],
  }, results, dryRun);

  // 4. Aged operation logs. The snapshot that protects the all-time figure
  //    already ran as step 0.
  const oplogCutoff = daysAgo(now, numFromEnv('OPLOG_RETENTION_DAYS', 365));
  const oplogWhere = { createdAt: { lt: oplogCutoff } };
  await purgeStep('operation-logs', {
    count: () => prisma.operationLog.count({ where: oplogWhere }),
    mutate: () => prisma.operationLog.deleteMany({ where: oplogWhere }),
  }, results, dryRun);

  // 5. Growth history.
  const growthWhere = { createdAt: { lt: daysAgo(now, GROWTH_RETENTION_DAYS) } };
  await purgeStep('growth-actions', {
    count: () => prisma.growthAction.count({ where: growthWhere }),
    mutate: () => prisma.growthAction.deleteMany({ where: growthWhere }),
  }, results, dryRun);

  // 6. Feedback. Guarded: the model arrives with the feedback feature, and the
  //    job must still run on a client generated without it.
  const feedbackWhere = { createdAt: { lt: daysAgo(now, FEEDBACK_RETENTION_DAYS) } };
  await purgeStep('feedback', {
    count: () => (prisma.feedback ? prisma.feedback.count({ where: feedbackWhere }) : 0),
    mutate: () => {
      if (!prisma.feedback) return { count: 0 };
      return prisma.feedback.deleteMany({ where: feedbackWhere });
    },
  }, results, dryRun);

  // 7. The retired beta survey's email column is the only free-text PII left
  //    in a read-only table. Nulling it every run is cheap and idempotent, and
  //    keeps the aggregate rows without keeping the addresses.
  const betaWhere = { email: { not: null } };
  await purgeStep('beta-signup-emails', {
    count: () => prisma.betaSignup.count({ where: betaWhere }),
    mutate: () => prisma.betaSignup.updateMany({ where: betaWhere, data: { email: null } }),
  }, results, dryRun);

  // 8. Catalog rows for tracks deleted upstream. The row stays as an opaque id
  //    so historical operations still resolve, but the cached metadata goes —
  //    keeping it is exactly the retention a delete-on-removal clause forbids
  //    (docs/internal/TERMS-CHECK.md, clause 2).
  const goneWhere = { access: 'gone', title: { not: null } };
  await purgeStep('catalog-gone-metadata', {
    count: () => prisma.track.count({ where: goneWhere }),
    mutate: () => prisma.track.updateMany({
      where: goneWhere,
      data: {
        title: null,
        artistName: null,
        genre: null,
        genreNormalized: null,
        permalinkUrl: null,
      },
    }),
  }, results, dryRun);

  if (dryRun) {
    logger.info('[retention] DRY RUN complete — no rows were deleted or updated');
  }

  return results;
}

/**
 * Start the daily sweep. Disable with RETENTION_ENABLED=false; anything else
 * (including unset) enables it, because a retention policy that is off by
 * default is not a policy.
 */
/**
 * The sweep period, clamped to at most 24 hours.
 *
 * This is a compliance guard, not a sanity check on a tuning knob. The
 * disconnect window is 6 days (DISCONNECTED_GRACE_DAYS) and the terms' ceiling
 * is 7, so the single day between them is the entire margin — and that margin
 * is spent by the wait for the *next* sweep after a row becomes eligible. At a
 * 24-hour cadence the worst case lands at 7 days. At 48 hours it lands at 8,
 * outside the ceiling, with nothing in the code to say so.
 *
 * Leaving that to a comment meant a deployment dashboard could push the
 * effective deletion deadline past the limit with an env var and no signal.
 * Clamping it means the deadline holds whatever the environment says, and the
 * operator is told their value was not honoured rather than left believing it
 * was. Lowering it is always allowed: a more frequent sweep only shortens the
 * worst case.
 *
 * @returns {number} milliseconds, in (0, MAX_INTERVAL_MS]
 */
export function resolveIntervalMs() {
  const configured = numFromEnv('RETENTION_INTERVAL_MS', DEFAULT_INTERVAL_MS);
  if (configured > MAX_INTERVAL_MS) {
    logger.warn(
      `[retention] RETENTION_INTERVAL_MS=${configured} exceeds the ${MAX_INTERVAL_MS}ms ceiling; ` +
      'clamped to 24h. The 6-day disconnect window leaves one day of margin against the ' +
      "terms' 7-day deletion deadline, and a longer sweep period would spend it. " +
      'See docs/internal/TERMS-CHECK.md finding B.',
    );
    return MAX_INTERVAL_MS;
  }
  return configured;
}

export function startRetentionScheduler() {
  if (process.env.RETENTION_ENABLED === 'false') {
    // Note for whoever is about to use this to "preview" a sweep: it does not.
    // Nothing is scheduled, so no counts are logged, and silence here is
    // indistinguishable from "there was nothing to delete". Set
    // RETENTION_DRY_RUN=true instead — it runs, counts and logs, and writes
    // nothing.
    logger.info(
      '[retention] Disabled via RETENTION_ENABLED=false — no run, and therefore no counts. ' +
      (isRetentionDryRun()
        // Both set. Disabled wins, which is the right precedence — but the
        // operator has asked for a preview and is about to get silence, so
        // say which flag is the one in the way.
        ? 'RETENTION_DRY_RUN=true is also set and has no effect while this is false: ' +
          'unset RETENTION_ENABLED to let the dry run happen.'
        : 'Use RETENTION_DRY_RUN=true to see what a sweep would remove.'),
    );
    return null;
  }

  const intervalMs = resolveIntervalMs();
  const run = () =>
    runRetentionOnce().catch((err) => logger.error('[retention] Run failed:', safeError(err)));

  setTimeout(run, INITIAL_DELAY_MS);
  const interval = setInterval(run, intervalMs);
  interval.unref?.();
  logger.info(
    isRetentionDryRun()
      ? '[retention] Daily purge scheduled in DRY RUN mode (RETENTION_DRY_RUN=true) — it will count and log, and delete nothing'
      : '[retention] Daily purge scheduled',
  );
  return interval;
}
