// SoundCloud serves a track's `download_url` in two shapes: the legacy
// numeric `/tracks/123/download`, and — since the URN migration, and for
// every downloadable track in production as of 2026-10 — the URN form
// `/tracks/soundcloud:tracks:123/download`. Accepting only the first is what
// made every SoundCloud-native download answer 400 "Invalid download URL".
// The colons may arrive percent-encoded, so `%3A` is accepted too; nothing
// else about the path is loosened.
const DOWNLOAD_PATH_RE = /^\/tracks\/(?:soundcloud(?::|%3A)tracks(?::|%3A))?(\d+)\/download$/i;

export function isAllowedDownloadUrl(input) {
  if (!input || typeof input !== 'string') return false;
  const value = input.trim();
  if (!value) return false;

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      host === 'api.soundcloud.com' &&
      DOWNLOAD_PATH_RE.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * The numeric track id inside an allowed download URL, or null. Shares
 * DOWNLOAD_PATH_RE with the check above so the two cannot disagree about
 * which shapes exist.
 */
export function downloadTrackIdFromUrl(input) {
  if (!isAllowedDownloadUrl(input)) return null;
  const match = new URL(input.trim()).pathname.match(DOWNLOAD_PATH_RE);
  const id = Number(match?.[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function isAllowedDownloadRedirectTarget(input) {
  if (!input || typeof input !== 'string') return false;

  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      (host === 'sndcdn.com' ||
        host.endsWith('.sndcdn.com') ||
        host === 'cloudfront.net' ||
        host.endsWith('.cloudfront.net'))
    );
  } catch {
    return false;
  }
}

// A track's stream links (`GET /tracks/{id}/streams`) are either already a
// CDN URL or an api.soundcloud.com URL that answers an authenticated GET with
// a redirect to one. Only the second kind is ever requested with the user's
// token, and only on this exact host and path family — the same posture as
// isAllowedDownloadUrl. The shape is from SoundCloud's spec, not yet seen
// live, so it accepts both `/stream` and `/streams/<kind>`.
const STREAM_PATH_RE = /^\/tracks\/(?:soundcloud(?::|%3A)tracks(?::|%3A))?\d+\/streams?(?:\/[A-Za-z0-9_-]+)?$/i;

export function isAllowedStreamUrl(input) {
  if (!input || typeof input !== 'string') return false;
  try {
    const url = new URL(input.trim());
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'api.soundcloud.com' &&
      STREAM_PATH_RE.test(url.pathname)
    );
  } catch {
    return false;
  }
}
