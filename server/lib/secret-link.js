/**
 * SoundCloud secret links.
 *
 * A private playlist shared by link looks like
 *   https://soundcloud.com/user/sets/name/s-AbC123
 * (or carries `?secret_token=s-AbC123`). The `s-…` token is a credential: it
 * is what makes the playlist readable, so it is sent to SoundCloud as
 * `secret_token`, and it must never be copied into anything we publish.
 */

const SECRET_TOKEN = /^s-[A-Za-z0-9]{3,64}$/;

function parse(input) {
  try {
    const raw = String(input ?? '').trim();
    if (!raw) return null;
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

/** The `s-…` token in a SoundCloud URL, or null. */
export function extractSecretToken(input) {
  const url = parse(input);
  if (!url) return null;
  const fromQuery = url.searchParams.get('secret_token');
  if (fromQuery && SECRET_TOKEN.test(fromQuery)) return fromQuery;
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  // Only a trailing segment after /sets/<name>/ counts, so a user or playlist
  // that happens to be called "s-1234" is not mistaken for a token.
  const setsAt = segments.indexOf('sets');
  if (setsAt !== -1 && segments.length === setsAt + 3 && SECRET_TOKEN.test(last)) return last;
  return null;
}

/** The same URL with any secret token removed — safe to store or publish. */
export function stripSecretToken(input) {
  const url = parse(input);
  if (!url) return String(input ?? '');
  url.searchParams.delete('secret_token');
  const segments = url.pathname.split('/').filter(Boolean);
  const setsAt = segments.indexOf('sets');
  if (setsAt !== -1 && segments.length === setsAt + 3 && SECRET_TOKEN.test(segments[segments.length - 1])) {
    segments.pop();
    url.pathname = `/${segments.join('/')}`;
  }
  return url.toString();
}
