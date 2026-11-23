/**
 * First-party feature flags and experiments.
 *
 * THE ONE PLACE A FLAG IS DEFINED is `FLAGS` below. Everything else (the
 * exposure route, /api/auth/me, the admin readout) reads it through this file.
 * No SDK, no network call, no third-party script: a decision is a hash and a
 * few comparisons.
 *
 * Two kinds:
 *
 *   rollout     A feature being released in stages (10 / 50 / 100). A user has
 *               it when their bucket is under the percent. Admins have it from
 *               0%, so "0%" is the internal stage. See
 *               docs/experiments/staged-rollout-runbook.md.
 *   experiment  The same gate, plus a variant split, eligibility by first
 *               login, and an exposure row. Admins and EXPERIMENT_EXCLUDE_IDS
 *               are never enrolled. The exposure itself is written by
 *               lib/experiments.js; this file only decides.
 *
 * ASSIGNMENT is deterministic: sha256("<flag>:<SoundCloud id>") → 0–99. The
 * same account gets the same bucket on every request, every restart and every
 * deploy, for as long as the flag keeps its key, and raising the percent only
 * ever adds accounts (bucket < 10 is a subset of bucket < 50). The variant
 * uses a second, independent hash ("<flag>:variant:<id>") so that a 10%
 * rollout still splits its tenth evenly instead of handing it all to the
 * first variant. The unit is the SoundCloud account id, not the `users` row
 * id: a person who deletes their account and signs up again gets a new row but
 * the same arm.
 *
 * Changing a flag's key, or an experiment's variant list or weights, reassigns
 * everybody. Do neither while it is running — make a new flag.
 *
 * CONFIGURATION is App Service settings, read on every evaluation, so none of
 * it needs a deploy (saving a setting restarts the app, which takes about a
 * minute):
 *
 *   FLAG_<KEY>_PERCENT   0–100. Unset means the default in `FLAGS`, which is 0.
 *   FLAG_<KEY>_START     ISO-8601 with a zone (2026-12-01T00:00:00Z). An
 *                        experiment limited to new users enrols nobody without
 *                        it.
 *   FLAG_<KEY>_END       Optional. Accounts first seen at or after it are not
 *                        eligible; accounts already enrolled keep their arm.
 *   FLAGS_KILL           The kill switch: `all`, or a comma-separated list of
 *                        flag keys. A killed flag is off for everyone.
 *   EXPERIMENT_EXCLUDE_IDS  SoundCloud ids kept out of every experiment (the
 *                        owner's other accounts, testers).
 *
 * <KEY> is the flag key upper-cased with dashes as underscores:
 * `guided-first-run` → FLAG_GUIDED_FIRST_RUN_PERCENT.
 *
 * EVERY MISREAD FAILS TOWARDS OFF. A percent that is not a whole number from 0
 * to 100 is 0. A start that does not parse is no start, and an end that does
 * not parse closes enrolment. An EXPERIMENT_EXCLUDE_IDS entry that is not an
 * id stops every experiment enrolling. A FLAGS_KILL entry that is not a known
 * flag key kills every flag — a typo in the kill switch must stop more than
 * was meant, never less. Each is reported in `problems`,
 * in the boot log and in the admin console, so a setting that was not honoured
 * is visible rather than silent.
 *
 * Settings were chosen over a database row because that is what every other
 * runtime switch here is (RETENTION_DRY_RUN, SURVEY_ENABLED, ADMIN_IDS) and it
 * costs no read on the request path. The price is the one those already pay:
 * `infra/main.bicep` declares `appSettings` as a complete list, so
 * `infra/deploy.sh` removes anything set by hand. For a flag that means
 * percent 0 and no start — off, which is safe for users and not for a running
 * experiment. Re-check the settings after any infra deploy.
 */
import { createHash } from 'node:crypto';
import logger from './logger.js';
import { accessFor } from './download-access.js';

/** Days after first login in which a new user can be enrolled, and the
 *  window the activation metric is measured over. One number on purpose: a
 *  user enrolled after it could not move the metric. */
export const ACTIVATION_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The flag registry.
 *
 * `rolloutPercent` is the value used when FLAG_<KEY>_PERCENT is unset. Keep
 * it 0 for anything not fully released: merging a flag must change nothing.
 *
 * A rollout flag may name the `operation_logs` actions its feature writes
 * (`guard.actions`); the admin console then shows their error rate against
 * `guard.maxErrorRatePct` beside the flag (lib/experiments.js, rolloutGate).
 *
 * @type {Record<string, {
 *   kind: 'experiment' | 'rollout',
 *   description: string,
 *   rolloutPercent: number,
 *   variants?: { name: string, weight: number }[],
 *   newUsersOnly?: boolean,
 *   doc?: string,
 *   guard?: { actions: string[], maxErrorRatePct: number, minOperations: number, windowHours: number },
 * }>}
 */
export const FLAGS = {
  'guided-first-run': {
    kind: 'experiment',
    description: 'Dashboard start-here panel for new users who have not completed a write',
    rolloutPercent: 0,
    variants: [
      { name: 'control', weight: 50 },
      { name: 'guided', weight: 50 },
    ],
    newUsersOnly: true,
    doc: 'docs/experiments/2026-11-activation-guided-first-run.md',
  },
};

/** FLAG_GUIDED_FIRST_RUN_PERCENT and friends. */
export function flagEnvName(key, suffix) {
  return `FLAG_${key.toUpperCase().replace(/-/g, '_')}_${suffix}`;
}

/**
 * sha256(parts joined by ":") → an integer 0–99.
 *
 * The first 32 bits of the digest, modulo 100. 2^32 is not a multiple of 100,
 * so buckets 0–95 are each 1 part in 43 million likelier than 96–99; that is
 * far below anything a sample here could resolve.
 */
function hashBucket(...parts) {
  const digest = createHash('sha256').update(parts.join(':')).digest();
  return digest.readUInt32BE(0) % 100;
}

/** The rollout bucket for a unit: is this account inside "N percent"? */
export function bucketFor(flagKey, unitId) {
  return hashBucket(flagKey, String(unitId));
}

/** The variant bucket: independent of the rollout bucket (see file header). */
export function variantBucketFor(flagKey, unitId) {
  return hashBucket(flagKey, 'variant', String(unitId));
}

/**
 * The variant a unit is assigned to, by cumulative weight over the variant
 * bucket. Weights must sum to 100 (asserted by tests/flags.test.js for every
 * flag in the registry).
 */
export function variantFor(flagKey, unitId, flags = FLAGS) {
  const variants = flags[flagKey]?.variants;
  if (!variants?.length) return null;
  const bucket = variantBucketFor(flagKey, unitId);
  let ceiling = 0;
  for (const { name, weight } of variants) {
    ceiling += weight;
    if (bucket < ceiling) return name;
  }
  return variants[variants.length - 1].name;
}

/** Whole numbers 0–100 only. `50%`, `0.5`, `fifty` and `101` are all refused. */
function parsePercent(raw) {
  const text = String(raw).trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const value = Number(text);
  return value <= 100 ? value : null;
}

/**
 * ISO-8601 with an explicit zone. A bare date or a local time is refused: the
 * same string would mean a different instant on a laptop and on App Service,
 * and this instant decides who is in the experiment.
 */
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
function parseInstant(raw) {
  const text = String(raw).trim();
  const match = ISO_WITH_ZONE.exec(text);
  if (!match) return null;
  // `new Date` rolls an impossible date over instead of refusing it:
  // February 30th becomes March 2nd and 24:00 becomes the next day. A typo
  // in END would then extend enrolment without a word, so the fields are
  // checked against the calendar first.
  const [year, month, day, hour, minute, second = 0, offsetHour = 0, offsetMinute = 0] = match.slice(1).map((part) => (part === undefined ? undefined : Number(part)));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * EXPERIMENT_EXCLUDE_IDS, strictly. An entry that is not a plain positive
 * integer (`999;123`, `"123"`, a username) is returned in `invalid` rather
 * than dropped: dropping it would enrol exactly the account someone meant to
 * keep out, and say nothing.
 */
function readExclusions(env) {
  const tokens = String(env.EXPERIMENT_EXCLUDE_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ids = [];
  const invalid = [];
  for (const token of tokens) {
    const id = Number(token);
    if (/^\d+$/.test(token) && Number.isSafeInteger(id) && id > 0) ids.push(id);
    else invalid.push(token);
  }
  return { ids, invalid };
}

/**
 * Which flags FLAGS_KILL turns off. An entry that names no flag kills them
 * all: the operator meant to stop something, and guessing which is worse than
 * stopping too much.
 */
function readKill(env, flags) {
  const tokens = String(env.FLAGS_KILL ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = tokens.filter((token) => token !== 'all' && !Object.hasOwn(flags, token));
  return {
    all: tokens.includes('all') || unknown.length > 0,
    keys: new Set(tokens),
    unknown,
  };
}

/**
 * A flag's effective configuration right now: the registry entry with the
 * settings applied. Pure, so it is what the tests, the boot log and the admin
 * console all read.
 *
 * @returns {null | {
 *   key: string, kind: string, description: string, doc: string | null,
 *   percent: number, percentSource: 'default' | 'setting' | 'invalid',
 *   killed: boolean, start: Date | null, end: Date | null, endInvalid: boolean,
 *   variants: { name: string, weight: number }[] | null,
 *   newUsersOnly: boolean, guard: object | null, problems: string[],
 * }}
 */
export function readFlagConfig(key, { env = process.env, flags = FLAGS } = {}) {
  if (!Object.hasOwn(flags, key)) return null;
  const definition = flags[key];
  const problems = [];

  let percent = definition.rolloutPercent ?? 0;
  let percentSource = 'default';
  const rawPercent = env[flagEnvName(key, 'PERCENT')];
  if (rawPercent !== undefined && String(rawPercent).trim() !== '') {
    const parsed = parsePercent(rawPercent);
    if (parsed === null) {
      percent = 0;
      percentSource = 'invalid';
      problems.push(`${flagEnvName(key, 'PERCENT')} is not a whole number from 0 to 100; treated as 0`);
    } else {
      percent = parsed;
      percentSource = 'setting';
    }
  }

  const instant = (suffix, consequence) => {
    const raw = env[flagEnvName(key, suffix)];
    if (raw === undefined || String(raw).trim() === '') return { value: null, invalid: false };
    const value = parseInstant(raw);
    if (!value) {
      problems.push(
        `${flagEnvName(key, suffix)} is not an ISO-8601 time with a zone (2026-12-01T00:00:00Z); ${consequence}`,
      );
    }
    return { value, invalid: !value };
  };
  const startSetting = instant('START', 'nobody is eligible until it is fixed');
  // An END that was set and did not parse must not become "no end": that
  // would silently reopen enrolment. `endInvalid` closes it instead.
  const endSetting = instant('END', 'enrolment is closed until it is fixed');
  const start = startSetting.value;
  const end = endSetting.value;
  if (start && end && end <= start) {
    problems.push(`${flagEnvName(key, 'END')} is not after ${flagEnvName(key, 'START')}; nobody is eligible`);
  }

  if (definition.kind === 'experiment' && definition.newUsersOnly && !start && !startSetting.invalid && percent > 0) {
    problems.push(`${flagEnvName(key, 'START')} is not set; nobody is eligible until it is`);
  }

  // A list that cannot be read excludes nobody it was meant to, so an
  // experiment enrols no one until it is fixed.
  const exclusions = readExclusions(env);
  const exclusionsInvalid = definition.kind === 'experiment' && exclusions.invalid.length > 0;
  if (exclusionsInvalid) {
    problems.push(
      `EXPERIMENT_EXCLUDE_IDS has an entry that is not a SoundCloud id (${exclusions.invalid.join(', ')}); ` +
      'nobody is enrolled until it is fixed',
    );
  }

  const kill = readKill(env, flags);
  if (kill.unknown.length) {
    problems.push(`FLAGS_KILL names no known flag (${kill.unknown.join(', ')}); every flag is off`);
  }

  return {
    key,
    kind: definition.kind,
    description: definition.description,
    doc: definition.doc ?? null,
    percent,
    percentSource,
    killed: kill.all || kill.keys.has(key),
    start,
    end,
    endInvalid: endSetting.invalid,
    excludedIds: exclusions.ids,
    exclusionsInvalid,
    variants: definition.variants ?? null,
    newUsersOnly: !!definition.newUsersOnly,
    guard: definition.guard ?? null,
    problems,
  };
}

/** Every flag's effective configuration, in registry order. */
export function describeFlags(options = {}) {
  const flags = options.flags ?? FLAGS;
  return Object.keys(flags).map((key) => readFlagConfig(key, options));
}

/**
 * Decide a flag for one user. Pure: no database, no clock but the `now` it is
 * given.
 *
 * `user` needs `soundcloudId`, and `createdAt` (first login) for an
 * experiment limited to new users.
 *
 * For an experiment, `enabled` means "this account is in the experiment's
 * population and gets the arm in `variant`" — it does not mean an exposure
 * has been recorded. lib/experiments.js does that, and adds the two checks
 * that need the database or the clock (already activated, enrolment window).
 *
 * @returns {{ enabled: boolean, variant: string | null, reason: string }}
 */
export function evaluateFlag(key, user, { env = process.env, flags = FLAGS } = {}) {
  const off = (reason) => ({ enabled: false, variant: null, reason });

  const config = readFlagConfig(key, { env, flags });
  if (!config) return off('unknown-flag');
  if (config.killed) return off('killed');

  const soundcloudId = Number(user?.soundcloudId);
  if (!Number.isSafeInteger(soundcloudId) || soundcloudId <= 0) return off('no-user');

  const { isAdmin } = accessFor(soundcloudId);

  if (config.kind === 'rollout') {
    // Admins are the stage before 10%: they have the feature at any percent,
    // including 0, until the flag is killed.
    if (isAdmin) return { enabled: true, variant: null, reason: 'admin' };
    if (config.percent <= 0) return off('rollout-0');
    if (bucketFor(key, soundcloudId) >= config.percent) return off('not-in-rollout');
    return { enabled: true, variant: null, reason: 'in-rollout' };
  }

  // Experiment.
  if (config.percent <= 0) return off('rollout-0');
  if (isAdmin) return off('excluded-admin');
  if (config.exclusionsInvalid) return off('invalid-exclusions');
  if (config.excludedIds.includes(soundcloudId)) return off('excluded-id');

  if (config.newUsersOnly) {
    if (!config.start) return off('no-start');
    if (config.endInvalid) return off('invalid-end');
    const firstLogin = user?.createdAt ? new Date(user.createdAt) : null;
    if (!firstLogin || Number.isNaN(firstLogin.getTime())) return off('no-first-login');
    if (firstLogin < config.start) return off('before-start');
    if (config.end && firstLogin >= config.end) return off('after-end');
  }

  if (bucketFor(key, soundcloudId) >= config.percent) return off('not-in-rollout');

  return { enabled: true, variant: variantFor(key, soundcloudId, flags), reason: 'eligible' };
}

/** True for a rollout flag this user has. The gate a route or a page uses. */
export function isFlagEnabled(key, user, options = {}) {
  const flags = options.flags ?? FLAGS;
  if (flags[key]?.kind !== 'rollout') return false;
  return evaluateFlag(key, user, options).enabled;
}

/**
 * What /api/auth/me tells the page: the rollout flags this user has, and the
 * experiments whose exposure route is worth calling. With every flag at 0%
 * both are empty, so the page makes no extra request.
 */
export function flagsForUser(user, options = {}) {
  const flags = options.flags ?? FLAGS;
  const enabled = [];
  const experiments = [];
  for (const key of Object.keys(flags)) {
    if (!evaluateFlag(key, user, options).enabled) continue;
    (flags[key].kind === 'rollout' ? enabled : experiments).push(key);
  }
  return { flags: enabled, experiments };
}

/** True while a user first seen at `firstLogin` can still be enrolled. */
export function withinEnrolmentWindow(firstLogin, now = Date.now()) {
  const first = new Date(firstLogin).getTime();
  return Number.isFinite(first) && now < first + ACTIVATION_WINDOW_DAYS * DAY_MS;
}

/**
 * One line per flag at boot, so the App Service log records what each restart
 * was running with. A settings change restarts the app, so this is also the
 * history of every percent a flag has been at.
 */
export function logFlagConfig(options = {}) {
  for (const config of describeFlags(options)) {
    const parts = [
      config.kind,
      config.killed ? 'KILLED' : `rollout ${config.percent}% (${config.percentSource})`,
    ];
    if (config.kind === 'experiment') {
      parts.push(`start ${config.start ? config.start.toISOString() : 'unset'}`);
      parts.push(`end ${config.end ? config.end.toISOString() : 'unset'}`);
    }
    logger.info(`[flags] ${config.key}: ${parts.join(', ')}`);
    for (const problem of config.problems) logger.warn(`[flags] ${config.key}: ${problem}`);
  }
}
