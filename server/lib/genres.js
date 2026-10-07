/**
 * Genre focus options for growth discovery.
 *
 * KEEP IN SYNC with frontend-UI/src/lib/genres.ts (slug + label per entry);
 * tests/genre-list-parity.test.js fails if the two lists drift. Aliases are
 * server-only: they widen what counts as a match, never what the UI offers.
 */

export const GENRE_FOCUS_OPTIONS = [
  { slug: 'house', label: 'House', aliases: ['deephouse', 'techhouse', 'housemusic'] },
  { slug: 'techno', label: 'Techno', aliases: [] },
  { slug: 'ambient', label: 'Ambient', aliases: [] },
  { slug: 'hip-hop', label: 'Hip-hop', aliases: ['hiphop', 'hip hop', 'rap'] },
  { slug: 'drum-and-bass', label: 'Drum & bass', aliases: ['dnb', 'd&b', 'drum & bass', 'drum n bass', 'drumandbass', 'drumnbass', 'junglist', 'jungle-dnb'] },
  { slug: 'dubstep', label: 'Dubstep', aliases: ['brostep'] },
  { slug: 'trance', label: 'Trance', aliases: ['psytrance'] },
  { slug: 'jazz', label: 'Jazz', aliases: [] },
  { slug: 'classical', label: 'Classical', aliases: ['neoclassical'] },
  { slug: 'electronic', label: 'Electronic', aliases: ['electronica', 'edm', 'indietronica'] },
  { slug: 'indie', label: 'Indie', aliases: ['indietronica'] },
  { slug: 'pop', label: 'Pop', aliases: ['kpop', 'synthpop', 'hyperpop'] },
  { slug: 'r-b-soul', label: 'R&B / Soul', aliases: ['r&b', 'rnb', 'r n b', 'rhythm and blues', 'soul'] },
  { slug: 'metal', label: 'Metal', aliases: ['metalcore'] },
  { slug: 'folk', label: 'Folk', aliases: [] },
];

export const GENRE_FOCUS_SLUGS = GENRE_FOCUS_OPTIONS.map((o) => o.slug);

/**
 * lowercase, `&` -> "and", every run of non-alphanumerics -> a single `-`,
 * leading/trailing dashes trimmed. "Drum & Bass" -> "drum-and-bass".
 */
export function normalizeGenreToken(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
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
 * The first token in the set that carries the slug or one of its aliases as a
 * whole-word (dash-delimited) sequence, or null. "deep-house" matches "house";
 * "housewife" does not.
 */
export function findGenreFocusMatch(genreSet, slug) {
  const option = getGenreFocusOption(slug);
  if (!option || !genreSet) return null;
  const needles = [option.slug, ...option.aliases]
    .map(normalizeGenreToken)
    .filter(Boolean);
  for (const raw of genreSet) {
    const token = normalizeGenreToken(raw);
    if (!token) continue;
    for (const needle of needles) {
      if (containsWholeWords(token, needle)) return raw;
    }
  }
  return null;
}

export function matchesGenreFocus(genreSet, slug) {
  return findGenreFocusMatch(genreSet, slug) !== null;
}
