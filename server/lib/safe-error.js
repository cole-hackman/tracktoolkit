/**
 * Sanitize error objects before logging.
 * Strips potentially sensitive data (request bodies, tokens, full stack traces)
 * while preserving enough context for debugging.
 *
 * FOR LOGS ONLY. Never send the result (or its `.message`) to a client: it
 * keeps `err.message` verbatim, and a Prisma error's message names the
 * database host and port. It takes one argument — a second "fallback" string
 * is ignored. A response gets a fixed `{ error: '<what failed>' }` instead.
 */
export function safeError(err) {
  if (!err) return { message: 'Unknown error' };

  return {
    message: err.message || String(err),
    ...(err.code && { code: err.code }),
    ...(err.status && { status: err.status }),
    // Only include stack traces in non-production environments
    ...(process.env.NODE_ENV !== 'production' && err.stack && { stack: err.stack })
  };
}

/**
 * `safeError` for a once-per-run summary line ("3 items failed, the first
 * was ..."): message, code and status only. No stack, and anything shaped like
 * a URL is cut from the message, because a pasted link can carry a secret
 * token and a network error may quote the address it could not reach.
 * FOR LOGS ONLY, like `safeError`.
 */
export function safeErrorBrief(err) {
  const { message, code, status } = safeError(err);
  return {
    message: String(message).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]'),
    ...(code && { code }),
    ...(status && { status }),
  };
}
