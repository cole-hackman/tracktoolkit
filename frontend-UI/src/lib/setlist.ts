import type { RekordboxTrack } from "@/lib/rekordbox-xml";
import { artistNames, indexCollection, matchTrack, normalize, parseRekordbox, parseSoundCloud } from "@/lib/library-match";

/**
 * Set → playlist: turn a pasted DJ tracklist into searchable entries, and rank
 * SoundCloud's search results against them.
 *
 * The text comes from the user's own browser. 1001Tracklists answers server
 * fetches with a captcha (checked 2026-11-02), so nothing here or on the
 * server ever requests that site. What a user gets by selecting a 1001TL
 * tracklist and copying it is noisy — per row:
 *
 *   04
 *   12:37
 *   CASSIMM - Love Desire  GOLDEN      ← label glued onto the title
 *   417                                 ← play count
 *   someuser                            ← who ID'd it
 *   (141.7k)
 *   Save 532
 *
 * so the parser keeps only "Artist - Title" lines and drops the rest. A plain
 * one-track-per-line list ("01. Artist - Title [Label]") parses the same way.
 * `e2e/fixtures/setlists/` holds the copied text of two real sets and
 * `e2e/setlist.unit.spec.ts` pins what comes out of them.
 */

export type SetlistEntryKind = "track" | "unidentified" | "url";

export interface SetlistEntry {
  /** 1-based, in set order. */
  position: number;
  kind: SetlistEntryKind;
  artist: string;
  title: string;
  /** "Artist - Title" as the description will print it (or the URL). */
  label: string;
  /** Played over the previous entry ("w/" on 1001Tracklists). */
  withPrevious: boolean;
  /**
   * Capitalised words cut from the end of the title as a record label. The
   * text alone cannot tell "Feel My NRG BANZAI RECS" (title "Feel My NRG")
   * from "Love Desire GOLDEN" (title "Love Desire"), so ranking tries them
   * back on one at a time.
   */
  dropped: string[];
}

export interface ParsedSetlist {
  entries: SetlistEntry[];
  /**
   * Community guesses posted under an ID ("Chris Lake - Attention" under
   * "ID - ID", followed by a [poll:…] line). Not what was played as far as the
   * tracklist knows, so they are reported, never searched.
   */
  suggestions: string[];
}

const SOUNDCLOUD_URL = /^https?:\/\/(?:www\.|m\.)?soundcloud\.com\/[^\s]+$/i;
const DASH = /\s+[-–—]\s+/;
const LEADING_NUMBER = /^(?:\d{1,3}[.)]?\s+)/;
const LEADING_TIME = /^\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/;
const LEADING_WITH = /^w\/\s*/i;
const TRAILING_NOTE = /\s*\[[^\]]*\]\s*$/;
// Words that look like a label in capitals but are part of the record's name.
const VERSION_WORDS = new Set(["VIP", "RMX", "EDIT", "DUB", "REMIX", "MIX", "BOOTLEG", "FLIP", "VERSION", "ID"]);

/** A word in a 1001TL label suffix: no lower-case letters, not bracketed. */
function isLabelWord(word: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(word)) return false;
  if (/\p{Ll}/u.test(word)) return false;
  if (/[()]/.test(word)) return false;
  return !VERSION_WORDS.has(word.replace(/[^\p{L}]/gu, ""));
}

/**
 * Drops the record label 1001Tracklists prints after the title in capitals.
 * When every word is in capitals ("BODY SMASH THE HOUSE"), the first word is
 * the title and the rest is the label; a one-word title ("FELTTTT") is kept.
 */
export function stripLabel(title: string): { title: string; dropped: string[] } {
  const words = title.split(" ");
  let cut = words.length;
  while (cut > 0 && isLabelWord(words[cut - 1])) cut--;
  if (cut === 0) cut = 1;
  return { title: words.slice(0, cut).join(" "), dropped: words.slice(cut) };
}

/** "ID - ID", "Four Tet - ID": the title is not known, so there is nothing to search for. */
function isUnidentified(title: string): boolean {
  return /^(?:id|unknown|\?+)$/i.test(title.trim());
}

export function parseSetlist(text: string): ParsedSetlist {
  const entries: SetlistEntry[] = [];
  const suggestions: string[] = [];
  let pendingWith = false;

  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;

    if (/^w\/$/i.test(line)) {
      pendingWith = true;
      continue;
    }
    if (/^\[poll:/i.test(line)) {
      // The track line just above was a suggestion, not a played track.
      const last = entries[entries.length - 1];
      if (last && last.kind === "track") {
        entries.pop();
        suggestions.push(last.label);
      }
      continue;
    }
    if (SOUNDCLOUD_URL.test(line)) {
      entries.push({ position: 0, kind: "url", artist: "", title: "", label: line, withPrevious: pendingWith, dropped: [] });
      pendingWith = false;
      continue;
    }

    // Only when something "Artist - Title"-shaped is left: "666 - Alarma" is an
    // artist that starts with digits, not track 666.
    for (const prefix of [LEADING_NUMBER, LEADING_TIME]) {
      const stripped = line.replace(prefix, "");
      if (stripped !== line && DASH.test(stripped) && !/^[-–—]/.test(stripped)) line = stripped;
    }
    if (LEADING_WITH.test(line)) {
      pendingWith = true;
      line = line.replace(LEADING_WITH, "");
    }
    const dash = line.match(DASH);
    if (!dash || dash.index === undefined) continue; // counts, IDers, "Save 3", comments

    const artist = line.slice(0, dash.index).trim();
    const { title, dropped } = stripLabel(line.slice(dash.index + dash[0].length).replace(TRAILING_NOTE, "").trim());
    if (!artist || !title) continue;

    const kind: SetlistEntryKind = isUnidentified(title) ? "unidentified" : "track";
    entries.push({ position: 0, kind, artist, title, label: `${artist} - ${title}`, withPrevious: pendingWith, dropped });
    pendingWith = false;
  }

  entries.forEach((entry, i) => {
    entry.position = i + 1;
  });
  return { entries, suggestions };
}

/**
 * What to type into SoundCloud's search for an entry. An unknown remix
 * ("(ID Remix)") is dropped from the query: the words "ID Remix" only steer
 * the search away from the record.
 */
export function searchQuery(entry: Pick<SetlistEntry, "artist" | "title">): string {
  const title = entry.title.replace(/\s*[([](?:id|unknown)\s+(?:remix|edit|mix|rework|bootleg)[)\]]/gi, "");
  return `${entry.artist} ${title}`.replace(/\s+/g, " ").trim();
}

export interface SetlistCandidate {
  id: number;
  title: string;
  user?: { username?: string } | null;
  /** Milliseconds. */
  duration?: number | null;
  /** SoundCloud's access level: "playable", "preview" or "blocked". */
  access?: string | null;
  permalink_url?: string | null;
  artwork_url?: string | null;
}

/** confident: same title, artist and version; possible: same title and artist, other version; weak: anything else. */
export type CandidateFit = "confident" | "possible" | "weak";

export interface RankedCandidate {
  track: SetlistCandidate;
  fit: CandidateFit;
  /** "Artist - Title" for the description, with the title as this candidate matched it. */
  label: string;
}

const FIT_ORDER: Record<CandidateFit, number> = { confident: 0, possible: 1, weak: 2 };

/**
 * Uploads are often on an account named after the artist rather than by it:
 * "cassimmofficial", "armandvanhelden". library-match compares whole names,
 * so it calls those a different artist. A set's tracklist names the artist,
 * so here an uploader whose name, spaces removed, contains one of the
 * artists (four letters or more) counts too — but only with the same core
 * title.
 */
function fitByUploader(track: SetlistCandidate, artist: string, title: string): CandidateFit {
  const uploader = normalize(track.user?.username ?? "").replace(/ /g, "");
  if (!uploader) return "weak";
  const named = artistNames(artist).map((a) => a.replace(/ /g, "")).filter((a) => a.length >= 4);
  if (!named.some((a) => uploader.includes(a))) return "weak";
  const sc = parseSoundCloud(track);
  const record = parseRekordbox(asRecord(artist, title));
  if (!record.core || sc.core !== record.core) return "weak";
  return sc.version === record.version ? "confident" : "possible";
}

const asRecord = (artist: string, title: string): RekordboxTrack => ({
  title,
  artist,
  mix: "",
  remixer: "",
  genre: "",
  label: "",
  durationSec: 0,
  bpm: null,
  key: null,
});

/**
 * Orders search results by how well they fit the entry, and picks one only
 * when it is a confident match that plays in full. A 30-second preview is
 * never picked, nor is a different version: those wait for the user.
 *
 * The comparison is library-match's — the same core-title / artist / version
 * reduction /rekordbox-gaps uses — so "Strobe (Dimension Remix)" never stands
 * in for "Strobe". Each candidate is tried against the title and then the
 * title with the dropped label words put back, one at a time, and keeps its
 * best fit.
 */
export function rankCandidates(
  entry: Pick<SetlistEntry, "artist" | "title" | "dropped">,
  candidates: SetlistCandidate[],
): { ranked: RankedCandidate[]; pick: RankedCandidate | null } {
  const titles = [entry.title];
  for (let i = 1; i <= entry.dropped.length; i++) titles.push([entry.title, ...entry.dropped.slice(0, i)].join(" "));
  const indexes = titles.map((title) => ({ title, index: indexCollection([asRecord(entry.artist, title)]) }));

  const ranked = candidates
    .map((track, order) => {
      let best: { fit: CandidateFit; title: string } = { fit: "weak", title: entry.title };
      for (const { title, index } of indexes) {
        const kind = matchTrack(track, index).kind;
        const fit: CandidateFit =
          kind === "owned" ? "confident" : kind === "other-version" ? "possible" : fitByUploader(track, entry.artist, title);
        if (FIT_ORDER[fit] < FIT_ORDER[best.fit]) best = { fit, title };
      }
      return { track, fit: best.fit, label: `${entry.artist} - ${best.title}`, order };
    })
    // Stable: within a fit, SoundCloud's own relevance order.
    .sort((a, b) => FIT_ORDER[a.fit] - FIT_ORDER[b.fit] || a.order - b.order)
    .map(({ track, fit, label }) => ({ track, fit, label }));

  const pick = ranked.find((c) => c.fit === "confident" && (c.track.access ?? "playable") === "playable") ?? null;
  return { ranked, pick };
}

/** Key for collapsing repeated lines into one search ("Ghosts 'n' Stuff" played twice). */
export function entryKey(entry: Pick<SetlistEntry, "kind" | "label">): string {
  return entry.kind === "url" ? entry.label : normalize(entry.label);
}

/** "peggy-gou-four-tet-head-trip-…-2026-10-10.html" → "Peggy Gou Four Tet Head Trip … 2026-10-10". */
export function titleFromSourceUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!/(^|\.)1001tracklists\.com$/i.test(url.hostname)) return null;
    const slug = url.pathname.split("/").filter(Boolean).pop()?.replace(/\.html$/i, "");
    if (!slug) return null;
    const date = slug.match(/(\d{4}-\d{2}-\d{2})$/)?.[1];
    const words = (date ? slug.slice(0, -date.length) : slug)
      .split("-")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
    const title = [...words, date].filter(Boolean).join(" ");
    return title.slice(0, 100) || null;
  } catch {
    return null;
  }
}
