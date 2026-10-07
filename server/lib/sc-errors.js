/**
 * Classify an error thrown by the SoundCloud client so routes can answer with
 * something more useful than a generic 500. Pure: reads `status` and `code`
 * only, never the message.
 *
 * @returns {'not_found'|'upstream_unavailable'|'rate_limited'|null}
 */
export function classifyScError(err) {
  if (!err || typeof err !== 'object') return null;
  if (err.code === 'SC_TIMEOUT') return 'upstream_unavailable';
  const status = err.status;
  if (status === 404) return 'not_found';
  if (status === 502 || status === 503 || status === 504) return 'upstream_unavailable';
  if (status === 429) return 'rate_limited';
  return null;
}
