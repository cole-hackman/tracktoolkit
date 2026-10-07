import express from 'express';
import { existsSync } from 'fs';
import { join, resolve, sep } from 'path';

/**
 * Resolves a request path (still percent-encoded, exactly as Express's
 * `req.path` reports it — `parseurl`/`url.parse` does not decode or
 * collapse `..` segments) to an absolute file path inside `buildPath`.
 *
 * `res.sendFile` only guards against `..` traversal when called with a
 * `root` option; handed an absolute path (as the two HTML lookups below
 * do, so a miss can fall through to the 404 branch) it will happily
 * resolve and serve anything readable on disk. This is the single choke
 * point both lookups go through instead of each hand-rolling the check.
 *
 * @returns the resolved absolute path if it stays inside `buildPath`,
 *   or `null` if it resolves outside (a traversal attempt, encoded or
 *   not). Throws a `URIError` if `reqPath` cannot be percent-decoded —
 *   callers are expected to answer that with 400, not 404.
 */
function resolveWithin(buildPath, reqPath) {
  const decoded = decodeURIComponent(reqPath);
  const root = resolve(buildPath);
  const candidate = resolve(buildPath, '.' + decoded);
  if (candidate === root || candidate.startsWith(root + sep)) {
    return candidate;
  }
  return null;
}

// Content-hashed build output: a new deploy writes new filenames, so a cached
// copy can never be wrong and never needs revalidating.
const IMMUTABLE = 'public, max-age=31536000, immutable';
// Route HTML and the RSC payloads beside it (`<route>/index.txt`) keep the
// same name across deploys while naming that deploy's hashed chunks. Cached
// for a day, a browser that visited before a deploy fed its stale payload to
// the new chunks after it: the client router threw `e[o] is not a function`
// and fell back to a hard navigation to the raw `/dashboard/index.txt`.
// `no-cache` still lets the browser keep the file — it revalidates against
// the ETag on every use, which costs a 304, not a download.
const REVALIDATE = 'no-cache';

function cacheControlFor(filePath, hashedDir) {
  if (filePath.startsWith(hashedDir)) return IMMUTABLE;
  if (filePath.endsWith('.html') || filePath.endsWith('.txt')) return REVALIDATE;
  return null;
}

/**
 * Mounts the Next.js static export (`frontend-UI/out`) onto an Express app.
 *
 * Applies, in order, to every non-`/api/`, non-`/health` GET/HEAD request:
 *   1. A hit in `aliases` (request path, trailing slash normalized away) ->
 *      301 redirect to the mapped target. Lets retired paths
 *      (`/sc-toolkit`, `/soundcloud-toolkit`, `/rebrand`) point somewhere
 *      useful instead of soft-404ing.
 *   2. `express.static` — real files (JS/CSS/images/etc.) served as-is.
 *      (`serve-static`/`send` already confine this to `buildPath`.)
 *   3. `<path>/index.html` — a Next.js static-export route.
 *   4. `<path>.html` — same, without the trailing slash.
 *   5. `404.html`, served with a real HTTP 404 status (not 200) if it
 *      exists; otherwise `next()` so anything mounted after this call still
 *      gets a chance (e.g. the API-only fallback in server/index.js is a
 *      separate branch entirely and never reaches this code).
 * Lookups 3 and 4 are confined to `buildPath` via `resolveWithin` above —
 * a `..` segment (raw or percent-encoded) in the request path falls
 * through to the same 404 branch rather than escaping the build directory.
 *
 * @param {import('express').Express} app
 * @param {string} buildPath - absolute path to the static export directory
 * @param {{ aliases?: Record<string, string> }} [options]
 */
export function mountStaticSite(app, buildPath, { aliases = {} } = {}) {
  // 1. Redirect aliases (checked before anything else so a stale link never
  // has to depend on there being no real file at that path).
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/health') return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const normalizedPath =
      req.path.length > 1 && req.path.endsWith('/') ? req.path.slice(0, -1) : req.path;
    const target = aliases[normalizedPath];
    if (target) {
      return res.redirect(301, target);
    }
    next();
  });

  // 2. Real static files from the Next.js build.
  const hashedDir = join(resolve(buildPath), '_next', 'static') + sep;
  app.use(
    express.static(buildPath, {
      maxAge: '1d',
      etag: true,
      setHeaders: (res, filePath) => {
        const value = cacheControlFor(filePath, hashedDir);
        if (value) res.setHeader('Cache-Control', value);
      },
    })
  );

  // 3-5. Next.js route HTML, falling back to a real 404.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/health') {
      return next();
    }

    let htmlFile;
    let exactHtmlFile;
    try {
      // Next.js static export writes folder/index.html for each route.
      const pagePath = req.path.endsWith('/') ? req.path : req.path + '/';
      htmlFile = resolveWithin(buildPath, pagePath + 'index.html');

      // Or, less commonly, path.html directly.
      exactHtmlFile = resolveWithin(buildPath, req.path + '.html');
    } catch {
      // Malformed percent-encoding (e.g. a lone "%") — not a traversal
      // attempt, just an invalid request path.
      return res.status(400).send('Bad request');
    }

    // `cacheControl: false` stops `send` overwriting the header set here.
    const htmlOptions = { headers: { 'Cache-Control': REVALIDATE }, cacheControl: false };

    if (htmlFile && existsSync(htmlFile)) {
      return res.sendFile(htmlFile, htmlOptions);
    }

    if (exactHtmlFile && existsSync(exactHtmlFile)) {
      return res.sendFile(exactHtmlFile, htmlOptions);
    }

    // Unknown path (including anything resolveWithin rejected as outside
    // buildPath): serve the branded 404 page with a real 404 status.
    const notFoundFile = join(buildPath, '404.html');
    if (existsSync(notFoundFile)) {
      return res.status(404).sendFile(notFoundFile, htmlOptions);
    }

    next();
  });
}

export default mountStaticSite;
