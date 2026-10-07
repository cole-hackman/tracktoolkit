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

/**
 * Wrap a read so a failure names the playlist it was for. Only reads are
 * tagged, which is what lets a catch tell "this playlist is gone" (a tagged
 * 404) from a 404 on a write (untagged).
 */
export function tagPlaylistReadFailure(playlistId) {
  return (err) => {
    if (err && typeof err === 'object') err.scPlaylistId = playlistId;
    throw err;
  };
}

/**
 * Map a classified upstream failure to a response, or null when the route
 * should fall through to its own generic 500. Pure.
 *
 * - `writeAttempted`: set BEFORE each create/PUT by the caller. A write that
 *   timed out or came back 502 may still have landed, so it picks the wording.
 * - `readOnly`: the route can never write, so the 502 text does not mention
 *   changes at all.
 * - `notFound`: `{ status, error, playlistId }`, supplied by the caller only
 *   when the 404 came from a tagged read. Without it a 404 returns null.
 *
 * @returns {{ status: number, code: string, body: object } | null}
 */
export function scErrorResponse(err, { writeAttempted = false, readOnly = false, notFound = null } = {}) {
  const kind = classifyScError(err);
  if (kind === 'not_found' && notFound) {
    const body = { code: 'PLAYLIST_NOT_FOUND' };
    if (notFound.playlistId != null) body.playlistId = notFound.playlistId;
    body.error = notFound.error;
    return { status: notFound.status, code: 'PLAYLIST_NOT_FOUND', body };
  }
  if (kind === 'upstream_unavailable') {
    let message;
    if (readOnly) message = 'SoundCloud is having trouble right now — try again in a minute.';
    else if (writeAttempted) message = 'SoundCloud stopped responding partway through. Some changes may have been made — check your playlists before trying again.';
    else message = 'SoundCloud is having trouble right now. Nothing was changed — try again in a minute.';
    return { status: 502, code: 'SOUNDCLOUD_UNAVAILABLE', body: { code: 'SOUNDCLOUD_UNAVAILABLE', error: message } };
  }
  return null;
}
