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
