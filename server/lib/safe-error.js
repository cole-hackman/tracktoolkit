import logger from './logger.js';

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

// What `safeErrorBrief` may copy. A value that does not look like one of
// these is left out, not cleaned up.
const NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;            // TypeError, PrismaClientKnownRequestError
const CODE = /^[A-Z0-9][A-Z0-9_]{0,39}$/;              // P1001, ECONNRESET, SC_TIMEOUT, 57P01
const CODE_NUMBER_MAX = 999_999;                       // errno, SQLSTATE as a number

// The SoundCloud client's own messages (soundcloud-client.js): fixed text and
// at most an HTTP status. A message is logged only if it is exactly one of
// them, so a new client message has to be added here to show up.
const OWN_MESSAGE = new RegExp(`^(?:${[
  '(?:API request failed|API request failed after token refresh|Resolve error|Resolve follow error'
    + '|Token refresh failed|Token exchange failed|Download request failed|Stream request failed): \\d{3}',
  'Token refresh failed',
  'Token refresh failed: no user context',
  'Resolve redirect missing location',
  'Invalid download URL',
  'No playable stream for this track',
  'Unexpected stream host',
  'Unexpected stream redirect',
  'fetch failed',                                       // Node's own, for every network failure
].join('|')})$`);
// parseScJson starts its message with the endpoint; only this ending is fixed.
const OWN_MESSAGE_ENDING = /: ((?:empty response|invalid JSON response) \(status \d{3}\))$/;
const MESSAGE_MAX = 200;

/** `value[key]`, or undefined when there is nothing to read or reading throws. */
function read(value, key) {
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function describe(err, withCause) {
  const out = {};
  const name = read(err, 'name');
  if (typeof name === 'string' && NAME.test(name)) out.name = name;
  const code = read(err, 'code');
  if (typeof code === 'string' ? CODE.test(code) : Number.isInteger(code) && Math.abs(code) <= CODE_NUMBER_MAX) out.code = code;
  const status = read(err, 'status');
  if (Number.isInteger(status) && status >= 100 && status <= 599) out.status = status;
  const message = read(err, 'message');
  if (typeof message === 'string' && message.length <= MESSAGE_MAX) {
    if (OWN_MESSAGE.test(message)) out.message = message;
    else {
      const ending = OWN_MESSAGE_ENDING.exec(message);
      if (ending) out.message = ending[1];
    }
  }
  if (withCause) {
    const cause = read(err, 'cause');
    if (cause !== null && typeof cause === 'object') {
      const inner = describe(cause, false);
      if (Object.keys(inner).length > 0) out.cause = inner;
    }
  }
  return out;
}

/**
 * A thrown value, described for a log line by an allowlist: its `name`,
 * `code` and `status` when they look like a name, a code and an HTTP status,
 * its `message` only when that is one of the client's own fixed messages, and
 * the same for a `cause` (name and code; that is where `fetch failed` keeps
 * ECONNREFUSED). Anything else is `{ thrown: <typeof> }`.
 *
 * Nothing else is copied, so there is nothing to redact: a message can quote
 * an Authorization header, a pasted secret link, an email or a Prisma query,
 * and no pattern list catches every shape of those. The cost is the free
 * text. A database error is its class and code ("P1001"), not the sentence
 * naming the host; an error with neither is only its class.
 *
 * Cannot throw, whatever was thrown: every property is read through `read`.
 */
export function safeErrorBrief(err) {
  if (err !== null && typeof err === 'object') {
    const out = describe(err, true);
    if (Object.keys(out).length > 0) return out;
  }
  return { thrown: err === null ? 'null' : typeof err };
}

/**
 * `err.message` for the operation log, or `fallback` when there is no string
 * message or reading it throws. Raw text: never for a response.
 */
export function rawErrorMessage(err, fallback) {
  const message = err === null || err === undefined ? undefined : read(err, 'message');
  return typeof message === 'string' && message !== '' ? message : fallback;
}

/**
 * One warn line: `fields` as given, plus each entry of `errors` as its
 * `safeErrorBrief`. Cannot throw, so a log line can never change a response
 * or skip the bookkeeping after it.
 */
export function logFailure(what, fields, errors) {
  try {
    const line = { ...fields };
    for (const key of Object.keys(errors ?? {})) line[key] = safeErrorBrief(errors[key]);
    logger.warn(what, line);
  } catch {
    // A log line is not worth a failed request.
  }
}
