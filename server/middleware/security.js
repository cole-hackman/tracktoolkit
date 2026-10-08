import helmet from 'helmet';
import logger from '../lib/logger.js';
import { safeError } from '../lib/safe-error.js';

/**
 * Content-Security-Policy directives shared by every page.
 *
 * Exported so `tests/security-headers.test.js` can assert the no-third-party
 * posture directly: the app loads no analytics, no tag manager and no external
 * fonts or widgets, so the only script and style sources are our own origin
 * plus `'unsafe-inline'`.
 *
 * `frameSrc` is `'none'` here and stays that way on every user-facing page.
 * The admin console is the single exception — see `securityHeaders` below.
 */
export const cspDirectives = {
  defaultSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  scriptSrc: ["'self'", "'unsafe-inline'"], // unsafe-inline required for Next.js static export bootstrap scripts
  imgSrc: ["'self'", "https:", "data:"], // Allow images from any HTTPS source
  connectSrc: [
    "'self'",
    "https://api.soundcloud.com",
    "https://secure.soundcloud.com",
    "https://api-v2.soundcloud.com",
    // The two hosts SoundCloud's download endpoint redirects to (the same
    // allowlist as isAllowedDownloadRedirectTarget): the Downloads page
    // fetches the file itself to save it under the track's name.
    "https://*.sndcdn.com",
    "https://*.cloudfront.net",
    "ws://localhost:*",
    "wss:",
  ],
  fontSrc: ["'self'", "data:"], // next/font self-hosts the webfonts into the static export
  objectSrc: ["'none'"],
  mediaSrc: ["'self'"],
  frameSrc: ["'none'"],
};

/** The one origin the admin console may frame: SoundCloud's embed player. */
export const ADMIN_FRAME_SRC = 'https://w.soundcloud.com';

function buildHelmet(directives) {
  return helmet({
    contentSecurityPolicy: { directives },
    crossOriginEmbedderPolicy: false, // Disable for SoundCloud embeds if needed
    crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow SoundCloud resources
  });
}

const defaultHeaders = buildHelmet(cspDirectives);
const adminHeaders = buildHelmet({ ...cspDirectives, frameSrc: [ADMIN_FRAME_SRC] });

/** True for the admin console document and its sub-paths, never for /api. */
export function isAdminPagePath(path) {
  return path === '/admin' || path.startsWith('/admin/');
}

/**
 * Security headers middleware. Every response gets the base policy; only
 * the admin console document (`/admin`, `/admin/`) gets `frame-src` opened
 * to the SoundCloud player. A CSP governs the document it is served with,
 * so widening it here cannot affect any other page.
 */
export const securityHeaders = (req, res, next) => {
  if (isAdminPagePath(req.path)) return adminHeaders(req, res, next);
  return defaultHeaders(req, res, next);
};


/**
 * Middleware to prevent API key leakage in error responses
 */
export const preventKeyLeakage = (req, res, next) => {
  const originalJson = res.json.bind(res);
  
  res.json = function(data) {
    // Remove any potential secrets from response
    if (data && typeof data === 'object') {
      const sanitized = JSON.parse(JSON.stringify(data));
      removeSecrets(sanitized);
      return originalJson(sanitized);
    }
    return originalJson(data);
  };
  
  next();
};

/**
 * Recursively remove potential secrets from objects
 */
function removeSecrets(obj) {
  if (!obj || typeof obj !== 'object') return;
  
  const secretKeys = [
    'password',
    'secret',
    'token',
    'key',
    'api_key',
    'client_secret',
    'access_token',
    'refresh_token',
    'encryption_key',
    'session_secret',
  ];
  
  for (const key in obj) {
    const lowerKey = key.toLowerCase();
    
    // Check if key contains secret-related terms
    if (secretKeys.some(secret => lowerKey.includes(secret))) {
      // Don't remove if it's a public identifier like 'client_id' in public context
      if (lowerKey === 'client_id' && typeof obj[key] === 'string') {
        // Keep client_id but ensure it's not a secret
        continue;
      }
      // Remove or mask the value
      delete obj[key];
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      removeSecrets(obj[key]);
    }
  }
}

/**
 * Validate URL format
 */
function isValidUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Middleware to validate environment variables are set and properly formatted
 */
export const validateEnv = (req, res, next) => {
  const errors = [];
  
  // Required environment variables with validation rules
  const requiredEnvVars = {
    'SOUNDCLOUD_CLIENT_ID': {
      required: true,
      validate: (value) => {
        if (!value || value.trim().length === 0) {
          return 'SOUNDCLOUD_CLIENT_ID cannot be empty';
        }
        return null;
      }
    },
    'SOUNDCLOUD_CLIENT_SECRET': {
      required: true,
      validate: (value) => {
        if (!value || value.trim().length === 0) {
          return 'SOUNDCLOUD_CLIENT_SECRET cannot be empty';
        }
        if (value.length < 8) {
          return 'SOUNDCLOUD_CLIENT_SECRET must be at least 8 characters';
        }
        return null;
      }
    },
    'SOUNDCLOUD_REDIRECT_URI': {
      required: true,
      validate: (value) => {
        if (!value || value.trim().length === 0) {
          return 'SOUNDCLOUD_REDIRECT_URI cannot be empty';
        }
        if (!isValidUrl(value)) {
          return 'SOUNDCLOUD_REDIRECT_URI must be a valid HTTP/HTTPS URL';
        }
        return null;
      }
    },
    'ENCRYPTION_KEY': {
      required: true,
      validate: (value) => {
        if (!value || value.trim().length === 0) {
          return 'ENCRYPTION_KEY cannot be empty';
        }
        if (value.length !== 32) {
          return 'ENCRYPTION_KEY must be exactly 32 characters';
        }
        return null;
      }
    },
    'SESSION_SECRET': {
      required: true,
      validate: (value) => {
        if (!value || value.trim().length === 0) {
          return 'SESSION_SECRET cannot be empty';
        }
        if (value.length < 32) {
          return 'SESSION_SECRET must be at least 32 characters';
        }
        return null;
      }
    },
    'DATABASE_URL': {
      required: true,
      validate: (value) => {
        if (!value || value.trim().length === 0) {
          return 'DATABASE_URL cannot be empty';
        }
        // Basic validation - should start with postgresql:// or similar
        if (!value.match(/^[a-z]+:\/\//i)) {
          return 'DATABASE_URL must be a valid database connection string';
        }
        return null;
      }
    }
  };
  
  // Check each required variable
  for (const [key, config] of Object.entries(requiredEnvVars)) {
    const value = process.env[key];
    
    if (config.required && !value) {
      errors.push(`${key} is required but not set`);
      continue;
    }
    
    if (value && config.validate) {
      const validationError = config.validate(value);
      if (validationError) {
        errors.push(validationError);
      }
    }
  }
  
  if (errors.length > 0) {
    logger.error('Environment variable validation failed:', errors);
    
    return res.status(500).json({
      error: 'Server configuration error',
      message: 'Server is not properly configured. Check environment variables.'
    });
  }
  
  next();
};


/**
 * Is this Origin allowed to make credentialed state-changing requests?
 * Mirrors the CORS allowlist in server/index.js. Parsed fresh per call
 * (same pattern as adminAuth) so env changes apply without restart.
 */
export function isTrustedOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.hostname === 'localhost') return true;

  const allowed = (process.env.APP_URLS || process.env.APP_URL || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (allowed.includes(origin)) return true;

  const allowedHostnames = allowed
    .map((o) => { try { return new URL(o).hostname; } catch { return null; } })
    .filter(Boolean);
  if (allowedHostnames.includes(url.hostname)) return true;

  const extensionOrigins = (process.env.CHROME_EXTENSION_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => `chrome-extension://${id}`);
  return extensionOrigins.includes(origin);
}

/**
 * CSRF defense-in-depth. Today CSRF is prevented "by accident": express.json()
 * is the only body parser, so a cross-site HTML form (urlencoded/text-plain,
 * no preflight) yields an empty req.body and every mutating route's validator
 * fails closed. That invariant is one express.urlencoded() away from breaking,
 * so this middleware makes the protection explicit: state-changing requests
 * bearing an untrusted Origin are rejected outright. Requests WITHOUT an
 * Origin header pass (same-origin navigations, curl, server-to-server).
 */
export function rejectUntrustedOrigin(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  if (isTrustedOrigin(origin)) return next();
  return res.status(403).json({ error: 'Origin not allowed' });
}
