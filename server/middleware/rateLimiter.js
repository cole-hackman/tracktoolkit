import rateLimit from 'express-rate-limit';

/**
 * In development, bypass all rate limiters so rapid iteration isn't throttled.
 * Production behavior is completely unchanged.
 */
const isDev = process.env.NODE_ENV === 'development';
const createLimiter = (options) => {
  if (isDev) {
    return (req, res, next) => next();
  }
  return rateLimit(options);
};

/**
 * General API rate limiter - applies to all API routes
 * Allows 600 requests per 15 minutes per IP
 *
 * Raised from 100. Progressive loading pages a library 200 items at a time,
 * so a user with 20,000 likes spends 100 requests browsing ONE tool — the old
 * ceiling was a quarter of that and would have cut them off mid-scroll. This
 * limiter is also per-IP, so anyone behind shared NAT divides it further.
 * The heavy-operation limiter (20/hour) still guards the expensive writes,
 * which is where abuse actually costs something.
 *
 * Uses default keyGenerator which handles IPv6 correctly when Express trust proxy is configured
 */
export const apiRateLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 600, // Limit each IP to 600 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Default keyGenerator handles IPv6 correctly when Express is configured with trust proxy
});

/**
 * Stricter rate limiter for authentication endpoints
 * Allows 5 login attempts per 15 minutes per IP
 */
export const authRateLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 login attempts per windowMs
  message: {
    error: 'Too many authentication attempts, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful requests
  // Default keyGenerator handles IPv6 correctly
});

/**
 * Rate limiter for resource-intensive endpoints (merge, resolve, etc.)
 * Allows 20 requests per hour per IP
 */
export const heavyOperationRateLimiter = createLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // Limit each IP to 20 heavy operations per hour
  message: {
    error: 'Too many resource-intensive requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Default keyGenerator handles IPv6 correctly
});

/**
 * Rate limiter for the bounded paged library reads — the library audit and the
 * playlist keyword search. Allows 60 requests per hour per IP.
 *
 * These two are reads, and their cost is bounded: one page is at most 50
 * playlist fetches, against a cached playlist list. They were sharing the
 * 20/hour heavy budget with merge, clone, and every bulk write, which meant
 * paging through a 400-playlist library twenty pages at a time locked the user
 * out of the operations that actually mutate their account — and did it after
 * twenty page views, which is one sitting. Sitting between heavy and general
 * gives the page walk room without handing a write budget away.
 */
export const libraryReadRateLimiter = createLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60, // Limit each IP to 60 paged library reads per hour
  message: {
    error: 'Too many library scans, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Default keyGenerator handles IPv6 correctly
});

/**
 * Light rate limiter for health check endpoint
 * Allows 60 requests per minute per IP (prevents abuse while allowing monitoring)
 */
export const healthCheckRateLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 health checks per minute
  message: {
    error: 'Too many health check requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful health checks
});

/**
 * Per-USER limiter, as opposed to every limiter above it, which is per-IP.
 *
 * Feedback is login-required, so the account is the thing worth budgeting:
 * per-IP would let one person on a phone and a laptop spend two budgets, and
 * would make a shared office NAT share one. The key is `req.user.id`, which
 * only exists because these limiters are always mounted AFTER
 * `authenticateUser` — mount one in front of it and every request keys on the
 * `req.ip` fallback instead, silently turning it back into a per-IP limiter.
 *
 * `validate.keyGeneratorIpFallback: false` switches off express-rate-limit v8's
 * guard against custom key generators that touch `req.ip` without the
 * `ipKeyGenerator` helper. The guard exists because an IPv6 user with a /64 can
 * rotate addresses to buy a fresh budget. That is accepted here: the fallback
 * is unreachable on the routes these limiters are mounted on, and anyone who
 * did reach it would be unauthenticated and have nothing to spend the budget
 * on. Left on, the guard dumps an ERR_ERL_KEY_GEN_IPV6 error to the console
 * every time the module loads — it does not throw, so the flag buys a clean
 * startup and an explicit record of the trade-off rather than a fixed crash.
 *
 * @param {{ windowMs: number, max: number, message: string }} options
 */
export function createUserLimiter({ windowMs, max, message }) {
  return createLimiter({
    windowMs,
    max,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || req.ip,
    validate: { keyGeneratorIpFallback: false },
  });
}

/**
 * Feedback write budget — two windows, both per user.
 *
 * The hourly one absorbs a burst: someone hitting a bug, sending a report,
 * hitting it again and sending a second. The daily one is the actual ceiling,
 * because an hourly limit alone permits 120 submissions a day. Five an hour is
 * far more than anyone sends in good faith and cheap enough that a genuine
 * back-and-forth never touches it.
 */
export const feedbackHourlyLimiter = createUserLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: 'Too much feedback sent in the last hour, please try again later.',
});

export const feedbackDailyLimiter = createUserLimiter({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 20,
  message: 'Too much feedback sent today, please try again tomorrow.',
});


/**
 * Sort Likes commit budget — per user. One commit is one call per destination
 * plus one per 100 unlikes, so a big session is a dozen or more calls; on the
 * shared 20/hour heavyOperationRateLimiter (per IP, shared with merge, clone
 * and every bulk write) one session could spend the hour. Every call is still
 * paced against SoundCloud inside the route. Mount after authenticateUser,
 * or it silently keys on the IP (see createUserLimiter).
 */
export const sortCommitLimiter = createUserLimiter({
  windowMs: 60 * 60 * 1000,
  max: 60,
  message: 'Too many sort commits in the last hour, please try again later.',
});

/**
 * Sort Likes preview links — per user. Sorting is listening: hundreds of
 * tracks in a sitting, one `/tracks/{id}/streams` read each. The 60/hour
 * libraryReadRateLimiter would stop a session within the hour.
 */
export const trackStreamLimiter = createUserLimiter({
  windowMs: 60 * 60 * 1000,
  max: 600,
  message: 'Too many previews in the last hour, please try again later.',
});
