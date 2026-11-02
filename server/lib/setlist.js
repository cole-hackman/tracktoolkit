/**
 * Set → playlist: the pure pieces of the two /setlists routes.
 *
 * The tracklist itself never comes from 1001Tracklists' servers. That site
 * answers non-browser fetches with a captcha (checked 2026-11-02), so the user
 * pastes what their own browser shows, the client parses it
 * (`frontend-UI/src/lib/setlist.ts`), and these helpers only shape what the
 * user confirmed into one playlist and its description.
 */

/**
 * Ceiling for a playlist description. SoundCloud's API spec documents no
 * limit; 4000 is the web editor's cap. A description over the real limit
 * would fail the create outright, so the builder trims to this and says so
 * rather than risk the whole write.
 */
export const SC_PLAYLIST_DESCRIPTION_MAX = 4000;

/** Hosts a `sourceUrl` may name. It is printed in the description, never fetched. */
const SOURCE_HOSTS = new Set(['1001tracklists.com', 'www.1001tracklists.com', '1001.tl']);

export function isAllowedSourceUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && SOURCE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * First occurrence wins: a set that plays the same record twice (a "w/"
 * acappella and later the full track, say) puts it in the playlist once, at
 * the position it was first heard.
 */
export function dedupeTracks(tracks) {
  const seen = new Set();
  const kept = [];
  const duplicates = [];
  for (const track of tracks) {
    if (seen.has(track.id)) {
      duplicates.push(track);
      continue;
    }
    seen.add(track.id);
    kept.push(track);
  }
  return { kept, duplicates };
}

/**
 * "Artist - Title" per line, in playlist order, then the source link.
 *
 * `reserve` is what the caller appends afterwards (the Track Toolkit footer),
 * so the finished description stays under `max`. When the lines do not all
 * fit, it keeps whole lines and ends with how many were left out. That is the
 * one case where the description does not list every track, so the count is
 * returned for the UI to say so.
 */
export function buildSetlistDescription(labels, { sourceUrl = null, reserve = 0, max = SC_PLAYLIST_DESCRIPTION_MAX } = {}) {
  const tail = sourceUrl ? `\n\nTracklist: ${sourceUrl}` : '';
  const budget = max - reserve - tail.length;
  const lines = labels.map((label) => String(label).replace(/\s+/g, ' ').trim());

  const full = lines.join('\n');
  if (full.length <= budget) return { description: full + tail, omitted: 0 };

  const note = (n) => `\n…and ${n} more — the playlist order continues`;
  const kept = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const cost = (kept.length ? 1 : 0) + lines[i].length;
    // Accepting this line must still leave room for the note about the rest.
    const rest = lines.length - i - 1;
    if (used + cost + (rest > 0 ? note(rest).length : 0) > budget) break;
    kept.push(lines[i]);
    used += cost;
  }
  const omitted = lines.length - kept.length;
  const body = (kept.join('\n') + note(omitted)).replace(/^\n/, '');
  return { description: body + tail, omitted };
}
