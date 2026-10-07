/**
 * Genre list shared by the genre-search suggestions and the growth tool's
 * "Genre focus" select.
 *
 * KEEP IN SYNC with server/lib/genres.js (slug + label, same order);
 * tests/genre-list-parity.test.js parses this file and fails on drift. The
 * server also holds match aliases, which the client does not need.
 */
export interface GenreFocusOption {
  slug: string;
  label: string;
}

export const GENRE_FOCUS_OPTIONS: GenreFocusOption[] = [
  { slug: "house", label: "House" },
  { slug: "techno", label: "Techno" },
  { slug: "ambient", label: "Ambient" },
  { slug: "hip-hop", label: "Hip-hop" },
  { slug: "drum-and-bass", label: "Drum & bass" },
  { slug: "dubstep", label: "Dubstep" },
  { slug: "trance", label: "Trance" },
  { slug: "jazz", label: "Jazz" },
  { slug: "classical", label: "Classical" },
  { slug: "electronic", label: "Electronic" },
  { slug: "indie", label: "Indie" },
  { slug: "pop", label: "Pop" },
  { slug: "r-b-soul", label: "R&B / Soul" },
  { slug: "metal", label: "Metal" },
  { slug: "folk", label: "Folk" },
];

export const COMMON_GENRES: string[] = GENRE_FOCUS_OPTIONS.map((o) => o.slug);

export function genreLabel(slug: string): string {
  return GENRE_FOCUS_OPTIONS.find((o) => o.slug === slug)?.label ?? slug;
}
