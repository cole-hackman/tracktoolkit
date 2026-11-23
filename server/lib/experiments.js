/**
 * Experiments: recording an exposure, and reading an experiment back.
 *
 * lib/flags.js decides, purely, whether an account is in an experiment's
 * population and which arm it gets. This file is the part that touches the
 * database: the exposure row, the "already activated" check, the readout and
 * the rollout gate.
 *
 * WHY A TABLE AND NOT AN OPERATION-LOG ACTION. `experiment_exposures` has a
 * unique (userId, experimentKey), so "once per user per experiment" is
 * enforced by Postgres. `logOperation` is fire-and-forget and has no such
 * constraint: two dashboard tabs opening together would write two rows, and
 * a failed write would be swallowed, leaving a user who saw the variant
 * missing from the data. An `exposure:*` action would also have to be
 * excluded by hand from every aggregate that reads `operation_logs` (the
 * admin tiles, the daily series, the lifetime counter), the way `view:*` and
 * `read:*` are, and the activation metric is itself computed from that table.
 *
 * RETENTION. Exposure rows cascade with their user, exactly like
 * `operation_logs`: account deletion, the 6-day disconnect sweep and the
 * 24-month dormancy sweep all remove them, and no step ages them out on their
 * own. The disconnect sweep matters here: someone who disconnects in their
 * first days is deleted INSIDE the 7-day activation window, and takes their
 * exposure and their operations with them. So every exposure also adds one to
 * a `metrics` counter for its arm (`experiment_enrolled:<key>:<variant>`),
 * which is not per-user and outlives the row. The readout shows both numbers;
 * their difference is how many enrolled accounts each arm has lost.
 */
import { Prisma } from '@prisma/client';
import prisma from './prisma.js';
import {
  ACTIVATION_WINDOW_DAYS,
  FLAGS,
  evaluateFlag,
  readFlagConfig,
  withinEnrolmentWindow,
} from './flags.js';
import { sampleRatioTest, twoProportionTest } from './experiment-stats.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The `operation_logs` actions that change something on the user's
 * SoundCloud account. "Activated" means at least one of these with a status
 * in SUCCESS_STATUSES.
 *
 * Reads (resolve, genre-search, library-audit, playlist-compare,
 * playlist-keyword-search), downloads (proxy-download, download-links,
 * gate-download), growth-discover, growth-check-followbacks, auth-* and
 * admin-* are not writes. `PUT /api/playlists/:id` (a Playlist Modifier or
 * Health Check save) logs nothing at all, so those writes are invisible here.
 *
 * The same list is written out in the SQL of
 * docs/experiments/2026-11-activation-guided-first-run.md;
 * tests/experiment-docs.test.js fails if the two differ.
 */
export const WRITE_ACTIONS = Object.freeze([
  'merge',
  'from-likes',
  'clone',
  'clone-user-likes',
  'followed-likes-to-playlist',
  'followed-playlist-clone',
  'setlist-to-playlist',
  'playlist-transfer',
  'playlist-bulk-add-tracks',
  'playlist-bulk-remove-tracks',
  'delete-playlist',
  'bulk-like',
  'bulk-unlike',
  'bulk-unfollow',
  'bulk-remove-reposts',
  'growth-engage-start',
  'growth-reverse',
  'sort-likes-apply',
  'sort-likes-unlike',
]);

/** 'split' is a success whose output was divided at the 500-track cap;
 *  'partial' means some items were written and some failed. */
export const SUCCESS_STATUSES = Object.freeze(['success', 'split', 'partial']);

/** The counter that outlives the exposure rows of one arm. */
export function enrolledMetricKey(experimentKey, variant) {
  return `experiment_enrolled:${experimentKey}:${variant}`;
}

/** Has this user completed a write, ever? */
export async function hasActivated(userId) {
  const row = await prisma.operationLog.findFirst({
    where: {
      userId,
      action: { in: [...WRITE_ACTIONS] },
      status: { in: [...SUCCESS_STATUSES] },
    },
    select: { id: true },
  });
  return !!row;
}

const NOT_ENROLLED = Object.freeze({ enrolled: false, variant: null, activated: false });

/**
 * The arm this user is in, recording the exposure if this is the first time
 * they could see a difference.
 *
 * Called by the page at the moment it is about to render the part that
 * differs. The order of the checks is the definition of the experiment:
 *
 *   1. The flag must be on for this account (not killed, percent, exclusions,
 *      first login inside [start, end), rollout bucket). Otherwise control,
 *      and nothing is written, even for someone enrolled earlier: a kill or a
 *      percent of 0 turns the variant off for everybody.
 *   2. An existing exposure wins. Its arm is returned as recorded.
 *   3. A new exposure is written only inside the enrolment window and only
 *      for a user who has not completed a write. Someone who already has
 *      would see the same dashboard in both arms, so they could not see a
 *      difference and are not in the experiment.
 *   4. The row and the arm's counter are written in one transaction. If that
 *      fails the error propagates and the caller serves control: nobody is
 *      shown a variant the database does not know they saw.
 *
 * @param {string} key
 * @param {{ id: string, soundcloudId: number, createdAt: Date | string }} user
 * @returns {Promise<{ enrolled: boolean, variant: string | null, activated: boolean }>}
 */
export async function resolveExposure(key, user, { now = Date.now(), env = process.env, flags = FLAGS } = {}) {
  if (flags[key]?.kind !== 'experiment') return NOT_ENROLLED;
  const decision = evaluateFlag(key, user, { env, flags });
  if (!decision.enabled || !decision.variant) return NOT_ENROLLED;

  const where = { userId_experimentKey: { userId: user.id, experimentKey: key } };
  const [existing, activated] = await Promise.all([
    prisma.experimentExposure.findUnique({ where, select: { variant: true } }),
    hasActivated(user.id),
  ]);

  if (existing) return { enrolled: true, variant: existing.variant, activated };
  if (activated || !withinEnrolmentWindow(user.createdAt, now)) return NOT_ENROLLED;

  const metricKey = enrolledMetricKey(key, decision.variant);
  try {
    await prisma.$transaction([
      prisma.experimentExposure.create({
        data: { userId: user.id, experimentKey: key, variant: decision.variant },
      }),
      prisma.metric.upsert({
        where: { key: metricKey },
        create: { key: metricKey, value: 1n },
        update: { value: { increment: 1 } },
      }),
    ]);
    return { enrolled: true, variant: decision.variant, activated: false };
  } catch (error) {
    // P2002: the unique pair already exists, written by a request that raced
    // this one. The transaction rolled back, so the counter was not bumped
    // twice; the row that won is the exposure.
    if (error?.code !== 'P2002') throw error;
    const winner = await prisma.experimentExposure.findUnique({ where, select: { variant: true } });
    if (!winner) throw error;
    return { enrolled: true, variant: winner.variant, activated: false };
  }
}

const ratio = (part, whole) => (whole > 0 ? part / whole : null);

/**
 * Per-arm numbers for one experiment.
 *
 * Population: accounts with an exposure row for `key` (so: still existing).
 * Window: [first login, first login + 7 days), where first login is
 * `users."createdAt"`.
 *
 *   enrolled          exposure rows
 *   enrolledEver      the arm's counter; includes accounts deleted since
 *   windowComplete    enrolled accounts whose window has closed
 *   activated         of those, with >= 1 successful write inside the window
 *   operations        tool operations inside the window, all enrolled
 *                     accounts (every action except view:*, read:*, auth-*)
 *   operationErrors   of those, status 'error'
 *   usersWithError    enrolled accounts with >= 1 such error
 *   feedback…         feedback rows inside the window, spam excluded
 *
 * This query is repeated, as text, in the pre-registration document
 * (`-- name: readout`). Change one and you must change the other;
 * tests/routes/experiment-readout.integration.test.js runs both.
 */
async function readoutRows(key, now) {
  const window = `${ACTIVATION_WINDOW_DAYS} days`;
  // Prisma stores DateTime as UTC wall time in `timestamp` columns. Casting an
  // ISO string to `timestamp` drops the zone and keeps that wall time, so the
  // comparison does not depend on the session's TimeZone setting.
  const asOf = now.toISOString();
  return prisma.$queryRaw`
    WITH enrolled AS (
      SELECT e."userId" AS user_id,
             e.variant,
             u."createdAt" AS first_login,
             u."createdAt" + ${window}::interval AS window_end
      FROM experiment_exposures e
      JOIN users u ON u.id = e."userId"
      WHERE e."experimentKey" = ${key}
    ),
    ops AS (
      SELECT en.user_id,
             COUNT(*) AS operations,
             COUNT(*) FILTER (WHERE ol.status = 'error') AS errors,
             COUNT(*) FILTER (
               WHERE ol.action IN (${Prisma.join([...WRITE_ACTIONS])})
                 AND ol.status IN (${Prisma.join([...SUCCESS_STATUSES])})
             ) AS writes
      FROM enrolled en
      JOIN operation_logs ol
        ON ol."userId" = en.user_id
       AND ol."createdAt" >= en.first_login
       AND ol."createdAt" < en.window_end
      WHERE ol.action NOT LIKE 'view:%'
        AND ol.action NOT LIKE 'read:%'
        AND ol.action NOT LIKE 'auth-%'
      GROUP BY en.user_id
    ),
    fb AS (
      SELECT en.user_id,
             COUNT(*) AS submissions,
             COUNT(*) FILTER (WHERE f.type = 'bug') AS bugs
      FROM enrolled en
      JOIN feedback f
        ON f."userId" = en.user_id
       AND f."createdAt" >= en.first_login
       AND f."createdAt" < en.window_end
      WHERE f.status <> 'spam'
      GROUP BY en.user_id
    )
    SELECT en.variant,
           COUNT(*)::int AS enrolled,
           COUNT(*) FILTER (WHERE en.window_end <= ${asOf}::timestamp)::int AS window_complete,
           COUNT(*) FILTER (
             WHERE en.window_end <= ${asOf}::timestamp AND COALESCE(ops.writes, 0) > 0
           )::int AS activated,
           COALESCE(SUM(ops.operations), 0)::int AS operations,
           COALESCE(SUM(ops.errors), 0)::int AS operation_errors,
           COUNT(*) FILTER (WHERE COALESCE(ops.errors, 0) > 0)::int AS users_with_error,
           COALESCE(SUM(fb.submissions), 0)::int AS feedback_submissions,
           COUNT(*) FILTER (WHERE COALESCE(fb.submissions, 0) > 0)::int AS feedback_users,
           COUNT(*) FILTER (WHERE COALESCE(fb.bugs, 0) > 0)::int AS bug_feedback_users
    FROM enrolled en
    LEFT JOIN ops ON ops.user_id = en.user_id
    LEFT JOIN fb ON fb.user_id = en.user_id
    GROUP BY en.variant
  `;
}

/** A flag's configuration in the shape the admin console prints. */
export function serializeFlagConfig(config) {
  return {
    key: config.key,
    kind: config.kind,
    description: config.description,
    doc: config.doc,
    percent: config.percent,
    percentSource: config.percentSource,
    killed: config.killed,
    start: config.start ? config.start.toISOString() : null,
    end: config.end ? config.end.toISOString() : null,
    variants: config.variants,
    newUsersOnly: config.newUsersOnly,
    guard: config.guard,
    problems: config.problems,
  };
}

/**
 * The readout the admin console shows for one experiment.
 *
 * `status` is where the experiment is in its life:
 *
 *   not-started   nobody enrolled, and enrolment is not open
 *   enrolling     enrolment is open
 *   maturing      END has passed; END + 7 days has not, so accounts can
 *                 still be inside their window (or still be enrolled)
 *   final         END + 7 days has passed and every window has closed
 *   stopped       accounts are enrolled but enrolment ended some other way:
 *                 a kill, percent 0, or the settings going missing
 *
 * The comparison between the arms (`test`, and the two guardrail tests) is
 * only computed at `final`. Before that, and for a stopped run, the counts
 * are shown and the test is null: the pre-registered rule is one look, at the
 * end of a run that went the distance.
 *
 * @returns {Promise<null | object>} null for an unknown key or a rollout flag
 */
export async function experimentReadout(key, { now = new Date(), env = process.env, flags = FLAGS } = {}) {
  const config = readFlagConfig(key, { env, flags });
  if (!config || config.kind !== 'experiment') return null;

  const variantNames = config.variants.map((v) => v.name);
  const [rows, counters] = await Promise.all([
    readoutRows(key, now),
    prisma.metric.findMany({
      where: { key: { in: variantNames.map((name) => enrolledMetricKey(key, name)) } },
    }),
  ]);

  const byVariant = new Map(rows.map((row) => [row.variant, row]));
  const everByKey = new Map(counters.map((row) => [row.key, Number(row.value)]));

  // Registry order, then any arm the table holds that the registry no longer
  // names (a flag whose variants were edited mid-run): show it, do not hide it.
  const names = [...variantNames, ...rows.map((r) => r.variant).filter((v) => !variantNames.includes(v))];

  const variants = names.map((name) => {
    const row = byVariant.get(name) ?? {};
    const enrolled = Number(row.enrolled ?? 0);
    const windowComplete = Number(row.window_complete ?? 0);
    const activated = Number(row.activated ?? 0);
    const operations = Number(row.operations ?? 0);
    const operationErrors = Number(row.operation_errors ?? 0);
    const usersWithError = Number(row.users_with_error ?? 0);
    const bugFeedbackUsers = Number(row.bug_feedback_users ?? 0);
    const enrolledEver = everByKey.get(enrolledMetricKey(key, name)) ?? null;
    return {
      variant: name,
      weight: config.variants.find((v) => v.name === name)?.weight ?? null,
      enrolled,
      enrolledEver,
      deletedSinceEnrolment: enrolledEver === null ? null : Math.max(enrolledEver - enrolled, 0),
      windowComplete,
      activated,
      activationRate: ratio(activated, windowComplete),
      operations,
      operationErrors,
      operationErrorRate: ratio(operationErrors, operations),
      usersWithError,
      usersWithErrorRate: ratio(usersWithError, enrolled),
      feedbackSubmissions: Number(row.feedback_submissions ?? 0),
      feedbackUsers: Number(row.feedback_users ?? 0),
      bugFeedbackUsers,
      bugFeedbackUsersRate: ratio(bugFeedbackUsers, enrolled),
    };
  });

  const totalEnrolled = variants.reduce((sum, v) => sum + v.enrolled, 0);
  const totalComplete = variants.reduce((sum, v) => sum + v.windowComplete, 0);
  const nowMs = now.getTime();
  const enrolmentOpen =
    !config.killed &&
    config.percent > 0 &&
    !!config.start &&
    nowMs >= config.start.getTime() &&
    !config.endInvalid &&
    (!config.end || nowMs < config.end.getTime());

  // Enrolment closed the way the pre-registration says it closes: a valid END
  // has passed, with the flag still on. Anything else that stops enrolment
  // (a kill, percent 0, settings removed by an infra deploy) is a stopped
  // run, which the document says is reported as stopped and is not a result.
  const closedByEnd =
    !config.killed &&
    config.percent > 0 &&
    !!config.start &&
    !config.endInvalid &&
    !!config.end &&
    nowMs >= config.end.getTime();
  // An account first seen just before END can still be enrolled for 7 days
  // after it, so "every enrolled window has closed" is not enough: the
  // horizon itself must have passed.
  const horizonPassed = closedByEnd && nowMs >= config.end.getTime() + ACTIVATION_WINDOW_DAYS * DAY_MS;

  let status;
  if (enrolmentOpen) status = 'enrolling';
  else if (totalEnrolled === 0) status = 'not-started';
  else if (!closedByEnd) status = 'stopped';
  else if (!horizonPassed || totalComplete < totalEnrolled) status = 'maturing';
  else status = 'final';

  // The sample-ratio check is on assignment, not on outcomes, so it is shown
  // from the first exposure. It uses the counters when every arm has one:
  // deletions after enrolment are not an assignment fault.
  const [control, treatment] = variants;
  let srm = null;
  if (variantNames.length === 2 && totalEnrolled > 0) {
    const useEver = control.enrolledEver !== null && treatment.enrolledEver !== null;
    const observed = useEver
      ? [control.enrolledEver, treatment.enrolledEver]
      : [control.enrolled, treatment.enrolled];
    const result = sampleRatioTest(observed, [control.weight, treatment.weight]);
    if (result) srm = { basis: useEver ? 'enrolledEver' : 'enrolled', observed, ...result };
  }

  const compare = (successes, totals) =>
    twoProportionTest({
      controlSuccesses: successes(control),
      controlTotal: totals(control),
      treatmentSuccesses: successes(treatment),
      treatmentTotal: totals(treatment),
    });
  const final = status === 'final' && variantNames.length === 2;

  // When every window will have closed: the end of enrolment plus the window.
  // Null while there is no END, because then there is no fixed horizon yet.
  const readyAt = config.end
    ? new Date(config.end.getTime() + ACTIVATION_WINDOW_DAYS * DAY_MS).toISOString()
    : null;

  return {
    key,
    config: serializeFlagConfig(config),
    windowDays: ACTIVATION_WINDOW_DAYS,
    generatedAt: now.toISOString(),
    status,
    readyAt,
    variants,
    srm,
    test: final ? compare((v) => v.activated, (v) => v.windowComplete) : null,
    guardrailTests: final
      ? {
        usersWithError: compare((v) => v.usersWithError, (v) => v.enrolled),
        bugFeedbackUsers: compare((v) => v.bugFeedbackUsers, (v) => v.enrolled),
      }
      : null,
  };
}

/**
 * The error rate a rollout flag's feature is running at, against the halt
 * threshold the flag declares. This is the per-action figure the Overview
 * tab's "Error rate by feature" already shows (errors / operations for an
 * action), narrowed to the flag's own actions and a short trailing window.
 *
 *   insufficient-data   fewer than `minOperations` in the window: not a pass
 *   ok                  at or under the threshold
 *   halt                over it — set the percent to 0
 *
 * It is a reading, not a control: nothing here changes a flag. The runbook
 * (docs/experiments/staged-rollout-runbook.md) says who acts on it.
 *
 * @returns {Promise<null | object>} null for a flag with no `guard`
 */
export async function rolloutGate(config, { now = new Date() } = {}) {
  const guard = config?.guard;
  if (!guard?.actions?.length) return null;
  const since = new Date(now.getTime() - guard.windowHours * 60 * 60 * 1000);
  const where = { action: { in: guard.actions }, createdAt: { gte: since } };
  const [operations, errors] = await Promise.all([
    prisma.operationLog.count({ where }),
    prisma.operationLog.count({ where: { ...where, status: 'error' } }),
  ]);
  const errorRatePct = operations > 0 ? (errors / operations) * 100 : null;
  let status = 'ok';
  if (operations < guard.minOperations) status = 'insufficient-data';
  else if (errorRatePct > guard.maxErrorRatePct) status = 'halt';
  return {
    status,
    actions: guard.actions,
    windowHours: guard.windowHours,
    operations,
    errors,
    errorRatePct,
    maxErrorRatePct: guard.maxErrorRatePct,
    minOperations: guard.minOperations,
  };
}
