import { accessFor } from '../lib/download-access.js';

/**
 * Server-side gate for the bulk download features. Must run after
 * authenticateUser (it reads req.user). Fails closed: no user, no allowlist
 * entry, no access.
 */
export function requireCanDownload(req, res, next) {
  if (!accessFor(req.user?.soundcloudId).canDownload) {
    return res.status(403).json({ error: 'Bulk downloads are limited to allow-listed accounts.' });
  }
  next();
}
