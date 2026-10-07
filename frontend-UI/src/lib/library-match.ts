import type { RekordboxTrack } from "@/lib/rekordbox-xml";

/**
 * Which SoundCloud tracks are already in a Rekordbox collection.
 *
 * SoundCloud titles are free text ("ARTIST - Title (Someone Remix) [FREE DL]",
 * uploaded by the remixer or a label), Rekordbox splits the same facts across
 * Name / Artist / Mix / Remixer. So both sides are reduced to the same three
 * things — a core title, a set of artist names, and a *version* — and
 * compared on those:
 *
 * - **owned**: same core title, a shared artist, and the same version.
 *   "Original Mix", "Extended Mix" and "Radio Edit" all count as the same
 *   version — they're edits of one record, which is what a DJ means by
 *   "I have it".
 * - **other-version**: same title and artist, but a different remix.
 * - **missing**: no Rekordbox track with that title by any of its artists.
 *
 * It never guesses across artists: two different "Intro"s stay different.
 */

export type MatchKind = "owned" | "other-version" | "missing";

export interface TrackMatch {
  kind: MatchKind;
  rekordbox?: RekordboxTrack;
  /** For other-version: what the collection has instead, in words. */
  note?: string;
}

export interface SoundCloudLikeTrack {
  id: number;
  title: string;
  user?: { username?: string } | null;
  /** Milliseconds. */
  duration?: number | null;
}

// Promotional noise that rides in SoundCloud titles and is never part of
// the record's name.
const JUNK = /\b(free\s*(download|dl)|f\s*dl|out\s*now|buy\s*(=|for)\s*free(\s*dl)?|limited\s*free\s*(download|dl)?|premiere|exclusive|click\s*buy|supported\s*by\s+.*)\b/gi;
const REWORK_WORDS = /\b(remix|edit|flip|bootleg|vip|dub|rework|refix|mashup|version|cover|re\s*edit|remake|mix)\b/;
// Edits of the same record: one version as far as owning it goes.
const BASE_VERSIONS = new Set(["", "original", "original mix", "extended", "extended mix", "radio", "radio edit", "radio mix", "club mix", "clean", "dirty", "clean edit", "dirty edit", "explicit", "main mix", "album version", "single version"]);
const GENERIC = new Set(["remix", "edit", "flip", "bootleg", "vip", "dub", "rework", "refix", "mashup", "version", "cover", "re", "remake", "mix", "the", "and", "x", "vs"]);

export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits "A, B & C feat. D x E" into normalised artist names. */
export function artistNames(text: string): string[] {
  return text
    .split(/\s*(?:,|&|\+|\/|\bx\b|\bvs\.?\b|\band\b|\bwith\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/i)
    .map((part) => normalize(part))
    .filter((part) => part.length > 0);
}

interface Parsed {
  core: string;
  artists: Set<string>;
  /** "" for the base record, else the rework's distinguishing words. */
  version: string;
}

/** Pulls "(feat. X)" and bracketed versions out of a title. */
function splitTitle(title: string): { core: string; versions: string[]; featured: string[] } {
  const versions: string[] = [];
  const featured: string[] = [];
  let rest = title.replace(JUNK, " ");
  rest = rest.replace(/[([{]([^)\]}]*)[)\]}]/g, (_, inner: string) => {
    const lower = inner.toLowerCase();
    const feat = lower.match(/^\s*(?:feat\.?|ft\.?|featuring)\s+(.*)$/i);
    if (feat) featured.push(...artistNames(feat[1]));
    else if (REWORK_WORDS.test(lower) || BASE_VERSIONS.has(normalize(inner))) versions.push(inner);
    return " ";
  });
  // Unbracketed "feat. X" at the end of a title.
  rest = rest.replace(/\s(?:feat\.?|ft\.?|featuring)\s+(.+)$/i, (_, who: string) => {
    featured.push(...artistNames(who));
    return " ";
  });
  // "Title - Someone Remix" without brackets.
  rest = rest.replace(/\s[-–]\s([^-–]*\b(?:remix|edit|flip|bootleg|vip|rework|mix)\b[^-–]*)$/i, (_, v: string) => {
    versions.push(v);
    return " ";
  });
  return { core: normalize(rest), versions, featured };
}

/** The version's identity: "" for the base record, else its distinguishing words. */
export function versionKey(versions: string[]): string {
  for (const raw of versions) {
    const v = normalize(raw);
    if (BASE_VERSIONS.has(v)) continue;
    const words = v.split(" ").filter((w) => !GENERIC.has(w));
    if (words.length > 0) return words.join(" ");
    return v; // e.g. "VIP" alone
  }
  return "";
}

export function parseSoundCloud(track: SoundCloudLikeTrack): Parsed {
  const uploader = track.user?.username ?? "";
  // "ARTIST - Title" is how most uploads name the artist; otherwise the
  // uploader is the artist.
  const dash = track.title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  const artistPart = dash ? dash[1] : uploader;
  const titlePart = dash ? dash[2] : track.title;
  const { core, versions, featured } = splitTitle(titlePart);
  const artists = new Set([...artistNames(artistPart), ...featured]);
  if (uploader) artists.add(normalize(uploader));
  return { core, artists, version: versionKey(versions) };
}

export function parseRekordbox(track: RekordboxTrack): Parsed {
  const { core, versions, featured } = splitTitle(track.title);
  if (track.mix) versions.push(track.mix);
  if (track.remixer && !versions.some((v) => normalize(v).includes(normalize(track.remixer)))) {
    versions.push(`${track.remixer} remix`);
  }
  const artists = new Set([...artistNames(track.artist), ...featured, ...artistNames(track.remixer)]);
  return { core, artists, version: versionKey(versions) };
}

function shareArtist(a: Set<string>, b: Set<string>): boolean {
  for (const name of a) {
    if (b.has(name)) return true;
  }
  // Token overlap for "The Chainsmokers" vs "chainsmokers", ignoring short words.
  const tokens = (set: Set<string>) => new Set([...set].flatMap((n) => n.split(" ")).filter((t) => t.length >= 4 && !GENERIC.has(t)));
  const ta = tokens(a);
  for (const t of tokens(b)) if (ta.has(t)) return true;
  return false;
}

function sameVersion(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const wa = new Set(a.split(" "));
  return b.split(" ").some((w) => w.length >= 3 && wa.has(w));
}

export interface CollectionIndex {
  byCore: Map<string, Array<{ track: RekordboxTrack; parsed: Parsed }>>;
}

export function indexCollection(tracks: RekordboxTrack[]): CollectionIndex {
  const byCore = new Map<string, Array<{ track: RekordboxTrack; parsed: Parsed }>>();
  for (const track of tracks) {
    const parsed = parseRekordbox(track);
    if (!parsed.core) continue;
    const list = byCore.get(parsed.core) ?? [];
    list.push({ track, parsed });
    byCore.set(parsed.core, list);
  }
  return { byCore };
}

/** "Artist - Title (Version)", with the version from Mix, else Remixer. */
const describe = (track: RekordboxTrack) => {
  const version = track.mix || (track.remixer ? `${track.remixer} Remix` : "");
  const title = version && !track.title.toLowerCase().includes(version.toLowerCase()) ? `${track.title} (${version})` : track.title;
  return [track.artist, title].filter(Boolean).join(" - ");
};

export function matchTrack(track: SoundCloudLikeTrack, index: CollectionIndex): TrackMatch {
  const sc = parseSoundCloud(track);
  const candidates = (index.byCore.get(sc.core) ?? []).filter((c) => shareArtist(sc.artists, c.parsed.artists));
  if (candidates.length === 0) return { kind: "missing" };

  const durationSec = track.duration ? track.duration / 1000 : null;
  const closest = (list: typeof candidates) =>
    durationSec == null
      ? list[0]
      : [...list].sort((x, y) => Math.abs(x.track.durationSec - durationSec) - Math.abs(y.track.durationSec - durationSec))[0];

  const same = candidates.filter((c) => sameVersion(sc.version, c.parsed.version));
  if (same.length > 0) return { kind: "owned", rekordbox: closest(same).track };
  const other = closest(candidates).track;
  return { kind: "other-version", rekordbox: other, note: `You have: ${describe(other)}` };
}
