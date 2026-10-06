/**
 * Genre focus options for growth discovery.
 *
 * KEEP IN SYNC with frontend-UI/src/lib/genres.ts (slug + label per entry);
 * tests/genre-list-parity.test.js fails if the two lists drift. Aliases are
 * server-only: they widen what counts as a match, never what the UI offers.
 */

export const GENRE_FOCUS_OPTIONS = [
  { slug: 'house', label: 'House', aliases: [] },
  { slug: 'techno', label: 'Techno', aliases: [] },
  { slug: 'ambient', label: 'Ambient', aliases: [] },
  { slug: 'hip-hop', label: 'Hip-hop', aliases: ['hiphop', 'hip hop', 'rap'] },
  { slug: 'drum-and-bass', label: 'Drum & bass', aliases: ['dnb', 'd&b', 'drum & bass', 'drum n bass'] },
  { slug: 'dubstep', label: 'Dubstep', aliases: [] },
  { slug: 'trance', label: 'Trance', aliases: [] },
  { slug: 'jazz', label: 'Jazz', aliases: [] },
  { slug: 'classical', label: 'Classical', aliases: [] },
  { slug: 'electronic', label: 'Electronic', aliases: ['electronica', 'edm'] },
  { slug: 'indie', label: 'Indie', aliases: [] },
  { slug: 'pop', label: 'Pop', aliases: [] },
  { slug: 'r-b-soul', label: 'R&B / Soul', aliases: ['r&b', 'rnb', 'r n b', 'rhythm and blues', 'soul'] },
  { slug: 'metal', label: 'Metal', aliases: [] },
  { slug: 'folk', label: 'Folk', aliases: [] },
];

export const GENRE_FOCUS_SLUGS = GENRE_FOCUS_OPTIONS.map((o) => o.slug);

/**
 * lowercase, `&` -> "and", every run of non-alphanumerics -> a single `-`,
 * leading/trailing dashes trimmed. "Drum & Bass" -> "drum-and-bass".
 */
export function normalizeGenreToken(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function getGenreFocusOption(slug) {
  return GENRE_FOCUS_OPTIONS.find((o) => o.slug === slug) || null;
}

function containsWholeWords(token, needle) {
  if (!token || !needle) return false;
  return `-${token}-`.includes(`-${needle}-`);
}

/**
 * True when the slug or one of its aliases appears as a whole-word
 * (dash-delimited) sequence inside any token of the set: "deep-house" matches
 * "house"; "housewife" does not.
 */
export function matchesGenreFocus(genreSet, slug) {
  const option = getGenreFocusOption(slug);
  if (!option || !genreSet) return false;
  const needles = [option.slug, ...option.aliases]
    .map(normalizeGenreToken)
    .filter(Boolean);
  for (const raw of genreSet) {
    const token = normalizeGenreToken(raw);
    if (!token) continue;
    for (const needle of needles) {
      if (containsWholeWords(token, needle)) return true;
    }
  }
  return false;
}
