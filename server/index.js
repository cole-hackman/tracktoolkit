import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Prisma returns BigInt for BIGINT columns (growth_actions.targetId, catalog
// IDs). JSON.stringify throws on BigInt, so serialize them as numbers — every
// SoundCloud ID is far below Number.MAX_SAFE_INTEGER (2^53).
BigInt.prototype.toJSON = function () {
  return Number(this);
};

// Import security middleware
import { apiRateLimiter, authRateLimiter, heavyOperationRateLimiter, healthCheckRateLimiter } from './middleware/rateLimiter.js';
import { securityHeaders, preventKeyLeakage, validateEnv, rejectUntrustedOrigin } from './middleware/security.js';
import { legacyHostRedirect } from './middleware/legacy-redirect.js';
import { mountStaticSite } from './lib/static-site.js';
import logger from './lib/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createScMetrics } from './lib/token-context.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy for accurate IP addresses (needed for rate limiting behind proxies/load balancers)
// This allows req.ip to correctly reflect the client IP from X-Forwarded-For header
app.set('trust proxy', 1);

// Legacy-host 301s (soundcloudtoolkit.com → tracktoolkit.com) are answered
// here, so the retired hostnames are just extra bindings on this same app and
// no Front Door profile or stub app is needed. First in the chain: nothing
// else should run for a request that is only here to be redirected. A no-op
// while LEGACY_REDIRECT_HOSTS is unset.
app.use(legacyHostRedirect);

// Path to Next.js static export
const FRONTEND_BUILD_PATH = join(__dirname, '..', 'frontend-UI', 'out');

// Security middleware - validate environment variables
app.use(validateEnv);

// Security headers
app.use(securityHeaders);

// Prevent API key leakage in responses
app.use(preventKeyLeakage);

// Middleware
const allowedOrigins = (
  process.env.APP_URLS ||
  [process.env.APP_URL, 'http://localhost:5173', 'http://localhost:4173']
    .filter(Boolean)
    .join(',')
)
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// Also allow by hostname to be resilient to protocol/canonical differences
const allowedHostnames = allowedOrigins
  .map((o) => {
    try { return new URL(o).hostname; } catch { return null; }
  })
  .filter(Boolean);

// Chrome extension credentialed fetches send Origin: chrome-extension://<id>
const chromeExtensionOrigins = (process.env.CHROME_EXTENSION_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
  .map((id) => `chrome-extension://${id}`);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    try {
      const u = new URL(origin);
      const host = u.hostname;
      if (host === 'localhost') return callback(null, true);
      if (chromeExtensionOrigins.includes(origin)) return callback(null, origin);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (allowedHostnames.includes(host)) return callback(null, true);
    } catch {}
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Response compression
app.use(compression());

// Lightweight request timing logger (helps spot slow endpoints).
// `sc=` is the number of SoundCloud round trips the request made — the metric
// that actually explains a slow endpoint, since wall time here is dominated by
// serial upstream calls rather than our own work.
app.use((req, res, next) => {
  const startedAtMs = Date.now();
  // Owned here, not read from AsyncLocalStorage: this listener is registered
  // before authenticateUser establishes the token context, so it would see an
  // empty store. authenticateUser passes this same bag into the context.
  req.scMetrics = createScMetrics();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAtMs;
    // Keep logs concise in production
    logger.info(`${res.statusCode} ${req.method} ${req.originalUrl} ${durationMs}ms sc=${req.scMetrics.scCalls}`);
  });
  next();
});

app.use(express.json());
app.use(cookieParser());

// CSRF defense-in-depth: see rejectUntrustedOrigin doc comment.
app.use('/api', rejectUntrustedOrigin);

// Import routes
import authRoutes from './routes/auth.js';
import { soundcloudClient } from './lib/soundcloud-client.js';
import { startGrowthScheduler } from './lib/growth-scheduler.js';
import { startRetentionScheduler } from './lib/retention.js';
import { verifySchema } from './lib/schema-preflight.js';
import apiRoutes from './routes/api.js';
import growthRoutes from './routes/growth.js';
import adminRoutes from './routes/admin.js';
import feedbackRoutes from './routes/feedback.js';
import statsRoutes from './routes/stats.js';

// Stricter OAuth rate limiting only where brute-force matters (/login + /callback).
// /auth/me runs on every app load; coupling it to the OAuth limit broke sessions for heavy users.
app.use('/api/auth', (req, res, next) => {
  if (req.path === '/login' || req.path === '/callback') {
    return authRateLimiter(req, res, next);
  }
  next();
});
// Heavy operations get their own rate limiter (applied in route handlers)
// General API routes get standard rate limiting
app.use('/api', apiRateLimiter);

// Routes
app.use('/api/auth', authRoutes);
// Public and unauthenticated (README badges). Mounted ahead of the `/api`
// routers so nothing they register can shadow it.
app.use('/api/stats', statsRoutes);
app.use('/api', apiRoutes);
app.use('/api', growthRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/feedback', feedbackRoutes);

// Health check with rate limiting
app.get('/health', healthCheckRateLimiter, (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve Next.js static export in production
if (existsSync(FRONTEND_BUILD_PATH)) {
  logger.info(`Serving frontend from ${FRONTEND_BUILD_PATH}`);

  // Retired paths -> the page that replaced them. 301 (not a client-side
  // redirect) so search engines and old bookmarks converge on the new URL.
  mountStaticSite(app, FRONTEND_BUILD_PATH, {
    aliases: {
      '/sc-toolkit': '/faq/#rebrand',
      '/soundcloud-toolkit': '/faq/#rebrand',
      '/rebrand': '/faq/#rebrand',
    },
  });
} else {
  logger.info(`Frontend build not found at ${FRONTEND_BUILD_PATH} - API only mode`);
  
  // Root route for API-only mode
  app.get('/', (req, res) => {
    res.json({
      service: 'Track Toolkit API',
      status: 'running',
      version: '1.0.0',
      endpoints: {
        health: '/health',
        api: '/api',
        auth: '/api/auth'
      },
      documentation: 'This is an API-only deployment. Frontend is hosted separately.'
    });
  });
}

// Error handling middleware
app.use(errorHandler);

// 404 handler for API routes only
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Verify the database has the schema this build expects BEFORE serving or
// scheduling anything. A deploy that ships code ahead of its migration should
// fail here, loudly, rather than at the first person who tries to sign in —
// which is exactly how the 2026-09-23 auth outage was discovered. Exiting also
// keeps the retention scheduler, which deletes accounts, away from a
// half-migrated database. An unreachable database is a warning, not a failure;
// see the file header for why those two are treated differently.
await verifySchema();

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  startGrowthScheduler(soundcloudClient);
  // Enforces the stated retention windows (library cache, disconnected and
  // dormant accounts, operation logs, growth history, feedback, catalog
  // metadata for tracks deleted upstream). RETENTION_ENABLED=false to disable.
  startRetentionScheduler();
});
