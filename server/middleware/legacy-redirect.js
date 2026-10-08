/**
 * Redirect retired hostnames to the canonical origin.
 *
 * After the tracktoolkit.com cutover the old soundcloudtoolkit.com hosts
 * (apex, www, api) stay bound to the same App Service so that Express — not a
 * separate Front Door profile or stub app — answers the 301s. GET/HEAD get a
 * 301; every other method gets a 308 so a stale client posting to
 * api.soundcloudtoolkit.com keeps its method and body.
 *
 * Config: LEGACY_REDIRECT_HOSTS (comma-separated hostnames, case-insensitive)
 * and APP_URL (the canonical origin). Unset list, missing APP_URL, or a
 * request already on the canonical host → passthrough, so the middleware is
 * always safe to mount.
 */

export function parseLegacyHosts(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Pure decision: returns `{ status, location }` or null.
 * @param {{ hostname: string, method: string, originalUrl: string }} req
 * @param {{ LEGACY_REDIRECT_HOSTS?: string, APP_URL?: string }} env
 */
export function resolveLegacyRedirect(req, env = process.env) {
  const hosts = parseLegacyHosts(env.LEGACY_REDIRECT_HOSTS);
  if (hosts.size === 0 || !env.APP_URL) return null;

  let canonical;
  try {
    canonical = new URL(env.APP_URL);
  } catch {
    return null;
  }

  const host = String(req.hostname || '').toLowerCase();
  if (!host || host === canonical.hostname.toLowerCase() || !hosts.has(host)) return null;

  const method = String(req.method || 'GET').toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  const target = isRead ? withPageSlash(req.originalUrl || '/') : req.originalUrl || '/';
  return { status: isRead ? 301 : 308, location: `${canonical.origin}${target}` };
}

/**
 * Every page in the static export lives at a trailing-slash URL, so an old
 * `/faq` would otherwise take a second 301 (`/faq` -> `/faq/`) on the new
 * host. Files (a dot in the last segment), `/api/` and `/health` are left
 * exactly as requested.
 */
function withPageSlash(url) {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? '' : url.slice(q);
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  if (
    path.endsWith('/') ||
    lastSegment.includes('.') ||
    path.startsWith('/api/') ||
    path === '/api' ||
    path === '/health'
  ) {
    return url;
  }
  return `${path}/${query}`;
}

export function legacyHostRedirect(req, res, next) {
  const redirect = resolveLegacyRedirect(req);
  if (!redirect) return next();
  return res.redirect(redirect.status, redirect.location);
}
