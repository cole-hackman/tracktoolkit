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

/**
 * The link as SoundCloud names the resource: `https://soundcloud.com/<path>`
 * with the whole query dropped. A link copied from SoundCloud's share menu
 * carries `ref`, `p`, `c`, `si` and `utm_*`; none of them identify anything,
 * so none of them are sent to /resolve or written into a description. A
 * token given as `?secret_token=` on a playlist link is moved into the path
 * (`/sets/<slug>/s-…`), the form SoundCloud itself shares. Short links
 * (`on.soundcloud.com/…`) keep their host. Returns '' for anything unparseable.
 */
export function canonicalSoundCloudUrl(input) {
  const url = parse(input);
  if (!url) return '';
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  const token = extractSecretToken(url.toString());
  const setsAt = segments.indexOf('sets');
  if (token && setsAt !== -1 && segments.length === setsAt + 2) segments.push(token);
  const origin = host === 'on.soundcloud.com' ? 'https://on.soundcloud.com' : 'https://soundcloud.com';
  return segments.length ? `${origin}/${segments.join('/')}` : origin;
}

/**
 * For log lines and error text: any secret token, in a query or as a
 * trailing `/s-…` path segment, replaced with a placeholder.
 */
export function redactSecretToken(input) {
  return String(input ?? '')
    .replace(/(secret_token=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/\/s-[A-Za-z0-9]{3,64}(?![A-Za-z0-9])/g, '/s-[redacted]');
}
