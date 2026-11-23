/**
 * Boot-time check that the database actually has the schema this build expects.
 *
 * WHY THIS EXISTS. On 2026-09-23 a deploy shipped code that reads
 * `users."lastLoginAt"` before the additive SQL in `docs/sql/` had been applied.
 * Nothing noticed at boot. The first person to sign in got
 * `/login/?error=callback_failed`, and every authenticated request 500'd, because
 * `authenticateUser` reads the same row — a full auth outage discovered by a user
 * rather than by the deploy. The pull request said in bold to apply the SQL
 * first; a warning in a description is not a gate, which is the whole point of
 * this file.
 *
 * WHAT IT CHECKS. Every model in the Prisma client, by asking Postgres directly
 * whether the table and each of its columns exist. It is derived from the client
 * rather than from a hand-kept list, because a hand-kept list of "things to
 * check" goes stale in exactly the direction that hurts: someone adds a column,
 * forgets the list, and the check keeps reporting success over something it
 * cannot see. This codebase has been bitten by that shape repeatedly.
 *
 * WHAT IT DOES ABOUT IT. Missing objects are fatal: the process logs what is
 * missing, which file creates it, and exits non-zero. A broken deploy should be
 * visibly broken at boot, not silently half-working — and exiting also stops the
 * retention scheduler, which deletes accounts, from ever running against a
 * half-migrated database.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not treat an unreachable database as
 * a schema failure. The server has always started without one (the static site
 * serves fine, individual requests fail), and exiting on a connection blip would
 * turn a transient upstream problem into a restart loop. Unreachable is a loud
 * warning; reachable-but-wrong is fatal. Distinguishing those two is most of the
 * value here.
 */

import prisma from './prisma.js';
import logger from './logger.js';

/**
 * Where each table comes from, so the failure names the fix rather than just the
 * symptom. A table absent from this map still fails the boot — it just says
 * "check prisma/schema.prisma and docs/sql/" instead of naming one file.
 */
const TABLE_SOURCE = {
  users: 'docs/sql/2026-09-account-lifecycle.sql (lastLoginAt, disconnectedAt)',
  metrics: 'docs/sql/2026-09-account-lifecycle.sql',
  feedback: 'docs/sql/2026-09-feedback.sql',
  library_cache_pages: 'docs/sql/2026-library-cache.sql',
  library_cache_states: 'docs/sql/2026-library-cache.sql',
  rebrand_votes: 'docs/sql/2026-rebrand-votes.sql',
  experiment_exposures: 'docs/sql/2026-11-experiment-exposures.sql',
};

/**
 * Tables owned by `feature/ai-library-chat`. They are declared in
 * `prisma/schema.prisma` so that a `prisma db push` from this branch does not
 * drop them, which means the Prisma client knows about them whether or not this
 * deployment has them.
 *
 * They are reported but NOT fatal. The reasoning is specific rather than
 * general: this server touches them only in the account-deletion cascade and the
 * data export, so a missing one costs those two paths and nothing else — and
 * making them fatal would let another branch's migration state decide whether
 * this one can boot at all. `tests/schema-preflight.test.js` asserts every name
 * here is still a real model, so this list cannot rot into silently excusing a
 * table that matters.
 */
const NON_FATAL_TABLES = new Set([
  'chat_conversations',
  'chat_messages',
  'indexed_likes',
  'indexed_playlist_tracks',
  'library_snapshots',
]);

/** Prisma's own properties on the client — not models. */
const NOT_A_MODEL = /^(\$|_|constructor$)/;

/**
 * The tables and columns Prisma will address, read from the client's runtime
 * data model so it cannot disagree with what the queries actually do.
 *
 * `dmmf` is internal API. If a Prisma upgrade moves it, `expectedSchema` throws
 * and the boot fails loudly rather than quietly checking nothing — which is the
 * safe direction for a guard whose entire job is noticing absence.
 */
export function expectedSchema(client = prisma) {
  const datamodel = client?._runtimeDataModel?.models;
  if (!datamodel || typeof datamodel !== 'object') {
    throw new Error(
      'schema-preflight: cannot read the Prisma runtime data model. ' +
      'A Prisma upgrade probably moved it. Fix this rather than skipping the ' +
      'check — a guard that silently checks nothing is worse than no guard.'
    );
  }

  return Object.entries(datamodel)
    .filter(([name]) => !NOT_A_MODEL.test(name))
    .map(([name, model]) => ({
      model: name,
      table: model.dbName || name,
      columns: (model.fields || [])
        .filter((f) => f.kind === 'scalar' || f.kind === 'enum')
        .map((f) => f.dbName || f.name),
    }));
}

/**
 * Ask Postgres what it actually has. One query for every table at once rather
 * than one per table: this runs on the hot path of every cold start.
 */
async function actualColumns(client, tables) {
  const rows = await client.$queryRawUnsafe(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    tables
  );

  const byTable = new Map();
  for (const { table_name: table, column_name: column } of rows) {
    if (!byTable.has(table)) byTable.set(table, new Set());
    byTable.get(table).add(column);
  }
  return byTable;
}

/**
 * Compare expectation against reality. Pure, so the tests can drive it without a
 * database and without mocking a process exit.
 *
 * @returns {{fatal: string[], tolerated: string[]}} human-readable problems.
 */
export function diffSchema(expected, present) {
  const fatal = [];
  const tolerated = [];

  for (const { model, table, columns } of expected) {
    const bucket = NON_FATAL_TABLES.has(table) || NON_FATAL_TABLES.has(model)
      ? tolerated
      : fatal;
    const found = present.get(table);

    if (!found) {
      const source = TABLE_SOURCE[table] || 'prisma/schema.prisma and docs/sql/';
      bucket.push(`table "${table}" (model ${model}) is missing — see ${source}`);
      continue;
    }

    // Report every missing column, not just the first. Someone fixing this at
    // 3am should get the whole list in one pass rather than one per redeploy.
    const missing = columns.filter((c) => !found.has(c));
    if (missing.length) {
      const source = TABLE_SOURCE[table] || 'prisma/schema.prisma and docs/sql/';
      bucket.push(
        `table "${table}" is missing column(s) ${missing.map((c) => `"${c}"`).join(', ')} — see ${source}`
      );
    }
  }

  return { fatal, tolerated };
}

/**
 * Run the check. Resolves when the schema is good enough to serve; calls `exit`
 * when it is not.
 *
 * `exit` and `client` are injectable so the tests can assert the exit rather
 * than taking the test runner down with it.
 */
export async function verifySchema({ client = prisma, exit = process.exit } = {}) {
  const expected = expectedSchema(client);

  let present;
  try {
    present = await actualColumns(client, expected.map((e) => e.table));
  } catch (error) {
    // Reachability, not correctness. Say so plainly: an operator reading this
    // line needs to know the schema was NOT verified, not just that something
    // went wrong.
    logger.warn(
      '[schema-preflight] could not reach the database; schema NOT verified. ' +
      'Starting anyway — a connection problem is not a migration problem. ' +
      `Cause: ${error?.message || error}`
    );
    return { verified: false, fatal: [], tolerated: [] };
  }

  const { fatal, tolerated } = diffSchema(expected, present);

  for (const problem of tolerated) {
    logger.warn(
      `[schema-preflight] ${problem}. Tolerated: this table belongs to another ` +
      'branch and only the account-deletion cascade and the data export read it.'
    );
  }

  if (fatal.length) {
    logger.error(
      `[schema-preflight] REFUSING TO START — the database is missing ${fatal.length} ` +
      'object(s) this build requires:'
    );
    for (const problem of fatal) logger.error(`[schema-preflight]   - ${problem}`);
    logger.error(
      '[schema-preflight] Apply the SQL above to the Azure PostgreSQL database ' +
      '`tracktoolkit` (not Neon), then redeploy. Every file in docs/sql/ is ' +
      'additive and safe to run twice.'
    );
    exit(1);
    // `exit` is injectable, and a stub returns. Returning here keeps a test
    // double from falling through into a "verified" result it did not earn.
    return { verified: false, fatal, tolerated };
  }

  logger.info(
    `[schema-preflight] ${expected.length - tolerated.length} table(s) verified` +
    (tolerated.length ? `; ${tolerated.length} tolerated` : '')
  );
  return { verified: true, fatal: [], tolerated };
}

export const __testing = { NON_FATAL_TABLES, TABLE_SOURCE };
