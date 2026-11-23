import crypto from 'crypto';
import express from 'express';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { safeError } from '../lib/safe-error.js';
import { extractClientInfo } from '../lib/analytics.js';
import { authenticateUser } from '../middleware/auth.js';
import { stripControlChars, validateFeedback, validateRebrandVote } from '../middleware/validation.js';
import { feedbackDailyLimiter, feedbackHourlyLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

/**
 * The rebrand name vote — CONCLUDED. Track Toolkit won, and the product now
 * ships under that name, so there is nothing left to vote on.
 *
 * The vote is closed in code rather than by an environment variable: the
 * client-side modal is gone, and a vote arriving after the decision would be
 * recorded against a question nobody is asking any more. `SURVEY_ENABLED` can
 * still switch a FUTURE campaign off without a redeploy; it can no longer
 * switch this one back on.
 *
 * Everything already collected is untouched. `RebrandVote` rows stay, and the
 * admin read paths (/api/admin/rebrand and /api/admin/rebrand/summary) still
 * serve the full tally and both write-in fields. Same posture as the retired
 * SongSwipe beta survey (BetaSignup) and the monetization survey before it
 * (SurveyResponse) — read-only for history.
 */
const REBRAND_VOTE_CONCLUDED = true;

/** The name the vote settled on, echoed to clients so a stale build can tell
 *  why the prompt is gone rather than silently retrying. */
const REBRAND_WINNING_NAME = 'Track Toolkit';

function getCampaignId() {
  return process.env.SURVEY_CAMPAIGN_ID || '2026-rebrand-name-v1';
}

function isSurveyEnabled() {
  if (REBRAND_VOTE_CONCLUDED) return false;
  return String(process.env.SURVEY_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function cleanStr(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return max ? trimmed.slice(0, max) : trimmed;
}

/**
 * GET /api/feedback/survey/status
 * Returns whether the current user has already voted in the current campaign,
 * plus campaign identity and the global kill switch.
 */
router.get('/survey/status', authenticateUser, async (req, res) => {
  try {
    const campaignId = getCampaignId();
    const enabled = isSurveyEnabled();

    const existing = await prisma.rebrandVote.findUnique({
      where: { userId_campaignId: { userId: req.user.id, campaignId } },
      select: { id: true, createdAt: true },
    });

    res.json({
      enabled,
      concluded: REBRAND_VOTE_CONCLUDED,
      decidedName: REBRAND_VOTE_CONCLUDED ? REBRAND_WINNING_NAME : null,
      campaignId,
      submitted: !!existing,
      submittedAt: existing?.createdAt ?? null,
    });
  } catch (error) {
    logger.error('survey status error', safeError(error));
    res.status(500).json({ error: 'Failed to load survey status' });
  }
});

/**
 * POST /api/feedback/survey
 * Records a single rebrand vote per user per campaign.
 *
 * `validateRebrandVote` deliberately still runs BEFORE the closed-campaign
 * check. It is what makes a cross-site form post fail with a 400 rather than
 * reaching the handler at all, which is the invariant
 * tests/routes/feedback-authz.test.js guards — see the CSRF section of
 * docs/SECURITY.md. Moving the gate in front of it would quietly retire that
 * coverage along with the vote.
 */
router.post('/survey', authenticateUser, validateRebrandVote, async (req, res) => {
  try {
    if (REBRAND_VOTE_CONCLUDED) {
      return res.status(410).json({
        error: `The name vote has closed — the winner was ${REBRAND_WINNING_NAME}.`,
        concluded: true,
        decidedName: REBRAND_WINNING_NAME,
      });
    }
    if (!isSurveyEnabled()) {
      return res.status(403).json({ error: 'Survey is currently disabled' });
    }

    const campaignId = getCampaignId();
    const { nameChoice, nameIdea, featureIdea, context } = req.body;

    try {
      const created = await prisma.rebrandVote.create({
        data: {
          userId: req.user.id,
          soundcloudId: req.user.soundcloudId,
          campaignId,
          nameChoice,
          nameIdea: cleanStr(nameIdea, 120),
          featureIdea: cleanStr(featureIdea, 2000),
          context,
        },
        select: { id: true, createdAt: true },
      });

      logger.info('rebrand vote recorded', {
        userId: req.user.id,
        campaignId,
        nameChoice,
        context,
      });

      return res.status(201).json({ success: true, id: created.id, campaignId });
    } catch (err) {
      // Prisma unique constraint violation → already voted in this campaign
      if (err && err.code === 'P2002') {
        return res.status(409).json({ error: 'Already submitted for this campaign', campaignId });
      }
      throw err;
    }
  } catch (error) {
    logger.error('survey submit error', safeError(error));
    res.status(500).json({ error: 'Failed to submit survey response' });
  }
});

/* ------------------------------------------------------------------------ *
 * In-app feedback — the live "Send feedback" form.
 *
 * Distinct from everything above it in this file: the survey routes are a
 * retired name vote kept for history, this is the thing users actually reach
 * today. Login-required, stored in Postgres, and it goes nowhere else — no
 * email delivery, no webhook, no third-party widget.
 * ------------------------------------------------------------------------ */

/** 24 hours, in ms — the window the duplicate check looks back over. */
const FEEDBACK_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many of their own submissions GET /mine hands back. */
const FEEDBACK_MINE_LIMIT = 20;

/**
 * The dedupe key: whitespace-collapsed, lowercased, trimmed, then sha256'd.
 * Hashing rather than comparing the text keeps the index narrow and means the
 * lookup never has to put the message itself in a query.
 */
function hashMessage(message) {
  const normalized = message.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * POST /api/feedback
 *
 * Middleware order is load-bearing: `validateFeedback` runs BEFORE the two
 * limiters. A cross-site form-encoded post parses to an empty req.body under
 * express.json() and dies at the validator with a 400 — the same fail-closed
 * CSRF invariant the survey route above relies on. Putting the limiters first
 * would also let a forged request burn a real user's feedback budget.
 */
router.post(
  '/',
  authenticateUser,
  validateFeedback,
  feedbackHourlyLimiter,
  feedbackDailyLimiter,
  async (req, res) => {
    try {
      const { type, message, page, email, website } = req.body;

      // Honeypot. A real form leaves `website` empty because the field is
      // hidden; anything that fills it in is automation. The answer is a
      // plain 202 with no row written — indistinguishable from success, so a
      // bot has nothing to tune against. Debug-only counter: logging it at
      // info level would hand spam a way to fill the log instead of the table.
      if (typeof website === 'string' && website.trim() !== '') {
        logger.debug('feedback honeypot tripped', { userId: req.user.id });
        return res.status(202).json({ accepted: true });
      }

      // `validateFeedback` already stripped and trimmed this — deliberately
      // before its length check, so ten control characters cannot pass
      // `min: 10` and then collapse to nothing. Repeated here as
      // belt-and-braces: this line is the last thing between user text and
      // the database, and it must not depend on a particular validator
      // staying mounted in front of it. Idempotent, so the second pass is
      // free.
      const cleanMessage = stripControlChars(message);
      const messageHash = hashMessage(cleanMessage);

      // Same person, same message, inside a day → almost always a double
      // submit, or someone re-sending because nothing visibly happened. The
      // window is enforced here rather than by a unique index on purpose: the
      // same report weeks later is legitimate and should land.
      const duplicate = await prisma.feedback.findFirst({
        where: {
          userId: req.user.id,
          messageHash,
          createdAt: { gte: new Date(Date.now() - FEEDBACK_DEDUPE_WINDOW_MS) },
        },
        select: { id: true },
      });
      if (duplicate) {
        return res.status(409).json({ error: 'You already sent this recently' });
      }

      const created = await prisma.feedback.create({
        data: {
          // From the session, never from the body. A client-supplied userId or
          // soundcloudId is ignored outright.
          userId: req.user.id,
          soundcloudId: req.user.soundcloudId,
          type,
          message: cleanMessage,
          page: page || null,
          email: email || null,
          clientInfo: extractClientInfo(req),
          messageHash,
        },
        select: { id: true, createdAt: true },
      });

      // Deliberately no message and no email in the log line. Both are user
      // content, and the log is the one place they have no reason to be.
      logger.info('feedback received', { userId: req.user.id, type });

      return res.status(201).json({ id: created.id, createdAt: created.createdAt });
    } catch (error) {
      logger.error('feedback submit error', safeError(error));
      return res.status(500).json({ error: 'Failed to submit feedback' });
    }
  }
);

/**
 * GET /api/feedback/mine
 * The user's own last 20 submissions, so the form can show that something was
 * received and where it got to. `adminNote` is not selected — it is internal
 * triage, and the user is not its audience.
 */
router.get('/mine', authenticateUser, async (req, res) => {
  try {
    const items = await prisma.feedback.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: FEEDBACK_MINE_LIMIT,
      select: { id: true, type: true, page: true, status: true, createdAt: true },
    });

    res.json({ items });
  } catch (error) {
    logger.error('feedback mine error', safeError(error));
    res.status(500).json({ error: 'Failed to load your feedback' });
  }
});

export default router;
