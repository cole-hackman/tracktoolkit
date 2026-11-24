import express from 'express';
import logger from '../lib/logger.js';
import { safeError } from '../lib/safe-error.js';
import { authenticateUser } from '../middleware/auth.js';
import { validateExperimentExposure } from '../middleware/validation.js';
import { resolveExposure } from '../lib/experiments.js';

const router = express.Router();

/**
 * POST /api/experiments/exposure  { key }
 *
 * The page calls this at the moment it is about to render the part of the UI
 * an experiment changes, and renders what it is told. The answer is the arm
 * this account is in, and the first such call for an eligible account is what
 * records the exposure (lib/experiments.js, resolveExposure).
 *
 *   { key, enrolled, variant, activated }
 *
 * Anyone not in the experiment gets `{ enrolled: false, variant: null }` and
 * nothing is written: an unknown key, a killed or 0% flag, an admin, an
 * account outside the cohort or the rollout, one that has already completed a
 * write, or one past its enrolment window. The page treats that, and any
 * failure of this request, as control.
 *
 * The page only calls it for keys /api/auth/me listed under `experiments`, so
 * with every flag at 0% it is never called at all.
 *
 * A POST with a JSON body on purpose: it writes, so it sits behind both CSRF
 * layers (rejectUntrustedOrigin, and a validator that a form-encoded body
 * cannot satisfy). The validator runs before anything else.
 */
router.post('/exposure', authenticateUser, validateExperimentExposure, async (req, res) => {
  const { key } = req.body;
  try {
    const result = await resolveExposure(key, req.user);
    res.json({ key, ...result });
  } catch (error) {
    // Nothing was recorded, so nothing may be shown: the page falls back to
    // control on any non-2xx.
    logger.error('[experiments] exposure failed:', safeError(error));
    res.status(500).json({ error: 'Could not resolve the experiment' });
  }
});

export default router;
