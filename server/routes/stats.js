/**
 * Public, unauthenticated usage figures — the numbers behind the README badges.
 *
 * Everything here is read from the `metrics` table, never computed per
 * request: the retention job (lib/retention.js) writes both counters once a
 * day, before its deletes. So a request costs two primary-key reads however
 * often a badge service polls it, and the figures change once a day, which is
 * what the README says.
 *
 * Aggregates only. No per-user value, no per-action breakdown, nothing that
 * narrows below "everyone, all time" — anything added here is published.
 *
 * A counter the job has not written yet is `null`, not 0: "no data" must not
 * read as "no users".
 */
import express from 'express';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { safeError } from '../lib/safe-error.js';
import { LIFETIME_METRIC_KEY, TRACKS_METRIC_KEY } from '../lib/retention.js';

const router = express.Router();

/** The figures move daily; an hour of caching keeps badge polling off the
 *  database without holding a new figure back for long. */
const CACHE_SECONDS = 60 * 60;

const grouped = new Intl.NumberFormat('en-US');

/** Badge text. shields.io prints a JSON number as-is ("2032233"), so the
 *  grouped form is served alongside the raw one. */
const format = (value) => (value === null ? 'n/a' : grouped.format(value));

router.get('/public', async (req, res) => {
  try {
    const rows = await prisma.metric.findMany({
      where: { key: { in: [LIFETIME_METRIC_KEY, TRACKS_METRIC_KEY] } },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const read = (key) => (byKey.has(key) ? Number(byKey.get(key).value) : null);

    const lifetimeUsers = read(LIFETIME_METRIC_KEY);
    const tracksProcessed = read(TRACKS_METRIC_KEY);
    const stamps = rows.map((row) => row.updatedAt).filter(Boolean);
    const updatedAt = stamps.length
      ? new Date(Math.max(...stamps.map((d) => new Date(d).getTime()))).toISOString()
      : null;

    res.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
    res.json({
      lifetimeUsers,
      tracksProcessed,
      updatedAt,
      formatted: {
        lifetimeUsers: format(lifetimeUsers),
        tracksProcessed: format(tracksProcessed),
      },
    });
  } catch (error) {
    logger.error('Public stats error:', safeError(error));
    res.set('Cache-Control', 'no-store');
    res.status(503).json({ error: 'Stats unavailable' });
  }
});

export default router;
