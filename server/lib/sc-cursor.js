/**
 * A pagination cursor a client hands back to us (`next`, the `next_href`
 * SoundCloud gave it on the previous page) may only continue the request it
 * came from.
 *
 * Before this, routes took the cursor's path and query wholesale and sent
 * them to api.soundcloud.com with the user's token — so a client could make
 * the server fetch any SoundCloud path (`/tracks/N/streams`), and point a
 * followed-user route's cursor at a user they do not follow, past
 * assertFollowedUser. `/api/likes/paged` also harvests what it returns into
 * the catalog, so the same trick wrote anyone's likes into it.
 *
 * Checked against live cursors on 2026-10-07: SoundCloud's next_href keeps
 * the requested path exactly (`/me/likes/tracks`, `/users/N/likes/tracks`,
 * …) and uses only the parameters listed below.
 */

const ALLOWED_PARAMS = new Set(['cursor', 'linked_partitioning', 'page_size', 'limit', 'show_tracks', 'access', 'offset']);

export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid next cursor');
    this.status = 400;
  }
}

function normalizePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new InvalidCursorError();
  }
  // The same user may appear as 123 or soundcloud:users:123.
  return decoded.replace(/soundcloud:users:(\d+)/g, '$1').replace(/\/+$/, '');
}

/**
 * @param {string} next          the client's cursor (a full next_href URL)
 * @param {string} expectedPath  the path of the request it continues, e.g. `/me/likes/tracks`
 * @returns {string} path + query to send to SoundCloud
 * @throws {InvalidCursorError} (status 400) for anything else
 */
export function cursorEndpoint(next, expectedPath) {
  let url;
  try {
    url = new URL(String(next));
  } catch {
    throw new InvalidCursorError();
  }
  if (url.protocol !== 'https:' || url.hostname !== 'api.soundcloud.com' || url.port || url.username || url.password) {
    throw new InvalidCursorError();
  }
  // The URL parser has already resolved ../ and %2e%2e, so a traversal shows
  // up here as a different path.
  if (normalizePath(url.pathname) !== normalizePath(String(expectedPath).split('?')[0])) {
    throw new InvalidCursorError();
  }
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(key)) throw new InvalidCursorError();
  }
  return `${url.pathname}${url.search}`;
}

/** express-validator custom check: an https://api.soundcloud.com URL, nothing else. */
export function isSoundCloudApiUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === 'api.soundcloud.com' && !url.port && !url.username && !url.password;
  } catch {
    return false;
  }
}
